import Fastify from 'fastify'
import {
  AIContractError,
  AI_ERROR_CODES,
  RequestIdSchema
} from '@ai-sheet/contracts'
import { RunService } from './services/RunService.js'
import { registerAIRuns } from './routes/aiRuns.js'

const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:8890',
  'http://localhost:8890'
]

const HTTP_STATUS_BY_ERROR_CODE = new Map([
  [AI_ERROR_CODES.INVALID_PLAN, 400],
  [AI_ERROR_CODES.UNSUPPORTED_FORMULA, 400],
  [AI_ERROR_CODES.OUT_OF_SCOPE, 403],
  [AI_ERROR_CODES.READ_ONLY, 403],
  [AI_ERROR_CODES.STALE_PREVIEW, 409],
  [AI_ERROR_CODES.VERSION_CONFLICT, 409],
  [AI_ERROR_CODES.LIMIT_EXCEEDED, 429],
  [AI_ERROR_CODES.AI_TIMEOUT, 504]
])

function requestIdFrom(body, fallback) {
  return RequestIdSchema.safeParse(body?.requestId).success ? body.requestId : fallback
}

export function buildApp({
  provider,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  devSessionToken = 'dev-local',
  bodyLimit = 32 * 1024,
  maxTasks = 100,
  taskTtlMs = 10 * 60 * 1000,
  now = () => Date.now(),
  logger = false
} = {}) {
  const allowedOriginSet = new Set(allowedOrigins)
  const devSessionSet = new Set(Array.isArray(devSessionToken) ? devSessionToken : [devSessionToken])
  const app = Fastify({
    logger,
    bodyLimit
  })

  app.runService = new RunService({
    provider,
    maxTasks,
    taskTtlMs,
    now
  })

  app.addHook('onSend', async (request, reply) => {
    const origin = request.headers.origin
    if (origin && allowedOriginSet.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Vary', 'Origin')
    }
  })

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: AI_ERROR_CODES.INVALID_PLAN,
        message: 'Not found',
        retryable: false,
        requestId: requestIdFrom(request.body, request.id)
      }
    })
  })

  app.setErrorHandler((error, request, reply) => {
    const bodyTooLarge = [
      'FST_ERR_CTP_BODY_TOO_LARGE',
      'FST_ERR_CTP_INVALID_JSON_LENGTH'
    ].includes(error.code)
    let code
    if (bodyTooLarge) {
      code = AI_ERROR_CODES.LIMIT_EXCEEDED
    } else if (error instanceof AIContractError) {
      code = error.code
    } else if (typeof error.code === 'string' && error.code.startsWith('FST_ERR_CTP_')) {
      code = AI_ERROR_CODES.INVALID_PLAN
    } else if (HTTP_STATUS_BY_ERROR_CODE.has(error.code)) {
      code = error.code
    } else {
      code = AI_ERROR_CODES.AI_TIMEOUT
    }
    const status = bodyTooLarge ? 413 : HTTP_STATUS_BY_ERROR_CODE.get(code) ?? 500

    reply.status(status).send({
      error: {
        code,
        message: status === 500 ? 'Internal server error' : error.message,
        retryable: code === AI_ERROR_CODES.LIMIT_EXCEEDED || error.retryable === true,
        requestId: requestIdFrom(request.body, request.id)
      }
    })
  })

  const rejectInvalidRequest = (request, reply, status, code, message) => {
    reply.status(status).send({
      error: {
        code,
        message,
        retryable: false,
        requestId: requestIdFrom(request.body, request.id)
      }
    })
  }

  const requireAllowedOrigin = (request, reply) => {
    const origin = request.headers.origin
    if (typeof origin !== 'string' || !allowedOriginSet.has(origin)) {
      rejectInvalidRequest(request, reply, 403, AI_ERROR_CODES.OUT_OF_SCOPE, 'Origin is not allowed')
      return false
    }
    return true
  }

  const requireDevSession = (request, reply) => {
    if (!devSessionSet.has(request.headers['x-dev-session'])) {
      rejectInvalidRequest(request, reply, 401, AI_ERROR_CODES.OUT_OF_SCOPE, 'A valid development session is required')
      return false
    }
    return true
  }

  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS') return
    if (!requireAllowedOrigin(request, reply)) return
    if (!requireDevSession(request, reply)) return
  })

  app.options('/api/*', async (_request, reply) => {
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-Dev-Session, Last-Event-ID')
    return reply.status(204).send()
  })

  registerAIRuns(app)

  app.addHook('onClose', async () => {
    await app.runService.close()
  })

  return app
}
