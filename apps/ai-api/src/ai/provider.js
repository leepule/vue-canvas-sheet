import { ModelProvider } from './ModelProvider.js'

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function createProvider(env = process.env, dependencies = {}) {
  if (!env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error('DEEPSEEK_API_KEY is required')
  }

  return new ModelProvider({
    apiKey: env.DEEPSEEK_API_KEY,
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: env.DEEPSEEK_MODEL || 'deepseek-chat',
    timeoutMs: positiveInteger(env.AI_REQUEST_TIMEOUT_MS, 30_000),
    maxRepairAttempts: Math.max(0, Number.parseInt(env.AI_REPAIR_ATTEMPTS || '1', 10) || 0),
    maxTokens: positiveInteger(env.DEEPSEEK_MAX_TOKENS, 1024),
    maxRequests: positiveInteger(env.AI_MAX_MODEL_REQUESTS, 1000),
    fetch: dependencies.fetch || globalThis.fetch
  })
}
