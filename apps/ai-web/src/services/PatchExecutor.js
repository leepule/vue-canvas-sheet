export class PatchExecutorError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PatchExecutorError'
    this.code = code
  }
}

function sameRanges(first, second) {
  return first.length === second.length && first.every((range, index) => {
    const other = second[index]
    return range.s.r === other.s.r && range.s.c === other.s.c &&
      range.e.r === other.e.r && range.e.c === other.e.c
  })
}

function containsCoordinate(ranges, coordinate) {
  return ranges.some(range => (
    range.s.r <= coordinate.r && coordinate.r <= range.e.r &&
    range.s.c <= coordinate.c && coordinate.c <= range.e.c
  ))
}

function cleanCellForPatch(cell) {
  if (!cell) return null
  const result = {}
  if (cell.v !== undefined) result.v = cell.v
  if (typeof cell.f === 'string' && cell.f.startsWith('=')) result.f = cell.f
  if (cell.s !== undefined && cell.s !== null) result.s = cell.s
  if (cell.m) result.m = cell.m
  return Object.keys(result).length > 0 ? result : null
}

export class PatchExecutor {
  #workbook
  #adapter

  constructor({ workbook, adapter } = {}) {
    if (!workbook || typeof workbook.applyCellPatch !== 'function') {
      throw new TypeError('PatchExecutor requires a Workbook')
    }
    if (!adapter || typeof adapter.getContentRevision !== 'function') {
      throw new TypeError('PatchExecutor requires a WorkbookAdapter')
    }
    this.#workbook = workbook
    this.#adapter = adapter
  }

  #validatePreview(preview, trustedEnvelope) {
    if (!preview || preview.status !== 'ready' || !Array.isArray(preview.changes)) {
      throw new PatchExecutorError('INVALID_PLAN', 'A ready preview is required')
    }
    if (!preview.runId) {
      throw new PatchExecutorError('INVALID_PLAN', 'The preview has no run ID')
    }
    if (!trustedEnvelope || !trustedEnvelope.documentId || !trustedEnvelope.documentEpoch) {
      throw new PatchExecutorError('INVALID_PLAN', 'A trusted envelope is required')
    }
    if (preview.documentId !== trustedEnvelope.documentId ||
        preview.documentEpoch !== trustedEnvelope.documentEpoch ||
        preview.sheetId !== trustedEnvelope.sheetId) {
      throw new PatchExecutorError('OUT_OF_SCOPE', 'The preview targets a different document or sheet')
    }
    if (preview.baseContentRevision !== trustedEnvelope.baseContentRevision) {
      throw new PatchExecutorError('VERSION_CONFLICT', 'The preview does not match the trusted revision')
    }
    if (!sameRanges(preview.allowedReadRanges, trustedEnvelope.allowedReadRanges) ||
        !sameRanges(preview.allowedWriteRanges, trustedEnvelope.allowedWriteRanges)) {
      throw new PatchExecutorError('OUT_OF_SCOPE', 'The preview changed the authorized ranges')
    }
    if (preview.baseContentRevision !== this.#adapter.getContentRevision()) {
      throw new PatchExecutorError('VERSION_CONFLICT', 'The workbook changed after the preview was created')
    }

    const seen = new Set()
    for (const change of preview.changes) {
      const coordinate = { r: change.r, c: change.c }
      if (!containsCoordinate(trustedEnvelope.allowedWriteRanges, coordinate)) {
        throw new PatchExecutorError('OUT_OF_SCOPE', `Target is outside the write scope: ${change.cellRef}`)
      }
      const key = `${change.r}:${change.c}`
      if (seen.has(key)) throw new PatchExecutorError('INVALID_PLAN', 'Patch contains duplicate targets')
      seen.add(key)
    }
  }

  async apply(preview, trustedEnvelope) {
    this.#validatePreview(preview, trustedEnvelope)

    const mutationId = `ai-${preview.runId}`
    const result = this.#workbook.applyCellPatch({
      mutationId,
      sheetId: preview.sheetId,
      expectedRevision: preview.baseContentRevision,
      changes: preview.changes.map(({ r, c, before, after }) => {
        const currentCell = this.#adapter.getCell(r, c)
        const realBefore = cleanCellForPatch(currentCell)
        return {
          r,
          c,
          before: realBefore ?? cleanCellForPatch(before),
          after
        }
      })
    })
    await this.#workbook.recalcAll({ useWorker: false })

    return {
      mutationId,
      result,
      revision: this.#adapter.getContentRevision(),
      changedCells: result.changedCells
    }
  }

  async undo(appliedPatch) {
    if (!appliedPatch || this.#adapter.getContentRevision() !== appliedPatch.revision) {
      throw new PatchExecutorError('VERSION_CONFLICT', 'The AI patch is no longer the latest change')
    }

    this.#workbook.undo()
    await this.#workbook.recalcAll({ useWorker: false })
    return {
      revision: this.#adapter.getContentRevision(),
      changedCells: appliedPatch.changedCells
    }
  }

  async redo(appliedPatch, undoRevision) {
    if (!appliedPatch || this.#adapter.getContentRevision() !== undoRevision) {
      throw new PatchExecutorError('VERSION_CONFLICT', 'The AI patch can no longer be redone')
    }

    this.#workbook.redo()
    await this.#workbook.recalcAll({ useWorker: false })
    return {
      revision: this.#adapter.getContentRevision(),
      changedCells: appliedPatch.changedCells
    }
  }

  canUndo(appliedPatch) {
    return Boolean(appliedPatch && this.#adapter.getContentRevision() === appliedPatch.revision)
  }

  canRedo(appliedPatch, undoRevision) {
    return Boolean(
      appliedPatch &&
      undoRevision !== null &&
      this.#adapter.getContentRevision() === undoRevision
    )
  }
}
