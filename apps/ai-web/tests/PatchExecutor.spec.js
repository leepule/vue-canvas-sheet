import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Workbook } from 'vue-canvas-sheet/core'
import { ContextBuilder } from '../src/services/ContextBuilder.js'
import { PatchExecutor, PatchExecutorError } from '../src/services/PatchExecutor.js'
import { PreviewEngine } from '../src/services/PreviewEngine.js'
import { WorkbookAdapter } from '../src/services/WorkbookAdapter.js'
import { createOrdersFixture } from '../../../tests/fixtures/ai-orders.js'

const READ_RANGE = { s: { r: 0, c: 0 }, e: { r: 3, c: 1 } }
const WRITE_RANGE = { s: { r: 1, c: 2 }, e: { r: 3, c: 2 } }

function createWorkbook() {
  const workbook = new Workbook({
    enablePersistence: false,
    enableWasm: false
  })
  workbook.setData(createOrdersFixture())
  workbook.setSelection(0, 0, 3, 1)
  return workbook
}

function createPlanContext(adapter, seedFormula = '=A2*B2') {
  const { envelope } = new ContextBuilder(adapter).build({
    readRange: READ_RANGE,
    writeRange: WRITE_RANGE
  })
  return {
    envelope,
    plan: {
      ...envelope,
      runId: 'run-patch-test',
      kind: 'plan',
      operations: [{
        type: 'fill_formula',
        seedCell: { r: 1, c: 2 },
        seedFormula,
        targetRange: WRITE_RANGE
      }],
      warnings: []
    }
  }
}

async function createPreview(adapter, seedFormula = '=A2*B2') {
  const { envelope, plan } = createPlanContext(adapter, seedFormula)
  const engine = new PreviewEngine({ adapter, trustedEnvelope: envelope })
  return {
    envelope,
    preview: await engine.generate(plan, { trustedEnvelope: envelope })
  }
}

describe('PatchExecutor', () => {
  let workbook
  let adapter
  let executor

  beforeEach(() => {
    workbook = createWorkbook()
    adapter = new WorkbookAdapter(workbook)
    executor = new PatchExecutor({ workbook, adapter })
  })

  afterEach(() => {
    workbook.destroy()
  })

  it('applies a preview atomically, then supports undo and redo', async () => {
    const { envelope, preview } = await createPreview(adapter)
    const historySize = workbook.history.undoStackSize
    const revision = workbook.getContentRevision()

    const applied = await executor.apply(preview, envelope)

    expect(applied.changedCells).toBe(3)
    expect(applied.revision).toBe(revision + 1)
    expect(workbook.history.undoStackSize).toBe(historySize + 1)
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([20, 15, 32])
    expect(executor.canUndo(applied)).toBe(true)
    expect(executor.canRedo(applied, null)).toBe(false)

    const undone = await executor.undo(applied)
    expect(undone.revision).toBe(applied.revision + 1)
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([null, null, null])
    expect(executor.canUndo(applied)).toBe(false)
    expect(executor.canRedo(applied, undone.revision)).toBe(true)

    const redone = await executor.redo(applied, undone.revision)
    expect(redone.revision).toBe(undone.revision + 1)
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([20, 15, 32])
  })

  it('rejects an old preview after the user edits a source cell', async () => {
    const { envelope, preview } = await createPreview(adapter)
    workbook.setCell(1, 0, { v: 99 })

    await expect(executor.apply(preview, envelope)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT'
    })
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([null, null, null])
  })

  it('rejects a preview that changes the trusted document identity', async () => {
    const { envelope, preview } = await createPreview(adapter)
    preview.documentId = 'another-document'

    await expect(executor.apply(preview, envelope)).rejects.toMatchObject({
      code: 'OUT_OF_SCOPE'
    })
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([null, null, null])
  })

  it('rejects a target outside the authorized write range', async () => {
    const { envelope, preview } = await createPreview(adapter)
    preview.changes[0] = {
      ...preview.changes[0],
      r: 1,
      c: 3,
      cellRef: 'D2'
    }

    await expect(executor.apply(preview, envelope)).rejects.toMatchObject({
      code: 'OUT_OF_SCOPE'
    })
    expect(workbook.getCellValue(1, 3)).toBeNull()
  })

  it('disables quick undo after a later manual edit', async () => {
    const { envelope, preview } = await createPreview(adapter)
    const applied = await executor.apply(preview, envelope)

    workbook.setCell(1, 0, { v: 99 })

    expect(executor.canUndo(applied)).toBe(false)
    await expect(executor.undo(applied)).rejects.toBeInstanceOf(PatchExecutorError)
  })
})
