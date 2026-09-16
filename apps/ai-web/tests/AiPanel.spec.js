import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { Workbook } from 'vue-canvas-sheet/core'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import AiPanel from '../src/components/AiPanel.vue'
import { useAiRun } from '../src/composables/useAiRun.js'
import { AIClient } from '../src/services/aiClient.js'
import { ContextBuilder } from '../src/services/ContextBuilder.js'
import { PatchExecutor } from '../src/services/PatchExecutor.js'
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

function createPlan(adapter, seedFormula) {
  const { envelope } = new ContextBuilder(adapter).build({
    prompt: '根据单价和数量生成销售额列',
    readRange: READ_RANGE,
    writeRange: WRITE_RANGE
  })
  return {
    envelope,
    plan: {
      ...envelope,
      runId: `run-${seedFormula}`,
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

function statusEvent(runId, status, eventId) {
  return {
    schemaVersion: 1,
    eventId,
    runId,
    type: 'status',
    status
  }
}

function planEvent(runId, result) {
  return {
    schemaVersion: 1,
    eventId: 3,
    runId,
    type: 'plan_ready',
    result
  }
}

describe('AiPanel', () => {
  let workbook
  let adapter
  let container
  let app

  beforeEach(() => {
    workbook = createWorkbook()
    adapter = new WorkbookAdapter(workbook)
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    app = null
    workbook.destroy()
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function mountPanel(run, { mode = 'table', api = '/api/ai/chat' } = {}) {
    app = createApp({
      render: () => h(AiPanel, {
        api,
        mode,
        prompt: run.prompt.value,
        status: run.status.value,
        preview: run.preview.value,
        error: run.error.value,
        canUndo: run.canUndo.value,
        canRedo: run.canRedo.value,
        changedCells: run.changedCells.value,
        canApplyAnswer: run.canApplyAnswer?.value || false,
        'onUpdate:prompt': value => {
          run.prompt.value = value
        },
        onSubmit: () => run.submit(run.nextRequest),
        onApply: () => run.apply(),
        onCancel: () => run.cancel(),
        onUndo: () => run.undo(),
        onRedo: () => run.redo()
      })
    })
    app.mount(container)
  }

  function createFakeClient(plans) {
    let runCount = 0
    return {
      async createRun() {
        const index = runCount++
        return { runId: plans[index].plan.runId, status: 'generating' }
      },
      async streamEvents(runId, { onEvent }) {
        const plan = plans[runCount - 1].plan
        onEvent(statusEvent(runId, 'queued', 1))
        onEvent(statusEvent(runId, 'generating', 2))
        onEvent(planEvent(runId, plan))
      },
      async getRun() {
        return { status: 'failed', error: { message: 'not found' } }
      },
      async cancelRun() {
        return { status: 'cancelled' }
      }
    }
  }

  function getButton(text) {
    return [...container.querySelectorAll('button')].find(button => button.textContent === text)
  }

  it('renders the idle input state', () => {
    const run = useAiRun({
      adapter,
      client: createFakeClient([]),
      previewEngine: {},
      patchExecutor: {}
    })
    mountPanel(run)

    expect(container.querySelector('.ai-panel-status').textContent).toBe('待输入')
    expect(getButton('生成').disabled).toBe(true)
  })

  it('streams an AI SDK chat conversation', async () => {
    const run = useAiRun({
      adapter,
      client: createFakeClient([]),
      previewEngine: {},
      patchExecutor: {}
    })
    const fetchMock = vi.fn(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: 'text-start', id: 'answer-text' })
          writer.write({ type: 'text-delta', id: 'answer-text', delta: '这是一个订单表。' })
          writer.write({ type: 'text-end', id: 'answer-text' })
        }
      })
    }))
    vi.stubGlobal('fetch', fetchMock)
    mountPanel(run, { mode: 'chat' })

    const textarea = container.querySelector('.ai-panel textarea')
    textarea.value = '解释这个表格'
    textarea.dispatchEvent(new Event('input'))
    await nextUpdate()
    getButton('生成').click()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('这是一个订单表。')
      expect(container.querySelector('.ai-panel-status').textContent).toBe('待输入')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/ai/chat')
  })

  it('shows an insert action for a generated tabular answer', () => {
    const run = useAiRun({
      adapter,
      client: createFakeClient([]),
      previewEngine: {},
      patchExecutor: {}
    })
    run.status.value = 'answer_ready'
    run.messages.value.push({
      id: 'answer-1',
      role: 'assistant',
      type: 'answer',
      content: '| 45.50 | 12 |'
    })
    run.answerPatch.value = { changes: [{ r: 1, c: 0 }] }
    mountPanel(run)

    expect([...container.querySelectorAll('button')].map(button => button.textContent))
      .toContain('插入表格')
    app.unmount()
    app = null
  })

  it('completes preview, apply, undo, and redo', async () => {
    const first = createPlan(adapter, '=A2*B2')
    const client = createFakeClient([first])
    const run = useAiRun({
      adapter,
      client,
      previewEngine: new PreviewEngine({ adapter, trustedEnvelope: first.envelope }),
      patchExecutor: new PatchExecutor({ workbook, adapter })
    })
    run.nextRequest = {
      request: {
        schemaVersion: 1,
        requestId: 'request-panel',
        prompt: '生成销售额',
        envelope: first.envelope
      },
      trustedEnvelope: first.envelope
    }
    mountPanel(run)

    const textarea = container.querySelector('.ai-panel textarea')
    textarea.value = '生成销售额列'
    textarea.dispatchEvent(new Event('input'))
    await nextUpdate()
    expect(getButton('生成').disabled).toBe(false)
    getButton('生成').click()
    await run.submit(run.nextRequest)
    await vi.waitFor(() => expect(run.status.value).toBe('preview_ready'))
    expect(run.preview.value.changes.map(change => change.newValue)).toEqual([20, 15, 32])
    expect([...container.querySelectorAll('.change-preview-value')].map(node => node.textContent))
      .toEqual(['20', '15', '32'])

    const applyButton = getButton('应用修改')
    applyButton.click()
    await vi.waitFor(() => expect(run.status.value).toBe('applied'))
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([20, 15, 32])
    expect(run.changedCells.value).toBe(3)

    const undoButton = [...container.querySelectorAll('button')].find(button => button.textContent === '撤销')
    undoButton.click()
    await vi.waitFor(() => expect(run.status.value).toBe('undone'))
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([null, null, null])

    const redoButton = [...container.querySelectorAll('button')].find(button => button.textContent === '重做')
    redoButton.click()
    await vi.waitFor(() => expect(run.status.value).toBe('applied'))
    expect([1, 2, 3].map(row => workbook.getCellValue(row, 2))).toEqual([20, 15, 32])
  })

  it('invalidates an old preview after a manual source-cell edit', async () => {
    const first = createPlan(adapter, '=A2*B2')
    const second = createPlan(adapter, '=A2+B2')
    const client = createFakeClient([first, second])
    const run = useAiRun({
      adapter,
      client,
      previewEngine: new PreviewEngine({ adapter, trustedEnvelope: first.envelope }),
      patchExecutor: new PatchExecutor({ workbook, adapter })
    })
    run.nextRequest = {
      request: {
        schemaVersion: 1,
        requestId: 'request-panel',
        prompt: '生成销售额',
        envelope: first.envelope
      },
      trustedEnvelope: first.envelope
    }
    mountPanel(run)

    run.prompt.value = '生成销售额列'
    await nextUpdate()
    getButton('生成').click()
    await run.submit(run.nextRequest)
    await vi.waitFor(() => expect(run.status.value).toBe('preview_ready'))

    run.nextRequest = {
      request: {
        schemaVersion: 1,
        requestId: 'request-panel-2',
        prompt: '改为求和',
        envelope: second.envelope
      },
      trustedEnvelope: second.envelope
    }
    const textarea = container.querySelector('.ai-panel textarea')
    textarea.value = '改为求和'
    textarea.dispatchEvent(new Event('input'))
    await nextUpdate()
    ;[...container.querySelectorAll('button')].find(button => button.textContent === '生成').click()
    await vi.waitFor(() => expect(run.status.value).toBe('preview_ready'))
    expect(run.preview.value.changes[0].formula).toBe('=A2+B2')

    workbook.setCell(1, 0, { v: 99 })
    await vi.waitFor(() => expect(run.status.value).toBe('failed'))

    run.apply()
    await nextUpdate()
    expect(run.status.value).toBe('failed')
    expect(container.textContent).toContain('表格内容已变化，预览已失效')
    expect(workbook.getCell(1, 2)).toBeNull()
  })
})

