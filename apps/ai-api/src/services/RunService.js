import {
  AIResponseSchema,
  AIContractError,
  AI_ERROR_CODES,
  AI_CONTRACT_LIMITS,
  RequestEnvelopeSchema,
  RequestIdSchema,
  validatePlanAuthorization
} from '@ai-sheet/contracts'

const TERMINAL_STATUSES = new Set(['plan_ready', 'answer_ready', 'requires_input', 'failed', 'cancelled'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value, keys, path) {
  if (!isPlainObject(value)) {
    throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, `${path} must be an object`)
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, `${path} does not allow field ${key}`)
    }
  }
}

function validatePrimitive(value, path) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return
  throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, `${path} must be a primitive value`)
}

function validateContext(context) {
  if (context === undefined) return null
  hasOnlyKeys(context, ['sample', 'history'], 'context')

  const result = {}

  if (context.history !== undefined) {
    if (!Array.isArray(context.history)) {
      throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, 'context.history must be an array')
    }
    result.history = context.history.slice(-10).map((item, index) => {
      if (!isPlainObject(item) || typeof item.role !== 'string' || typeof item.content !== 'string') {
        throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, `context.history[${index}] must be a message object`)
      }
      return { role: item.role, content: item.content }
    })
  }

  if (context.sample !== undefined) {
    if (!Array.isArray(context.sample) || context.sample.length > 5) {
      throw new AIContractError(AI_ERROR_CODES.LIMIT_EXCEEDED, 'context.sample must contain at most 5 rows')
    }

    for (const [rowIndex, row] of context.sample.entries()) {
      if (!Array.isArray(row) || row.length > 20) {
        throw new AIContractError(AI_ERROR_CODES.LIMIT_EXCEEDED, 'Each sample row must contain at most 20 cells')
      }
      row.forEach((cell, columnIndex) => {
        validatePrimitive(cell, `context.sample[${rowIndex}][${columnIndex}]`)
      })
    }
    result.sample = context.sample
  }

  return result
}

export class RunService {
  constructor({
    provider,
    maxTasks = 100,
    taskTtlMs = 10 * 60 * 1000,
    now = () => Date.now(),
    createRunId = () => `run-${crypto.randomUUID()}`
  } = {}) {
    if (!provider || typeof provider.generatePlan !== 'function') {
      throw new TypeError('RunService requires a provider with generatePlan()')
    }
    if (!Number.isInteger(maxTasks) || maxTasks <= 0) {
      throw new TypeError('maxTasks must be a positive integer')
    }
    if (!Number.isFinite(taskTtlMs) || taskTtlMs <= 0) {
      throw new TypeError('taskTtlMs must be a positive number')
    }

    this.provider = provider
    this.maxTasks = maxTasks
    this.taskTtlMs = taskTtlMs
    this.now = now
    this.createRunId = createRunId
    this.tasks = new Map()
    this.idempotencyKeys = new Map()
  }

  _cleanupExpiredTasks() {
    const timestamp = this.now()
    for (const task of this.tasks.values()) {
      if (task.expiresAt > timestamp) continue
      if (!TERMINAL_STATUSES.has(task.status)) task.controller.abort()
      this.tasks.delete(task.runId)
      this.idempotencyKeys.delete(task.idempotencyKeyScoped)
    }
  }

