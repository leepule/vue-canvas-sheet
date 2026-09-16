export class AIClientError extends Error {
  constructor(code, message, { status = 0, retryable = false } = {}) {
    super(message)
    this.name = 'AIClientError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

function parseSseChunk(chunk) {
  const lines = chunk.split(/\r?\n/)
  const eventIdLine = lines.find(line => line.startsWith('id:'))
  const data = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null

  let event
  try {
    event = JSON.parse(data)
  } catch {
    throw new AIClientError('INVALID_PLAN', 'AI event stream returned invalid JSON')
  }
  if (eventIdLine) {
    const eventId = Number.parseInt(eventIdLine.slice(3).trim(), 10)
    if (Number.isInteger(eventId)) event.eventId = eventId
  }
  return event
}

export class AIClient {
  #fetch
  #baseUrl
  #headers

  constructor({
    baseUrl = '/api',
    fetch = globalThis.fetch,
    headers = {
      'Content-Type': 'application/json',
      'X-Dev-Session': 'dev-local'
    }
  } = {}) {
    if (typeof fetch !== 'function') {
      throw new TypeError('AIClient requires a fetch implementation')
    }
    this.#fetch = fetch.bind(globalThis)
    this.#baseUrl = baseUrl.replace(/\/$/, '')
    this.#headers = headers
  }

  async #request(path, { method = 'GET', body, headers = {} } = {}) {
    let response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          ...this.#headers,
          ...headers
        },
        body
      })
    } catch (error) {
      throw new AIClientError(
        'AI_TIMEOUT',
        '无法连接 AI API，请确认服务已启动且本地地址不走代理',
        { retryable: true }
      )
    }

    let payload = null
    const text = await response.text()
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        throw new AIClientError('INVALID_PLAN', 'AI service returned invalid JSON', {
          status: response.status
        })
      }
    }
    if (!response.ok) {
      const error = payload?.error
      throw new AIClientError(error?.code || 'AI_TIMEOUT', error?.message || 'AI request failed', {
        status: response.status,
        retryable: error?.retryable === true
      })
    }
    return payload
  }

  createRun({ request, idempotencyKey }) {
    return this.#request('/ai/runs', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(request)
    })
  }

  getRun(runId) {
    return this.#request(`/ai/runs/${encodeURIComponent(runId)}`)
  }

  cancelRun(runId) {
    return this.#request(`/ai/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
  }

  async streamEvents(runId, { afterEventId = 0, signal, onEvent } = {}) {
    if (typeof onEvent !== 'function') {
      throw new TypeError('streamEvents requires an onEvent callback')
    }

    let response
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/ai/runs/${encodeURIComponent(runId)}/events?afterEventId=${afterEventId}`,
        {
          headers: { ...this.#headers },
          signal
        }
      )
    } catch (error) {
      if (signal?.aborted) {
        const cancellation = new AIClientError('AI_CANCELLED', 'AI event stream was cancelled')
        cancellation.cause = error
        throw cancellation
      }
      throw new AIClientError(
        'AI_TIMEOUT',
        '无法连接 AI API 事件流，请确认服务已启动且本地地址不走代理',
        { retryable: true }
      )
    }

    if (!response.ok || !response.body) {
      let error = null
      const text = await response.text().catch(() => '')
      try {
        error = JSON.parse(text)?.error
      } catch {}
      throw new AIClientError(error?.code || 'AI_TIMEOUT', error?.message || 'AI event stream failed', {
        status: response.status,
        retryable: error?.retryable === true
      })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseSseChunk(chunk)
        if (event) onEvent(event)
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      const event = parseSseChunk(buffer)
      if (event) onEvent(event)
    }
  }
}