describe('AIClient', () => {
  it('creates a run with idempotency and development session headers', async () => {
    const requests = []
    const client = new AIClient({
      baseUrl: '/api',
      fetch: async (url, init) => {
        requests.push({ url, init })
        return {
          ok: true,
          status: 202,
          text: async () => JSON.stringify({ runId: 'run-client', status: 'generating' })
        }
      }
    })

    const task = await client.createRun({
      request: { schemaVersion: 1 },
      idempotencyKey: 'client-key-001'
    })

    expect(task.runId).toBe('run-client')
    expect(requests[0].url).toBe('/api/ai/runs')
    expect(requests[0].init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Dev-Session': 'dev-local',
      'Idempotency-Key': 'client-key-001'
    })
  })

  it('parses server-sent events from a fetch stream', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode('id: 1\ndata: {"schemaVersion":1,"eventId":1,"runId":"run-client","type":"status","status":"generating"}\n\n')
    ]
    let readCount = 0
    const client = new AIClient({
      fetch: async () => ({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => readCount < chunks.length
              ? { done: false, value: chunks[readCount++] }
              : { done: true }
          })
        }
      })
    })
    const events = []

    await client.streamEvents('run-client', {
      afterEventId: 0,
      onEvent: event => events.push(event)
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      eventId: 1,
      runId: 'run-client',
      type: 'status',
      status: 'generating'
    })
  })

  it('reports a local connection failure with an actionable message', async () => {
    const client = new AIClient({
      baseUrl: 'http://127.0.0.1:8891/api',
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      }
    })

    await expect(client.createRun({
      request: { schemaVersion: 1 },
      idempotencyKey: 'client-key-001'
    })).rejects.toMatchObject({
      code: 'AI_TIMEOUT',
      retryable: true,
      message: '无法连接 AI API，请确认服务已启动且本地地址不走代理'
    })
  })
})

