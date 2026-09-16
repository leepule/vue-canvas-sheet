import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { Workbook } from 'vue-canvas-sheet/core'
import ChangePreview from '../src/components/ChangePreview.vue'
import { ContextBuilder } from '../src/services/ContextBuilder.js'
import { OperationPlanner, OperationPlanError } from '../src/services/OperationPlanner.js'
import { PreviewEngine, PreviewError } from '../src/services/PreviewEngine.js'
import { WorkbookAdapter } from '../src/services/WorkbookAdapter.js'
import { createOrdersFixture } from '../../../tests/fixtures/ai-orders.js'

const READ_RANGE = { s: { r: 0, c: 0 }, e: { r: 3, c: 1 } }
const WRITE_RANGE = { s: { r: 1, c: 2 }, e: { r: 3, c: 2 } }

function createSourceWorkbook(data = createOrdersFixture()) {
  const workbook = new Workbook({
    enablePersistence: false,
    enableWasm: false
  })
  workbook.setData(data)
  workbook.setSelection(READ_RANGE.s.r, READ_RANGE.s.c, READ_RANGE.e.r, READ_RANGE.e.c)
  return workbook
}

function createPlanContext(adapter, {
  seedFormula = '=A2*B2',
  readRange = READ_RANGE,
  writeRange = WRITE_RANGE
} = {}) {
  const { envelope } = new ContextBuilder(adapter).build({
    readRange,
    writeRange
  })
  const plan = {
    ...envelope,
    runId: 'run-preview-test',
    kind: 'plan',
    operations: [{
      type: 'fill_formula',
      seedCell: { r: 1, c: 2 },
      seedFormula,
      targetRange: { ...writeRange }
    }],
    warnings: []
  }
  return { envelope, plan }
}

function createPlan(adapter, options = {}) {
  return createPlanContext(adapter, options).plan
}

