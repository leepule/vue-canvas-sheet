import { describe, expect, it, vi } from 'vitest'
import { ModelProvider, AIProviderError } from '../src/ai/ModelProvider.js'
import { createProvider } from '../src/ai/provider.js'

const planOutput = {
  kind: 'plan',
  operations: [
    {
      type: 'fill_formula',
      seedCell: { r: 1, c: 2 },
      seedFormula: '=A2*B2',
      targetRange: {
        s: { r: 1, c: 2 },
        e: { r: 3, c: 2 }
      }
    }
  ],
  warnings: []
}

const input = {
  prompt: '根据单价和数量生成销售额列',
  context: {
    sample: [
      ['单价', '数量', '销售额'],
      [10, 2, null]
    ]
  },
  envelope: {
    schemaVersion: 1,
    runId: 'run-123',
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
  }
}

function modelResponse(content, status = 200) {
  return new Response(JSON.stringify({
    choices: [
      { message: { content } }
    ]
  }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function createProviderWithFetch(handler, options = {}) {
  const fetch = vi.fn(handler)
  const provider = new ModelProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.test',
    model: 'deepseek-chat',
    fetch,
    ...options
  })
  return { provider, fetch }
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the promise to reject')
}

describe('ModelProvider', () => {
  it('sends a DeepSeek JSON-mode request and returns the operation payload', async () => {
    const { provider, fetch } = createProviderWithFetch(() =>
      modelResponse(JSON.stringify(planOutput))
    )

    const result = await provider.generatePlan(input)

    expect(result).toEqual(planOutput)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('https://api.deepseek.test/chat/completions')
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer test-key')
    expect(fetch.mock.calls[0][1].headers['content-type']).toBe('application/json')

    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.model).toBe('deepseek-chat')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.max_tokens).toBe(1024)
    expect(body.temperature).toBe(0)
    expect(body.stream).toBe(false)

    const userMessage = JSON.parse(body.messages.at(-1).content)
    expect(userMessage.request).toBe(input.prompt)
    expect(userMessage.spreadsheetSample).toEqual(input.context.sample)
    expect(userMessage.authorization.allowedWriteRanges).toEqual(input.envelope.allowedWriteRanges)
    expect(fetch.mock.calls[0][1].body).not.toContain('run-123')
    expect(fetch.mock.calls[0][1].body).not.toContain('doc-123')
  })

  it('returns a requires_input payload', async () => {
    const output = {
      kind: 'requires_input',
      questions: ['请确认销售额公式是否为单价乘以数量。'],
      warnings: []
    }
    const { provider } = createProviderWithFetch(() =>
      modelResponse(JSON.stringify(output))
    )

    await expect(provider.generatePlan(input)).resolves.toEqual(output)
  })

  it('returns a direct answer for generated mock data', async () => {
    const output = {
      kind: 'answer',
      content: '| 单价 | 数量 |\n| --- | --- |\n| 45.50 | 12 |',
      warnings: []
    }
    const { provider } = createProviderWithFetch(() =>
      modelResponse(JSON.stringify(output))
    )

    await expect(provider.generatePlan({
      ...input,
      prompt: '生成100条mock数据 单价和数量列'
    })).resolves.toEqual(output)
  })

  it('rejects invalid model JSON', async () => {
    const { provider } = createProviderWithFetch(() => modelResponse('{"kind":'), {
      maxRepairAttempts: 0
    })
    const error = await rejection(provider.generatePlan(input))

    expect(error).toBeInstanceOf(AIProviderError)
    expect(error.code).toBe('INVALID_PLAN')
    expect(error.retryable).toBe(false)
  })

  it('performs at most one format repair request', async () => {
    let calls = 0
    const { provider, fetch } = createProviderWithFetch(() => {
      calls++
      if (calls === 1) return modelResponse('not-json')
      return modelResponse(JSON.stringify(planOutput))
    })

    await expect(provider.generatePlan(input)).resolves.toEqual(planOutput)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetch.mock.calls[1][1].body).messages.at(-1).content)
      .toContain('Return only the required JSON object')
  })

  it('maps HTTP 429 to a retryable limit error', async () => {
    const { provider } = createProviderWithFetch(() => new Response(
      JSON.stringify({ error: { message: 'rate limited' } }),
      { status: 429, headers: { 'content-type': 'application/json' } }
    ))
    const error = await rejection(provider.generatePlan(input))

    expect(error.code).toBe('LIMIT_EXCEEDED')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('rate limited')
  })

  it('does not call DeepSeek when the run is already cancelled', async () => {
    const { provider, fetch } = createProviderWithFetch(() => modelResponse('{}'))
    const controller = new AbortController()
    controller.abort()

    const error = await rejection(provider.generatePlan({
      ...input,
      signal: controller.signal
    }))

    expect(error.code).toBe('AI_CANCELLED')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps a timeout to a retryable provider error', async () => {
    const { provider } = createProviderWithFetch((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason))
    }), {
      timeoutMs: 5
    })
    const error = await rejection(provider.generatePlan(input))

    expect(error.code).toBe('AI_TIMEOUT')
    expect(error.retryable).toBe(true)
  })

  it('rejects provider attempts to return trusted envelope fields', async () => {
    const { provider } = createProviderWithFetch(() =>
      modelResponse(JSON.stringify({ ...planOutput, runId: 'forged-run' }))
    , {
      maxRepairAttempts: 0
    })
    const error = await rejection(provider.generatePlan(input))

    expect(error.code).toBe('INVALID_PLAN')
    expect(error.message).toContain('runId')
  })

  it('stops calling DeepSeek after the process-level request limit', async () => {
    const { provider, fetch } = createProviderWithFetch(() =>
      modelResponse(JSON.stringify(planOutput))
    , {
      maxRequests: 1
    })

    await provider.generatePlan(input)
    const error = await rejection(provider.generatePlan(input))

    expect(error.code).toBe('LIMIT_EXCEEDED')
    expect(error.retryable).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('createProvider', () => {
  it('creates DeepSeek by default when a key is configured', () => {
    const fetch = vi.fn()
    const provider = createProvider({
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.test/',
      DEEPSEEK_MODEL: 'deepseek-chat',
      DEEPSEEK_MAX_TOKENS: '256',
      AI_REQUEST_TIMEOUT_MS: '123'
    }, { fetch })

    expect(provider).toBeInstanceOf(ModelProvider)
    expect(provider.baseUrl).toBe('https://api.deepseek.test')
    expect(provider.model).toBe('deepseek-chat')
    expect(provider.timeoutMs).toBe(123)
    expect(provider.maxTokens).toBe(256)
    expect(provider.fetch).toBe(fetch)
  })

  it('requires a key for DeepSeek', () => {
    expect(() => createProvider({}))
      .toThrow('DEEPSEEK_API_KEY is required')
  })

  it('always creates the DeepSeek provider and ignores provider switches', () => {
    const provider = createProvider({
      DEEPSEEK_API_KEY: 'test-key'
    })

    expect(provider).toBeInstanceOf(ModelProvider)
  })
})