  _validateCreateInput(input) {
    hasOnlyKeys(input, ['schemaVersion', 'requestId', 'prompt', 'context', 'envelope'], 'request')
    if (input.schemaVersion !== 1) {
      throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, 'Unsupported request schemaVersion')
    }
    if (!RequestIdSchema.safeParse(input.requestId).success) {
      throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, 'requestId is invalid')
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim() ||
        input.prompt.length > AI_CONTRACT_LIMITS.maxTextLength) {
      throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, 'prompt must be non-blank text')
    }

    const context = validateContext(input.context)
    hasOnlyKeys(input.envelope, [
      'schemaVersion',
      'documentId',
      'documentEpoch',
      'sheetId',
      'baseContentRevision',
      'allowedReadRanges',
      'allowedWriteRanges'
    ], 'request.envelope')

    return {
      schemaVersion: input.schemaVersion,
      requestId: input.requestId,
      prompt: input.prompt,
      context,
      envelopeBase: input.envelope
    }
  }

  _appendEvent(task, event) {
    task.events.push({ ...event, eventId: task.nextEventId++ })
    task.updatedAt = this.now()
  }

  async _start(task) {
    try {
      const providerResult = await this.provider.generatePlan({
        prompt: task.request.prompt,
        context: task.request.context,
        envelope: task.envelope,
        signal: task.controller.signal
      })

      if (task.status === 'cancelled') return
      if (!isPlainObject(providerResult)) {
        throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, 'The provider returned invalid JSON')
      }
      hasOnlyKeys(providerResult, ['kind', 'operations', 'questions', 'content', 'warnings'], 'provider result')

      const responseCandidate = {
        warnings: [],
        ...task.envelope,
        ...providerResult
      }
      const parsed = AIResponseSchema.safeParse(responseCandidate)
      if (!parsed.success) {
        throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, 'The provider response is invalid')
      }
      const response = validatePlanAuthorization(parsed.data, task.envelope)

      task.result = response
      task.status = response.kind === 'plan'
        ? 'plan_ready'
        : response.kind === 'answer' ? 'answer_ready' : 'requires_input'
      this._appendEvent(task, {
        schemaVersion: 1,
        type: response.kind === 'plan'
          ? 'plan_ready'
          : response.kind === 'answer' ? 'answer_ready' : 'requires_input',
        runId: task.runId,
        result: response
      })
    } catch (error) {
      if (task.status === 'cancelled') return

      task.status = 'failed'
      task.error = {
        code: error instanceof AIContractError ? error.code : error.code || AI_ERROR_CODES.AI_TIMEOUT,
        message: error instanceof AIContractError || error.name === 'AIProviderError'
          ? error.message
          : 'The AI provider failed',
        retryable: error.retryable === true,
        requestId: task.request.requestId
      }
      this._appendEvent(task, {
        schemaVersion: 1,
        type: 'error',
        runId: task.runId,
        error: task.error
      })
    } finally {
      task.updatedAt = this.now()
    }
  }

  createRun({ idempotencyKey, ownerSession, request }) {
    this._cleanupExpiredTasks()

    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, 'Idempotency-Key must contain 8 to 128 characters')
    }
    if (typeof ownerSession !== 'string' || !ownerSession) {
      throw new AIContractError(AI_ERROR_CODES.OUT_OF_SCOPE, 'A valid development session is required')
    }

    const validatedRequest = this._validateCreateInput(request)
    const scopedIdempotencyKey = `${ownerSession}:${idempotencyKey}`
    const existing = this.idempotencyKeys.get(scopedIdempotencyKey)
    if (existing) {
      const existingSignature = JSON.stringify(existing.request)
      const requestSignature = JSON.stringify(validatedRequest)
      if (existingSignature !== requestSignature) {
        throw new AIContractError(AI_ERROR_CODES.VERSION_CONFLICT, 'The idempotency key was used with a different request')
      }
      return this.serializeTask(existing)
    }

    if (this.tasks.size >= this.maxTasks) {
      throw new AIContractError(AI_ERROR_CODES.LIMIT_EXCEEDED, 'The in-memory task limit was reached')
    }

    const runId = this.createRunId()
    const envelopeResult = RequestEnvelopeSchema.safeParse({
      ...validatedRequest.envelopeBase,
      schemaVersion: 1,
      runId
    })
    if (!envelopeResult.success) {
      throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, 'The request envelope is invalid')
    }

    const timestamp = this.now()
    const task = {
      runId,
      ownerSession,
      idempotencyKeyScoped: scopedIdempotencyKey,
      request: validatedRequest,
      envelope: envelopeResult.data,
      status: 'queued',
      result: null,
      error: null,
      events: [],
      nextEventId: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + this.taskTtlMs,
      controller: new AbortController()
    }

    this.tasks.set(runId, task)
    this.idempotencyKeys.set(scopedIdempotencyKey, task)
    this._appendEvent(task, {
      schemaVersion: 1,
      type: 'status',
      runId,
      status: 'queued'
    })
    task.status = 'generating'
    this._appendEvent(task, {
      schemaVersion: 1,
      type: 'status',
      runId,
      status: 'generating'
    })
    void this._start(task)

    return this.serializeTask(task)
  }

  _getOwnedTask(runId, ownerSession) {
    this._cleanupExpiredTasks()
    const task = this.tasks.get(runId)
    if (!task || task.ownerSession !== ownerSession) return null
    return task
  }

  getRun(runId, ownerSession) {
    const task = this._getOwnedTask(runId, ownerSession)
    return task ? this.serializeTask(task) : null
  }

  getEvents(runId, ownerSession, afterEventId = 0) {
    const task = this._getOwnedTask(runId, ownerSession)
    if (!task) return null
    return {
      status: task.status,
      terminal: TERMINAL_STATUSES.has(task.status),
      events: task.events.filter(event => event.eventId > afterEventId)
    }
  }

  cancelRun(runId, ownerSession) {
    const task = this._getOwnedTask(runId, ownerSession)
    if (!task) return null

    if (!TERMINAL_STATUSES.has(task.status)) {
      task.status = 'cancelled'
      task.controller.abort()
      this._appendEvent(task, {
        schemaVersion: 1,
        type: 'status',
        runId,
        status: 'cancelled'
      })
    }

    return this.serializeTask(task)
  }

  serializeTask(task) {
    return {
      runId: task.runId,
      status: task.status,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      expiresAt: task.expiresAt
    }
  }

  async close() {
    for (const task of this.tasks.values()) {
      if (!TERMINAL_STATUSES.has(task.status)) task.controller.abort()
    }
  }
}
