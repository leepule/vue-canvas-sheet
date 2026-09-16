import { z } from 'zod'

export const AI_SCHEMA_VERSION = 1

export const AI_CONTRACT_LIMITS = Object.freeze({
  maxIdLength: 128,
  maxAuthorizedRanges: 32,
  maxWriteCells: 5000,
  maxFormulaLength: 4096,
  maxTextLength: 1000,
  maxAnswerLength: 32 * 1024,
  maxQuestions: 10,
  maxWarnings: 20
})

const IdentifierSchema = z.string()
  .min(1)
  .max(AI_CONTRACT_LIMITS.maxIdLength)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/u, 'Identifiers must not contain whitespace or control characters')

const NonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const DocumentIdSchema = IdentifierSchema
export const SheetIdSchema = IdentifierSchema
export const DocumentEpochSchema = IdentifierSchema
export const RunIdSchema = IdentifierSchema
export const RequestIdSchema = IdentifierSchema
export const ContentRevisionSchema = NonNegativeIntegerSchema

export const CellCoordinateSchema = z.strictObject({
  r: NonNegativeIntegerSchema,
  c: NonNegativeIntegerSchema
})

export const CellRangeSchema = z.strictObject({
  s: CellCoordinateSchema,
  e: CellCoordinateSchema
}).refine(range => range.s.r <= range.e.r && range.s.c <= range.e.c, {
  path: ['e'],
  message: 'Range end must not precede its start'
})

export const AuthorizationScopeSchema = z.strictObject({
  allowedReadRanges: z.array(CellRangeSchema).max(AI_CONTRACT_LIMITS.maxAuthorizedRanges),
  allowedWriteRanges: z.array(CellRangeSchema).max(AI_CONTRACT_LIMITS.maxAuthorizedRanges)
})

export const RequestEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(AI_SCHEMA_VERSION),
  runId: RunIdSchema,
  documentId: DocumentIdSchema,
  documentEpoch: DocumentEpochSchema,
  sheetId: SheetIdSchema,
  baseContentRevision: ContentRevisionSchema,
  ...AuthorizationScopeSchema.shape
})
