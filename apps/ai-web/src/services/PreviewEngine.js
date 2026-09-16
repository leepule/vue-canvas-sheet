import { Workbook } from 'vue-canvas-sheet/core'
import { OperationPlanner } from './OperationPlanner.js'

export class PreviewError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PreviewError'
    this.code = code
  }
}

function isCalculationError(value) {
  return value instanceof Error ||
    (value && typeof value === 'object' && value.name === 'Error') ||
    (typeof value === 'string' && value.startsWith('#') && value.endsWith('!'))
}

export class PreviewEngine {
  #adapter
  #planner
  #trustedEnvelope
  #activePreview
  #disposed

  constructor({ adapter, planner, trustedEnvelope } = {}) {
    if (!adapter || typeof adapter.getSnapshot !== 'function') {
      throw new TypeError('PreviewEngine requires a WorkbookAdapter')
    }
    this.#adapter = adapter
    this.#planner = planner || new OperationPlanner(adapter, { trustedEnvelope })
    this.#activePreview = null
    this.#disposed = false
  }

  async #closeActivePreview() {
    const previewWorkbook = this.#activePreview
    this.#activePreview = null
    if (previewWorkbook) await previewWorkbook.close()
  }

  async generate(plan, { signal, trustedEnvelope } = {}) {
    if (this.#disposed) {
      throw new PreviewError('AI_CANCELLED', 'Preview engine was disposed')
    }
    if (signal?.aborted) {
      throw new PreviewError('AI_CANCELLED', 'Preview was cancelled before it started')
    }

    await this.#closeActivePreview()

    if (trustedEnvelope) {
      this.#trustedEnvelope = trustedEnvelope
      this.#planner = new OperationPlanner(this.#adapter, { trustedEnvelope })
    }

    const planned = this.#planner.plan(plan)
    const snapshot = this.#adapter.getSnapshot()
    if (this.#adapter.getContentRevision() !== planned.plan.baseContentRevision) {
      throw new PreviewError('VERSION_CONFLICT', 'Workbook changed while the preview snapshot was created')
    }
    if (signal?.aborted) {
      throw new PreviewError('AI_CANCELLED', 'Preview was cancelled before the temporary workbook was created')
    }

    const previewWorkbook = new Workbook({
      enablePersistence: false,
      enableWasm: false
    })
    this.#activePreview = previewWorkbook

    try {
      previewWorkbook.fromJSON(snapshot)
      const patch = {
        mutationId: `preview-${planned.plan.runId}`,
        sheetId: previewWorkbook.activeSheetId,
        expectedRevision: previewWorkbook.getContentRevision(),
        changes: planned.changes.map(({ r, c, before, after }) => ({
          r,
          c,
          before,
          after
        }))
      }
      previewWorkbook.applyCellPatch(patch)
      await previewWorkbook.recalcAll({ useWorker: false })

      if (this.#disposed) {
        throw new PreviewError('AI_CANCELLED', 'Preview engine was disposed during calculation')
      }
      if (signal?.aborted) {
        throw new PreviewError('AI_CANCELLED', 'Preview was cancelled before results were returned')
      }
      if (this.#adapter.getContentRevision() !== planned.plan.baseContentRevision) {
        throw new PreviewError('VERSION_CONFLICT', 'Workbook changed during preview calculation')
      }

      const changes = planned.changes.map(change => {
        const value = previewWorkbook.getCellValue(change.r, change.c)
        if (isCalculationError(value)) {
          throw new PreviewError('INVALID_PLAN', `Formula calculation failed at ${change.cellRef}`)
        }
        return {
          ...change,
          oldValue: this.#adapter.getCellValue(change.r, change.c),
          newValue: value
        }
      })

      return {
        runId: planned.plan.runId,
        status: 'ready',
        documentId: planned.plan.documentId,
        documentEpoch: planned.plan.documentEpoch,
        baseContentRevision: planned.plan.baseContentRevision,
        sheetId: planned.plan.sheetId,
        allowedReadRanges: structuredClone(planned.plan.allowedReadRanges),
        allowedWriteRanges: structuredClone(planned.plan.allowedWriteRanges),
        warnings: [...planned.warnings],
        changes
      }
    } catch (error) {
      if (error instanceof PreviewError) throw error
      throw new PreviewError('INVALID_PLAN', error.message || 'The plan could not be previewed')
    } finally {
      if (this.#activePreview === previewWorkbook) {
        this.#activePreview = null
        await previewWorkbook.close()
      }
    }
  }

  async dispose() {
    this.#disposed = true
    await this.#closeActivePreview()
  }
}