describe('WorkbookAdapter and ContextBuilder', () => {
  let workbook

  beforeEach(() => {
    workbook = createSourceWorkbook()
  })

  afterEach(() => {
    workbook.destroy()
  })

  it('returns the real selection and an independent workbook snapshot', () => {
    const adapter = new WorkbookAdapter(workbook)
    const selection = adapter.getSelection()
    const snapshot = adapter.getSnapshot()

    expect(selection).toEqual(READ_RANGE)
    expect(adapter.getCellRef({ r: 1, c: 2 })).toBe('C2')
    snapshot.data['1-0'] = { v: 999 }

    expect(workbook.getCellValue(1, 0)).toBe(10)
    expect(adapter.getSnapshot().data['1-0']).toMatchObject({ v: 10 })
  })

  it('builds the local AI context without sending sample rows by default', () => {
    const adapter = new WorkbookAdapter(workbook)
    const { request, envelope } = new ContextBuilder(adapter).build({
      readRange: READ_RANGE,
      writeRange: WRITE_RANGE
    })

    expect(request).toEqual({
      schemaVersion: 1,
      requestId: 'ai-preview-request',
      prompt: '根据单价和数量生成销售额列',
      envelope
    })
    expect(request.context).toBeUndefined()
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      documentId: 'local-order-workbook',
      documentEpoch: 'local-preview',
      sheetId: workbook.activeSheetId,
      baseContentRevision: workbook.getContentRevision(),
      allowedReadRanges: [READ_RANGE],
      allowedWriteRanges: [WRITE_RANGE]
    })
  })

  it('removes only its own content subscription', () => {
    const adapter = new WorkbookAdapter(workbook)
    const listener = vi.fn()
    const unsubscribe = adapter.subscribeContent(listener)

    workbook.setCell(1, 0, { v: 11 })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    adapter.dispose()
    workbook.setCell(1, 0, { v: 12 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('supports multiple independent content subscriptions', () => {
    const adapter = new WorkbookAdapter(workbook)
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = adapter.subscribeContent(first)
    adapter.subscribeContent(second)

    workbook.setCell(1, 0, { v: 13 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    unsubscribeFirst()
    workbook.setCell(1, 0, { v: 14 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })
})

describe('OperationPlanner and PreviewEngine', () => {
  let workbook
  let adapter
  let closeSpy

  beforeEach(() => {
    workbook = createSourceWorkbook()
    adapter = new WorkbookAdapter(workbook)
    closeSpy = vi.spyOn(Workbook.prototype, 'close')
  })

  afterEach(async () => {
    await Promise.allSettled(closeSpy.mock.results.map(result => result.value))
    workbook.destroy()
    vi.restoreAllMocks()
  })

  it('previews 20, 15, and 32 without changing the real workbook', async () => {
    const { envelope } = createPlanContext(adapter)
    const planner = new OperationPlanner(adapter, { trustedEnvelope: envelope })
    const planned = planner.plan(createPlan(adapter))
    const revision = workbook.getContentRevision()

    expect(planned.changes.map(change => change.formula)).toEqual([
      '=A2*B2',
      '=A3*B3',
      '=A4*B4'
    ])

    const engine = new PreviewEngine({ adapter, planner, trustedEnvelope: envelope })
    const preview = await engine.generate(createPlan(adapter))

    expect(preview.status).toBe('ready')
    expect(preview.changes.map(change => change.newValue)).toEqual([20, 15, 32])
    expect(preview.changes.map(change => change.oldValue)).toEqual([null, null, null])
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([null, null, null])
    expect(workbook.getContentRevision()).toBe(revision)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps the protected old value while showing its preview replacement', async () => {
    const sourceWithExistingValue = createOrdersFixture()
    sourceWithExistingValue[1][2] = 999
    const existingWorkbook = createSourceWorkbook(sourceWithExistingValue)
    const existingAdapter = new WorkbookAdapter(existingWorkbook)
    const engine = new PreviewEngine({
      adapter: existingAdapter,
      trustedEnvelope: createPlanContext(existingAdapter).envelope
    })

    const preview = await engine.generate(createPlan(existingAdapter))

    expect(preview.changes[0].oldValue).toBe(999)
    expect(preview.changes[0].newValue).toBe(20)
    expect(existingWorkbook.getCellValue(1, 2)).toBe(999)
    existingWorkbook.destroy()
  })

  it('rejects a preview when formula calculation returns an error value', async () => {
    const missingPriceData = createOrdersFixture()
    missingPriceData[1][0] = null
    const missingPriceWorkbook = createSourceWorkbook(missingPriceData)
    const missingPriceAdapter = new WorkbookAdapter(missingPriceWorkbook)
    const engine = new PreviewEngine({
      adapter: missingPriceAdapter,
      trustedEnvelope: createPlanContext(missingPriceAdapter).envelope
    })

    await expect(engine.generate(createPlan(missingPriceAdapter)))
      .rejects.toMatchObject({ code: 'INVALID_PLAN' })
    expect(missingPriceWorkbook.getCellValue(1, 2)).toBeNull()
    missingPriceWorkbook.destroy()
  })

  it('rejects references outside the authorized read range', () => {
    const planner = new OperationPlanner(adapter, {
      trustedEnvelope: createPlanContext(adapter).envelope
    })
    const plan = createPlan(adapter, { seedFormula: '=D2*B2' })

    expect(() => planner.plan(plan)).toThrow(OperationPlanError)
    expect(() => planner.plan(plan)).toThrow(/outside the read scope/)
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([null, null, null])
  })

  it('rejects a plan that changes the locally trusted envelope', () => {
    const { envelope, plan } = createPlanContext(adapter)
    plan.documentId = 'another-document'
    const planner = new OperationPlanner(adapter, { trustedEnvelope: envelope })

    expect(() => planner.plan(plan)).toThrow(OperationPlanError)
    expect(() => planner.plan(plan)).toThrow(/different request or document/)
  })

  it('rejects stale plans after the real workbook changes', async () => {
    const plan = createPlan(adapter)
    const revision = workbook.getContentRevision()
    const engine = new PreviewEngine({
      adapter,
      trustedEnvelope: createPlanContext(adapter).envelope
    })
    workbook.setCell(1, 0, { v: 11 })

    await expect(engine.generate(plan)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT'
    })
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([null, null, null])
    expect(workbook.getContentRevision()).toBe(revision + 1)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('rejects an invalid seed formula before creating a preview workbook', () => {
    const planner = new OperationPlanner(adapter, {
      trustedEnvelope: createPlanContext(adapter).envelope
    })
    const plan = createPlan(adapter, { seedFormula: '=NOW()' })

    expect(() => planner.plan(plan)).toThrow(/VOLATILE_FUNCTION|随时间变化的函数|formula/i)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('closes the active temporary workbook when the engine is disposed', async () => {
    const recalcSpy = vi.spyOn(Workbook.prototype, 'recalcAll')
      .mockImplementation(() => new Promise(resolve => setTimeout(resolve, 20)))
    const engine = new PreviewEngine({
      adapter,
      trustedEnvelope: createPlanContext(adapter).envelope
    })
    const generating = engine.generate(createPlan(adapter))

    await Promise.resolve()
    const disposing = engine.dispose()
    await expect(generating).rejects.toMatchObject({
      code: 'AI_CANCELLED'
    })
    await disposing

    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(recalcSpy).toHaveBeenCalledTimes(1)
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([null, null, null])
  })

  it('rejects an already-cancelled preview request', async () => {
    const engine = new PreviewEngine({
      adapter,
      trustedEnvelope: createPlanContext(adapter).envelope
    })
    const controller = new AbortController()
    controller.abort()

    await expect(engine.generate(createPlan(adapter), { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'AI_CANCELLED' })
  })
})

describe('ChangePreview', () => {
  it('renders formulas, old values, and preview values', () => {
    const container = document.createElement('div')
    const app = createApp({
      render: () => h(ChangePreview, {
        preview: {
          status: 'ready',
          changes: [
            { r: 1, c: 2, cellRef: 'C2', formula: '=A2*B2', oldValue: null, newValue: 20 },
            { r: 2, c: 2, cellRef: 'C3', formula: '=A3*B3', oldValue: null, newValue: 15 },
            { r: 3, c: 2, cellRef: 'C4', formula: '=A4*B4', oldValue: null, newValue: 32 }
          ],
          warnings: []
        }
      })
    })
    app.mount(container)

    expect(container.querySelector('.change-preview-status').textContent).toBe('就绪')
    expect([...container.querySelectorAll('.change-preview-formula')].map(node => node.textContent))
      .toEqual(['=A2*B2', '=A3*B3', '=A4*B4'])
    expect([...container.querySelectorAll('.change-preview-value')].map(node => node.textContent))
      .toEqual(['20', '15', '32'])

    app.unmount()
    container.remove()
  })

  it('shows an error state instead of preview rows', () => {
    const container = document.createElement('div')
    const app = createApp({
      render: () => h(ChangePreview, { error: '公式引用超出授权范围' })
    })
    app.mount(container)

    expect(container.querySelector('.change-preview-status').textContent).toBe('不可应用')
    expect(container.querySelector('.change-preview-error').textContent).toBe('公式引用超出授权范围')
    expect(container.querySelector('.change-preview-table')).toBeNull()

    app.unmount()
    container.remove()
  })
})
