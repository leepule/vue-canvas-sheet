import { z } from 'zod'
import { AI_CONTRACT_LIMITS, RequestIdSchema } from './context.js'

export const AI_ERROR_CODES = Object.freeze({
  INVALID_PLAN: 'INVALID_PLAN',
  UNSUPPORTED_FORMULA: 'UNSUPPORTED_FORMULA',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  READ_ONLY: 'READ_ONLY',
  STALE_PREVIEW: 'STALE_PREVIEW',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_CANCELLED: 'AI_CANCELLED',
  APPLY_FAILED: 'APPLY_FAILED',
  LOCAL_SAVE_FAILED: 'LOCAL_SAVE_FAILED',
  VERSION_CONFLICT: 'VERSION_CONFLICT'
})

export const AIErrorCodeSchema = z.enum(Object.values(AI_ERROR_CODES))

export const AIErrorSchema = z.strictObject({
  code: AIErrorCodeSchema,
  message: z.string().min(1).max(AI_CONTRACT_LIMITS.maxTextLength)
    .refine(message => message.trim().length > 0, 'Error message must not be blank'),
  retryable: z.boolean(),
  requestId: RequestIdSchema
})

// The API layer adds requestId from its trusted request when producing a wire error.
export class AIContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AIContractError'
    this.code = code
    this.retryable = false
  }
}
