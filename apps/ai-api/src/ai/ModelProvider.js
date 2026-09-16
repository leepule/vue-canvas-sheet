import { buildDeepSeekMessages } from './prompts.js'

export class AIProviderError extends Error {
  constructor(code, message, retryable = false) {
    super(message)
    this.name = 'AIProviderError'
    this.code = code
    this.retryable = retryable
  }
}

const OUTPUT_KEYS = ['kind', 'operations', 'questions', 'content', 'warnings']

function normalizeBaseUrl(baseUrl) {
  const url = new URL(baseUrl)
  return url.toString().replace(/\/+$/u, '')
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseModelContent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AIProviderError('INVALID_PLAN', 'DeepSeek returned an invalid response body')
  }

  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new AIProviderError('INVALID_PLAN', 'DeepSeek returned no model content')
  }

  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new AIProviderError('INVALID_PLAN', 'DeepSeek returned invalid JSON')
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AIProviderError('INVALID_PLAN', 'DeepSeek must return a JSON object')
  }

  for (const key of Object.keys(parsed)) {
    if (!OUTPUT_KEYS.includes(key)) {
      throw new AIProviderError('INVALID_PLAN', `DeepSeek output does not allow field ${key}`)
    }
  }

  if (parsed.kind === 'requires_input') {
    return {
      kind: 'requires_input',
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
    }
  }

  if (parsed.kind === 'answer') {
    return {
      kind: 'answer',
      content: typeof parsed.content === 'string' ? parsed.content : '',
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
    }
  }

  return {
    kind: 'plan',
    operations: Array.isArray(parsed.operations) ? parsed.operations : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
  }
}

async function readModelResponse(response, maxResponseBytes) {
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
    throw new AIProviderError('LIMIT_EXCEEDED', 'The DeepSeek response exceeds the size limit', true)
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new AIProviderError('INVALID_PLAN', 'DeepSeek returned an invalid HTTP response body')
  }
}

function httpProviderError(status, message) {
  if (status === 429 || status === 408 || status >= 500) {
    return new AIProviderError(
      status === 429 ? 'LIMIT_EXCEEDED' : 'AI_TIMEOUT',
      `DeepSeek request failed with status ${status}: ${message}`,
      true
    )
  }

  return new AIProviderError(
    'INVALID_PLAN',
    `DeepSeek request failed with status ${status}: ${message}`,
    false
  )
}

export class ModelProvider {
  constructor({
    apiKey,
    baseUrl = 'https://api.deepseek.com',
    model = 'deepseek-chat',
    timeoutMs = 30_000,
    maxResponseBytes = 512 * 1024,
    maxRepairAttempts = 1,
    maxTokens = 1024,
    maxRequests = 1000,
    fetch = globalThis.fetch
  } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new TypeError('ModelProvider requires a DeepSeek API key')
    }
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
      throw new TypeError('ModelProvider requires a base URL')
    }
    if (typeof model !== 'string' || !model.trim()) {
      throw new TypeError('ModelProvider requires a model name')
    }
    if (typeof fetch !== 'function') {
      throw new TypeError('ModelProvider requires a fetch implementation')
    }

    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.model = model
    this.apiKey = apiKey
    this.timeoutMs = positiveInteger(timeoutMs, 30_000)
    this.maxResponseBytes = positiveInteger(maxResponseBytes, 512 * 1024)
    this.maxRepairAttempts = Math.max(0, Number.parseInt(maxRepairAttempts, 10) || 0)
    this.maxTokens = positiveInteger(maxTokens, 1024)
    this.maxRequests = positiveInteger(maxRequests, 1000)
    this.requestCount = 0
    this.fetch = fetch
  }

  async #request(messages, signal) {
    if (this.requestCount >= this.maxRequests) {
      throw new AIProviderError('LIMIT_EXCEEDED', 'The DeepSeek request limit was reached', true)
    }
    this.requestCount++

    const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        response_format: { type: 'json_object' },
        max_tokens: this.maxTokens,
        temperature: 0,
        stream: false
      }),
      signal
    })

    if (!response.ok) {
      const payload = await readModelResponse(response, this.maxResponseBytes).catch(() => null)
      const message = payload?.error?.message || payload?.message || response.statusText || 'unknown error'
      throw httpProviderError(response.status, message)
    }

    return readModelResponse(response, this.maxResponseBytes)
  }

  async generatePlan({ prompt, context, envelope, signal, onProgress } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new AIProviderError('INVALID_PLAN', 'DeepSeek provider requires a non-empty prompt')
    }

    if (signal?.aborted) {
      throw new AIProviderError('AI_CANCELLED', 'The DeepSeek request was cancelled')
    }

    const controller = new AbortController()
    const timeoutError = new AIProviderError('AI_TIMEOUT', 'The DeepSeek request timed out', true)
    const timer = setTimeout(() => controller.abort(timeoutError), this.timeoutMs)
    const abortDeepSeek = () => {
      controller.abort(new AIProviderError('AI_CANCELLED', 'The DeepSeek request was cancelled'))
    }

    signal?.addEventListener('abort', abortDeepSeek, { once: true })

    try {
      onProgress?.({ stage: 'generating', provider: 'deepseek' })

      let messages = buildDeepSeekMessages({ prompt, context, envelope })
      let calls = 0

      while (true) {
        calls++
        const payload = await this.#request(messages, controller.signal)
        try {
          return parseModelContent(payload)
        } catch (error) {
          if (calls > this.maxRepairAttempts || error.code !== 'INVALID_PLAN') throw error
          messages = [
            ...messages,
            {
              role: 'assistant',
              content: JSON.stringify({ error: 'The previous response did not match the JSON contract.' })
            },
            {
              role: 'user',
              content: 'Return only the required JSON object. Do not add explanations, Markdown, or envelope fields.'
            }
          ]
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new AIProviderError('AI_CANCELLED', 'The DeepSeek request was cancelled')
      }
      if (error === timeoutError || error?.name === 'TimeoutError') {
        throw timeoutError
      }
      if (error?.name === 'AbortError') {
        throw new AIProviderError('AI_CANCELLED', 'The DeepSeek request was cancelled')
      }
      if (error instanceof AIProviderError) throw error
      if (error instanceof TypeError) {
        throw new AIProviderError('AI_TIMEOUT', 'Unable to reach the DeepSeek API', true)
      }
      throw new AIProviderError('AI_TIMEOUT', 'The DeepSeek provider failed', true)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortDeepSeek)
    }
  }
}