describe('useAiRun recovery', () => {
  it('falls back to run polling when the event stream disconnects', async () => {
    const workbook = createWorkbook()
    const adapter = new WorkbookAdapter(workbook)
    const { envelope, plan } = createPlan(adapter, '=A2*B2')
    const client = {
      async createRun() {
        return { runId: plan.runId, status: 'generating' }
      },
      async streamEvents() {
        throw Object.assign(new Error('stream disconnected'), { retryable: true })
      },
      async getRun() {
        return { runId: plan.runId, status: 'plan_ready', result: plan }
      },
      async cancelRun() {
        return { status: 'cancelled' }
      }
    }
    const run = useAiRun({
      adapter,
      client,
      previewEngine: new PreviewEngine({ adapter, trustedEnvelope: envelope }),
      patchExecutor: new PatchExecutor({ workbook, adapter })
    })

    await run.submit({
      request: {
        schemaVersion: 1,
        requestId: 'request-recovery',
        prompt: '生成销售额',
        envelope
      },
      trustedEnvelope: envelope
    })

    expect(run.status.value).toBe('preview_ready')
    expect(run.preview.value.changes.map(change => change.newValue)).toEqual([20, 15, 32])
    run.dispose()
    workbook.destroy()
  })

  it('shows a generated answer in the conversation after polling', async () => {
    const workbook = createWorkbook()
    const adapter = new WorkbookAdapter(workbook)
    const fullRange = { s: { r: 0, c: 0 }, e: { r: 999, c: 99 } }
    const { envelope } = new ContextBuilder(adapter).build({
      readRange: fullRange,
      writeRange: fullRange
    })
    const answer = '| 单价 | 数量 |\n| --- | --- |\n| 45.50 | 12 |'
    const client = {
      async createRun() {
        return { runId: 'run-question', status: 'generating' }
      },
      async streamEvents() {
        throw Object.assign(new Error('stream disconnected'), { retryable: true })
      },
      async getRun() {
        return {
          status: 'answer_ready',
          result: { content: answer }
        }
      },
      async cancelRun() {
        return { status: 'cancelled' }
      }
    }
    const run = useAiRun({
      adapter,
      client,
      previewEngine: {},
      patchExecutor: new PatchExecutor({ workbook, adapter })
    })

    await run.submit({
      request: {
        schemaVersion: 1,
        requestId: 'request-answer',
        prompt: '生成100条mock数据',
        envelope
      },
      trustedEnvelope: envelope
    })

    expect(run.status.value).toBe('answer_ready')
    expect(run.error.value).toBe('')
    expect(run.messages.value.at(-1)).toMatchObject({ type: 'answer', content: answer })
    expect(run.canApplyAnswer.value).toBe(true)

    await run.applyAnswer()
    expect(run.status.value, run.error.value).toBe('applied')
    expect(workbook.getCellValue(1, 0)).toBe(45.5)
    expect(workbook.getCellValue(1, 1)).toBe(12)
    run.dispose()
    workbook.destroy()
  })
})

function nextUpdate() {
  return nextTick()
}
