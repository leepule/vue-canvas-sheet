import { z } from 'zod'
import {
  AI_CONTRACT_LIMITS,
  CellCoordinateSchema,
  CellRangeSchema,
  RequestEnvelopeSchema
} from './context.js'
import { AIContractError, AI_ERROR_CODES } from './errors.js'

const TextSchema = z.string().min(1).max(AI_CONTRACT_LIMITS.maxTextLength)
  .refine(text => text.trim().length > 0, 'Text must not be blank')

const AnswerTextSchema = z.string().min(1).max(AI_CONTRACT_LIMITS.maxAnswerLength)
  .refine(text => text.trim().length > 0, 'Answer must not be blank')

const WarningsSchema = z.array(TextSchema).max(AI_CONTRACT_LIMITS.maxWarnings)

// Formula text is data here. Engine parsing and reference checks are separate gates.
const FormulaTextSchema = z.string().min(2).max(AI_CONTRACT_LIMITS.maxFormulaLength)
  .startsWith('=')
  .refine(formula => formula.slice(1).trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(formula), {
    message: 'Formula text must contain a single non-empty expression'
  })

export const FillFormulaOperationSchema = z.strictObject({
  type: z.literal('fill_formula'),
  seedCell: CellCoordinateSchema,
  seedFormula: FormulaTextSchema,
  targetRange: CellRangeSchema
}).refine(operation => (
  operation.seedCell.r === operation.targetRange.s.r &&
  operation.seedCell.c === operation.targetRange.s.c
), {
  path: ['seedCell'],
  message: 'The seed cell must be the top-left cell of the target range'
}).refine(operation => {
  const { s, e } = operation.targetRange
  const cells = (e.r - s.r + 1) * (e.c - s.c + 1)
  return Number.isSafeInteger(cells) && cells > 0 && cells <= AI_CONTRACT_LIMITS.maxWriteCells
}, {
  path: ['targetRange'],
  message: 'The target exceeds the per-plan cell limit'
})

export const PlanSchema = z.strictObject({
  ...RequestEnvelopeSchema.shape,
  kind: z.literal('plan'),
  operations: z.array(FillFormulaOperationSchema).length(1),
  warnings: WarningsSchema
})

export const RequiresInputSchema = z.strictObject({
  ...RequestEnvelopeSchema.shape,
  kind: z.literal('requires_input'),
  questions: z.array(TextSchema).min(1).max(AI_CONTRACT_LIMITS.maxQuestions),
  warnings: WarningsSchema
})

export const AnswerSchema = z.strictObject({
  ...RequestEnvelopeSchema.shape,
  kind: z.literal('answer'),
  content: AnswerTextSchema,
  warnings: WarningsSchema
})

export const AIResponseSchema = z.discriminatedUnion('kind', [
  PlanSchema,
  RequiresInputSchema,
  AnswerSchema
])

function sameRanges(first, second) {
  return first.length === second.length && first.every((range, index) => {
    const other = second[index]
    return range.s.r === other.s.r && range.s.c === other.s.c &&
      range.e.r === other.e.r && range.e.c === other.e.c
  })
}

function containsRange(outer, inner) {
  return outer.s.r <= inner.s.r && outer.s.c <= inner.s.c &&
    outer.e.r >= inner.e.r && outer.e.c >= inner.e.c
}

// The caller supplies a separately retained trusted envelope, never one taken from input.
// This checks envelope and write scope, not formula read dependencies or permission to execute.
export function validatePlanAuthorization(input, trustedEnvelope) {
  const envelopeResult = RequestEnvelopeSchema.safeParse(trustedEnvelope)
  if (!envelopeResult.success) {
    throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, 'The trusted request envelope is invalid')
  }

  const responseResult = AIResponseSchema.safeParse(input)
  if (!responseResult.success) {
    throw new AIContractError(AI_ERROR_CODES.INVALID_PLAN, 'The AI response format is invalid')
  }

  const response = responseResult.data
  const envelope = envelopeResult.data

  if (['runId', 'documentId', 'sheetId'].some(field => response[field] !== envelope[field])) {
    throw new AIContractError(AI_ERROR_CODES.OUT_OF_SCOPE, 'The response belongs to a different request or document')
  }

  if (response.documentEpoch !== envelope.documentEpoch ||
      response.baseContentRevision !== envelope.baseContentRevision) {
    throw new AIContractError(AI_ERROR_CODES.STALE_PREVIEW, 'The response document version is stale')
  }

  if (!sameRanges(response.allowedReadRanges, envelope.allowedReadRanges) ||
      !sameRanges(response.allowedWriteRanges, envelope.allowedWriteRanges)) {
    throw new AIContractError(AI_ERROR_CODES.OUT_OF_SCOPE, 'The response changed the authorized ranges')
  }

  if (response.kind === 'plan') {
    for (const operation of response.operations) {
      // M1 requires one enclosing grant; never authorize using the grants' bounding box.
      if (!envelope.allowedWriteRanges.some(range => containsRange(range, operation.targetRange))) {
        throw new AIContractError(AI_ERROR_CODES.OUT_OF_SCOPE, 'The target is outside the authorized write range')
      }
    }
  }

  return response
}
