import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { AIProviderError, ModelProvider } from '../src/ai/ModelProvider.js'

const headers = {
  origin: 'http://127.0.0.1:8890',
  'x-dev-session': 'dev-local',
  'idempotency-key': 'test-key-001'
}

const expectedOperation = {
  type: 'fill_formula',
  seedCell: { r: 1, c: 2 },
  seedFormula: '=A2*B2',
  targetRange: {
    s: { r: 1, c: 2 },
    e: { r: 3, c: 2 }
  }
}

const planOutput = {
  kind: 'plan',
  operations: [structuredClone(expectedOperation)],
  warnings: []
}

const outOfScopeOutput = {
  kind: 'plan',
  operations: [
    {
      type: 'fill_formula',
      seedCell: { r: 1, c: 3 },
      seedFormula: '=A2*B2',
      targetRange: {
        s: { r: 1, c: 3 },
        e: { r: 3, c: 3 }
      }
    }
  ],
  warnings: []
}

const apps = []

function modelResponse(content) {
  return new Response(JSON.stringify({
    choices: [
      { message: { content } }
    ]
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function createDeepSeekFetch({ scenario = 'plan', delayMs = 0 } = {}) {
  return vi.fn((_url, options = {}) => {
    const respond = () => {
      if (scenario === 'fail') {
        return Promise.reject(new AIProviderError('AI_TIMEOUT', 'DeepSeek failed', true))
      }

      if (scenario === 'bad_json') return modelResponse('{"kind":')
      if (scenario === 'out_of_scope') return modelResponse(JSON.stringify(outOfScopeOutput))
      return modelResponse(JSON.stringify(planOutput))
    }

    if (!delayMs) return respond()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        options.signal?.removeEventListener('abort', onAbort)
        resolve(respond())
      }, delayMs)

      function onAbort() {
        clearTimeout(timer)
        reject(options.signal?.reason || new Error('Aborted'))
      }

      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  })
}

function createApp(options = {}) {
  const fetch = options.fetch || createDeepSeekFetch({
    scenario: options.scenario || 'plan',
    delayMs: options.scenario === 'cancel' ? 60_000 : options.delayMs || 0
  })
  const provider = new ModelProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.test',
    fetch,
    maxRepairAttempts: options.scenario === 'bad_json' ? 0 : 1
  })
  const app = buildApp({
    provider,
    maxTasks: options.maxTasks,
    taskTtlMs: options.taskTtlMs,
    now: options.now,
    devSessionToken: options.devSessionToken,
    bodyLimit: options.bodyLimit
  })
  apps.push(app)
  return { app, fetch }
}

function requestPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    prompt: '根据单价和数量生成销售额列',
    context: {
      sample: [
        ['单价', '数量', '销售额'],
        [10, 2, null],
        [5, 3, null]
      ]
    },
    envelope: {
      schemaVersion: 1,
      documentId: 'doc-123',
      documentEpoch: 'epoch-123',
      sheetId: 'sheet-1',
      baseContentRevision: 17,
      allowedReadRanges: [
        { s: { r: 0, c: 0 }, e: { r: 3, c: 1 } }
      ],
      allowedWriteRanges: [
        { s: { r: 1, c: 2 }, e: { r: 3, c: 2 } }
      ]
    },
    ...overrides
  }
}

function createRun(app, payload, requestHeaders = headers) {
  return app.inject({
    method: 'POST',
    url: '/api/ai/runs',
    headers: requestHeaders,
    payload
  })
}

function getRun(app, runId, requestHeaders = headers) {
  return app.inject({
    method: 'GET',
    url: `/api/ai/runs/${runId}`,
    headers: requestHeaders
  })
}

async function waitForTerminal(app, runId, requestHeaders = headers) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await getRun(app, runId, requestHeaders)
    const task = response.json()
    if (['plan_ready', 'answer_ready', 'requires_input', 'failed', 'cancelled'].includes(task.status)) {
      return task
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`AI run ${runId} did not reach a terminal status`)
}

afterEach(async () => {
  await Promise.all(apps.map(app => app.close()))
  apps.length = 0
})

