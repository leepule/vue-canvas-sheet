import {
  AIResponseSchema,
  validatePlanAuthorization
} from '@ai-sheet/contracts'

function containsCoordinate(ranges, coordinate) {
  return ranges.some(range => (
    range.s.r <= coordinate.r && coordinate.r <= range.e.r &&
    range.s.c <= coordinate.c && coordinate.c <= range.e.c
  ))
}

function referenceCoordinates(reference) {
  if (reference.type === 'cell') return [{ r: reference.r, c: reference.c }]
  if (reference.type === 'range') return [reference.start, reference.endRef]
  return []
}

function persistentCell(cell) {
  if (!cell) return null
  const normalized = {}
  if (typeof cell.f === 'string') {
    normalized.f = cell.f
  } else {
    if (cell.v !== undefined) normalized.v = cell.v
    if (cell.m !== undefined) normalized.m = cell.m
  }
  if (cell.s) normalized.s = structuredClone(cell.s)
  return Object.keys(normalized).length > 0 ? normalized : null
}

export class OperationPlanError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OperationPlanError'
    this.code = code
  }
}

export class OperationPlanner {
  #adapter
  #trustedEnvelope

  constructor(adapter, { trustedEnvelope } = {}) {
    if (!adapter || typeof adapter.translateFormula !== 'function') {
      throw new TypeError('OperationPlanner requires a WorkbookAdapter')
    }
    if (!trustedEnvelope || !trustedEnvelope.documentId || !trustedEnvelope.documentEpoch ||
        !trustedEnvelope.sheetId || !Array.isArray(trustedEnvelope.allowedReadRanges) ||
        !Array.isArray(trustedEnvelope.allowedWriteRanges)) {
      throw new TypeError('OperationPlanner requires a trusted envelope from ContextBuilder')
    }
    this.#adapter = adapter
    this.#trustedEnvelope = trustedEnvelope
  }

  plan(inputPlan) {
    const parsedPlan = AIResponseSchema.safeParse(inputPlan)
    if (!parsedPlan.success) {
      throw new OperationPlanError('INVALID_PLAN', 'AI plan did not pass the shared schema')
    }

    let plan
    try {
      const trustedEnvelope = {
        schemaVersion: this.#trustedEnvelope.schemaVersion ?? 1,
        runId: parsedPlan.data.runId,
        documentId: this.#trustedEnvelope.documentId,
        documentEpoch: this.#trustedEnvelope.documentEpoch,
        sheetId: this.#trustedEnvelope.sheetId,
        baseContentRevision: this.#trustedEnvelope.baseContentRevision,
        allowedReadRanges: this.#trustedEnvelope.allowedReadRanges,
        allowedWriteRanges: this.#trustedEnvelope.allowedWriteRanges
      }
      plan = validatePlanAuthorization(parsedPlan.data, trustedEnvelope)
    } catch (error) {
      throw new OperationPlanError(error.code || 'INVALID_PLAN', error.message)
    }

    if (plan.sheetId !== this.#adapter.getSheetId()) {
      throw new OperationPlanError('OUT_OF_SCOPE', 'AI plan targets a different sheet')
    }
    if (plan.baseContentRevision !== this.#adapter.getContentRevision()) {
      throw new OperationPlanError('VERSION_CONFLICT', 'Workbook content changed after the plan was created')
    }
    if (plan.kind !== 'plan') {
      throw new OperationPlanError('INVALID_PLAN', 'Only a plan can be previewed')
    }

    const [operation] = plan.operations
    const seedInspection = this.#adapter.inspectFormula(operation.seedFormula)
    if (!seedInspection.valid) {
      throw new OperationPlanError('INVALID_PLAN', seedInspection.errors[0]?.message || 'Seed formula is invalid')
    }

    const changes = []
    const seenCells = new Set()
    for (let row = operation.targetRange.s.r; row <= operation.targetRange.e.r; row++) {
      for (let column = operation.targetRange.s.c; column <= operation.targetRange.e.c; column++) {
        const coordinate = { r: row, c: column }
        const cellKey = `${row}:${column}`
        if (seenCells.has(cellKey)) {
          throw new OperationPlanError('INVALID_PLAN', 'Plan contains duplicate target cells')
        }
        seenCells.add(cellKey)

        const formula = this.#adapter.translateFormula(operation.seedFormula, {
          from: operation.seedCell,
          to: coordinate
        })
        const inspection = this.#adapter.inspectFormula(formula)
        if (!inspection.valid) {
          throw new OperationPlanError('INVALID_PLAN', inspection.errors[0]?.message || 'Translated formula is invalid')
        }

        for (const reference of inspection.references) {
          for (const coordinateOfReference of referenceCoordinates(reference)) {
            if (!containsCoordinate(plan.allowedReadRanges, coordinateOfReference)) {
              throw new OperationPlanError('OUT_OF_SCOPE', `Formula reference is outside the read scope: ${reference.ref}`)
            }
          }
        }

        const sourceCell = this.#adapter.getCell(row, column)
        const before = persistentCell(sourceCell)
        const after = { f: formula }
        if (before?.s) after.s = structuredClone(before.s)
        changes.push({
          r: row,
          c: column,
          cellRef: this.#adapter.getCellRef(coordinate),
          formula,
          before,
          after,
          references: structuredClone(inspection.references)
        })
      }
    }

    return {
      plan,
      changes,
      warnings: [...plan.warnings]
    }
  }
}
