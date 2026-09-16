import { z } from 'zod'
import { AI_SCHEMA_VERSION, RunIdSchema } from './context.js'
import { AIErrorSchema } from './errors.js'
import { AnswerSchema, PlanSchema, RequiresInputSchema } from './plan.js'

export const AI_EVENT_TYPES = Object.freeze({
  STATUS: 'status',
  PLAN_READY: 'plan_ready',
  ANSWER_READY: 'answer_ready',
  REQUIRES_INPUT: 'requires_input',
  ERROR: 'error'
})

const eventEnvelope = {
  schemaVersion: z.literal(AI_SCHEMA_VERSION),
  eventId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  runId: RunIdSchema
}

export const AIStatusEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal(AI_EVENT_TYPES.STATUS),
  status: z.enum(['queued', 'generating', 'cancelled'])
})

export const AIPlanReadyEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal(AI_EVENT_TYPES.PLAN_READY),
  result: PlanSchema
}).refine(event => event.runId === event.result.runId, {
  path: ['result', 'runId'],
  message: 'Event and result must belong to the same run'
})

export const AIRequiresInputEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal(AI_EVENT_TYPES.REQUIRES_INPUT),
  result: RequiresInputSchema
}).refine(event => event.runId === event.result.runId, {
  path: ['result', 'runId'],
  message: 'Event and result must belong to the same run'
})

export const AIAnswerReadyEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal(AI_EVENT_TYPES.ANSWER_READY),
  result: AnswerSchema
}).refine(event => event.runId === event.result.runId, {
  path: ['result', 'runId'],
  message: 'Event and result must belong to the same run'
})

export const AIFailedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal(AI_EVENT_TYPES.ERROR),
  error: AIErrorSchema
})

export const AIEventSchema = z.discriminatedUnion('type', [
  AIStatusEventSchema,
  AIPlanReadyEventSchema,
  AIAnswerReadyEventSchema,
  AIRequiresInputEventSchema,
  AIFailedEventSchema
])