describe('AI runs API', () => {
  it('returns the deterministic order formula plan', async () => {
    const { app } = createApp()

    const created = await createRun(app, requestPayload())
    expect(created.statusCode).toBe(202)
    const task = created.json()
    expect(task.status).toBe('generating')

    const terminal = await waitForTerminal(app, task.runId)
    expect(terminal.status).toBe('plan_ready')
    expect(terminal.result.operations).toEqual([expectedOperation])
  })

  it('returns generated mock data as a direct answer', async () => {
    const { app, fetch } = createApp()
    fetch.mockImplementation(() => modelResponse(JSON.stringify({
      kind: 'answer',
      content: '| 单价 | 数量 |\n| --- | --- |\n| 45.50 | 12 |',
      warnings: []
    })))
    const created = await createRun(app, requestPayload({
      prompt: '生成100条mock数据 单价和数量列'
    }))
    const terminal = await waitForTerminal(app, created.json().runId)

    expect(terminal.status).toBe('answer_ready')
    expect(terminal.result.content).toContain('45.50')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reuses a run for the same idempotency key and request', async () => {
    const { app, fetch } = createApp({ delayMs: 50 })
    const payload = requestPayload()

    const first = await createRun(app, payload)
    const second = await createRun(app, payload)

    expect(second.statusCode).toBe(202)
    expect(second.json().runId).toBe(first.json().runId)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await waitForTerminal(app, first.json().runId)).status).toBe('plan_ready')
  })

  it('rejects an idempotency key used with a different request', async () => {
    const { app, fetch } = createApp({ delayMs: 50 })

    await createRun(app, requestPayload())
    const conflict = await createRun(app, requestPayload({
      prompt: '生成另一个结果'
    }))

    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({
      error: {
        code: 'VERSION_CONFLICT',
        retryable: false
      }
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['bad_json', 'INVALID_PLAN'],
    ['out_of_scope', 'OUT_OF_SCOPE'],
    ['fail', 'AI_TIMEOUT']
  ])('reports the %s provider failure as %s', async (scenario, expectedCode) => {
    const { app } = createApp({ scenario })
    const created = await createRun(app, requestPayload())
    const terminal = await waitForTerminal(app, created.json().runId)

    expect(terminal.status).toBe('failed')
    expect(terminal.error.code).toBe(expectedCode)
    expect(terminal.error.retryable).toBe(scenario === 'fail')
  })

  it('cancels an active run and keeps it cancelled', async () => {
    const { app, fetch } = createApp({ scenario: 'cancel' })
    const created = await createRun(app, requestPayload())
    const runId = created.json().runId

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/ai/runs/${runId}/cancel`,
      headers
    })
    const cancelledAgain = await app.inject({
      method: 'POST',
      url: `/api/ai/runs/${runId}/cancel`,
      headers
    })

    expect(cancelled.json().status).toBe('cancelled')
    expect(cancelledAgain.statusCode).toBe(200)
    expect(cancelledAgain.json().status).toBe('cancelled')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not change a completed run when cancel arrives late', async () => {
    const { app } = createApp()
    const created = await createRun(app, requestPayload())
    const runId = created.json().runId
    await waitForTerminal(app, runId)

    const response = await app.inject({
      method: 'POST',
      url: `/api/ai/runs/${runId}/cancel`,
      headers
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('plan_ready')
  })

  it('streams all events for a terminal run', async () => {
    const { app, fetch } = createApp()
    const created = await createRun(app, requestPayload())
    const runId = created.json().runId
    await waitForTerminal(app, runId)

    const response = await app.inject({
      method: 'GET',
      url: `/api/ai/runs/${runId}/events`,
      headers
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    const events = response.body
      .trim()
      .split('\n\n')
      .map(chunk => JSON.parse(chunk.split('\n')[1].slice(5)))
    expect(events.map(event => event.type)).toEqual(['status', 'status', 'plan_ready'])
    expect(events.at(-1).result.operations).toEqual([expectedOperation])
    expect(response.headers['access-control-allow-origin']).toBe(headers.origin)

    const replay = await app.inject({
      method: 'GET',
      url: `/api/ai/runs/${runId}/events`,
      headers
    })
    expect(replay.statusCode).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('requires an allowed origin and a valid development session', async () => {
    const { app } = createApp()

    const wrongOrigin = await createRun(app, requestPayload(), {
      ...headers,
      origin: 'http://example.com'
    })
    const missingSession = await createRun(app, requestPayload(), {
      ...headers,
      'x-dev-session': ''
    })

    expect(wrongOrigin.statusCode).toBe(403)
    expect(wrongOrigin.json().error.code).toBe('OUT_OF_SCOPE')
    expect(missingSession.statusCode).toBe(401)
    expect(missingSession.json().error.code).toBe('OUT_OF_SCOPE')
  })

  it('does not expose one development session run to another', async () => {
    const { app } = createApp({
      scenario: 'cancel',
      devSessionToken: ['session-a', 'session-b']
    })
    const sessionAHeaders = {
      ...headers,
      'x-dev-session': 'session-a',
      'idempotency-key': 'session-key-001'
    }
    const sessionBHeaders = {
      ...headers,
      'x-dev-session': 'session-b',
      'idempotency-key': 'session-key-002'
    }
    const created = await createRun(app, requestPayload(), sessionAHeaders)

    const response = await getRun(app, created.json().runId, sessionBHeaders)

    expect(response.statusCode).toBe(404)
  })

  it('removes a run after its TTL expires', async () => {
    let clock = 1000
    const { app } = createApp({
      taskTtlMs: 1000,
      now: () => clock
    })
    const created = await createRun(app, requestPayload())

    clock = 3000
    const response = await getRun(app, created.json().runId)

    expect(response.statusCode).toBe(404)
  })

  it('rejects new runs when the in-memory task limit is reached', async () => {
    const { app } = createApp({
      delayMs: 1000,
      maxTasks: 1
    })

    await createRun(app, requestPayload())
    const response = await createRun(app, requestPayload({
      requestId: 'request-2'
    }), {
      ...headers,
      'idempotency-key': 'test-key-002'
    })

    expect(response.statusCode).toBe(429)
    expect(response.json()).toMatchObject({
      error: {
        code: 'LIMIT_EXCEEDED',
        retryable: true
      }
    })
  })

  it('rejects an oversized request body', async () => {
    const { app } = createApp({ bodyLimit: 1024 })

    const response = await createRun(app, requestPayload({
      prompt: 'x'.repeat(2048)
    }))

    expect(response.statusCode).toBe(413)
    expect(response.json().error.code).toBe('LIMIT_EXCEEDED')
    expect(response.json().error.retryable).toBe(true)
  })

  it('requires an idempotency key', async () => {
    const { app } = createApp()

    const response = await createRun(app, requestPayload(), {
      ...headers,
      'idempotency-key': ''
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('INVALID_PLAN')
  })
})
