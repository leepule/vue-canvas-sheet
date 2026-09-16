import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue'
import { AIEventSchema } from '@ai-sheet/contracts'
import { parseAnswerData } from '../services/AnswerDataParser.js'

const TERMINAL_STATUSES = new Set(['plan_ready', 'answer_ready', 'requires_input', 'failed', 'cancelled'])

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('Cancelled'))
    }, { once: true })
  })
}

export function useAiRun({
  adapter,
  client,
  previewEngine,
  patchExecutor
} = {}) {
  const prompt = ref('')
  const status = ref('idle')
  const preview = shallowRef(null)
  const error = shallowRef('')
  const runId = shallowRef(null)
  const appliedPatch = shallowRef(null)
  const undoRevision = shallowRef(null)
  const canUndo = ref(false)
  const canRedo = ref(false)
  const changedCells = ref(0)
  const messages = ref([])
  const answerPatch = shallowRef(null)

  let controller = null
  let currentTrustedEnvelope = null
  let internalMutation = false
  let disposed = false
  let activeSubmitToken = 0

  const isBusy = computed(() => ['generating', 'applying', 'undoing', 'redoing'].includes(status.value))

  function setError(message, code = 'AI_TIMEOUT') {
    status.value = 'failed'
    error.value = message
    messages.value.push({
      id: `msg-ai-${Date.now()}`,
      role: 'assistant',
      type: 'error',
      content: message,
      timestamp: Date.now()
    })
    return Object.assign(new Error(message), { code })
  }

  function syncHistoryState() {
    canUndo.value = patchExecutor.canUndo(appliedPatch.value)
    canRedo.value = patchExecutor.canRedo(appliedPatch.value, undoRevision.value)
  }

  function createAnswerPatch(content) {
    const rows = parseAnswerData(content)
    if (!rows.length || !currentTrustedEnvelope) return null
    const changes = rows.flatMap((values, rowIndex) => values.map((value, columnIndex) => {
      const r = rowIndex + 1
      const c = columnIndex
      return {
        r,
        c,
        cellRef: adapter.getCellRef({ r, c }),
        before: adapter.getCell(r, c),
        after: { v: value }
      }
    }))
    return {
      status: 'ready',
      runId: `${runId.value || 'answer'}-data`,
      documentId: currentTrustedEnvelope.documentId,
      documentEpoch: currentTrustedEnvelope.documentEpoch,
      baseContentRevision: currentTrustedEnvelope.baseContentRevision,
      sheetId: currentTrustedEnvelope.sheetId,
      allowedReadRanges: currentTrustedEnvelope.allowedReadRanges,
      allowedWriteRanges: currentTrustedEnvelope.allowedWriteRanges,
      changes,
      warnings: []
    }
  }

  function setAnswer(content) {
    answerPatch.value = createAnswerPatch(content)
    status.value = 'answer_ready'
    error.value = ''
    messages.value.push({
      id: `msg-ai-${Date.now()}`,
      role: 'assistant',
      type: 'answer',
      content,
      timestamp: Date.now()
    })
  }

  function handleContentMutation() {
    if (internalMutation || disposed) return
    syncHistoryState()
    if (status.value === 'preview_ready') {
      status.value = 'failed'
      error.value = '表格内容已变化，预览已失效'
      preview.value = null
      messages.value.push({
        id: `msg-ai-${Date.now()}`,
        role: 'assistant',
        type: 'error',
        content: '表格内容已变化，预览已失效',
        timestamp: Date.now()
      })
    }
  }

  const unsubscribeContent = adapter?.subscribeContent(handleContentMutation)

  async function buildPreview(plan) {
    const result = await previewEngine.generate(plan, {
      trustedEnvelope: currentTrustedEnvelope
    })
    preview.value = result
    status.value = 'preview_ready'
    error.value = ''
    messages.value.push({
      id: `msg-ai-${Date.now()}`,
      role: 'assistant',
      type: 'plan',
      content: '已根据要求生成表格修改方案及预览',
      preview: result,
      timestamp: Date.now()
    })
    return result
  }

  async function recoverRun(id, token, signal) {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (token !== activeSubmitToken || signal.aborted) return
      const task = await client.getRun(id)
      if (token !== activeSubmitToken) return

      if (task.status === 'plan_ready') {
        await buildPreview(task.result)
        return
      }
      if (task.status === 'answer_ready') {
        setAnswer(task.result?.content || '')
        return
      }
      if (task.status === 'requires_input') {
        status.value = 'requires_input'
        error.value = task.result?.questions?.[0] || 'AI 需要补充信息'
        messages.value.push({
          id: `msg-ai-${Date.now()}`,
          role: 'assistant',
          type: 'question',
          content: error.value,
          timestamp: Date.now()
        })
        return
      }
      if (task.status === 'failed') {
        status.value = 'failed'
        error.value = task.error?.message || 'AI 任务失败'
        return
      }
      if (task.status === 'cancelled') {
        status.value = 'cancelled'
        return
      }
      await delay(100, signal)
    }
    if (token === activeSubmitToken) {
      status.value = 'failed'
      error.value = 'AI 任务状态查询超时'
    }
  }

  async function submit({ request, trustedEnvelope }) {
    if (isBusy.value || !request || !trustedEnvelope) return

    activeSubmitToken++
    const token = activeSubmitToken
    currentTrustedEnvelope = trustedEnvelope
    status.value = 'generating'
    preview.value = null
    answerPatch.value = null
    error.value = ''
    appliedPatch.value = null
    undoRevision.value = null
    canUndo.value = false
    canRedo.value = false
    changedCells.value = 0
    controller = new AbortController()

    messages.value.push({
      id: `msg-user-${Date.now()}`,
      role: 'user',
      type: 'prompt',
      content: request.prompt,
      timestamp: Date.now()
    })

    try {
      const task = await client.createRun({
        request,
        idempotencyKey: `ai-${crypto.randomUUID()}`
      })
      if (token !== activeSubmitToken || controller.signal.aborted) return
      runId.value = task.runId

      let sawTerminal = false
      let readyPlan = null
      await client.streamEvents(task.runId, {
        afterEventId: 0,
        signal: controller.signal,
        onEvent: event => {
          if (token !== activeSubmitToken) return
          const parsed = AIEventSchema.safeParse(event)
          if (!parsed.success) {
            sawTerminal = true
            throw Object.assign(new Error('AI 事件格式无效'), { code: 'INVALID_PLAN' })
          }

          if (parsed.data.type === 'plan_ready') {
            sawTerminal = true
            readyPlan = parsed.data.result
          } else if (parsed.data.type === 'answer_ready') {
            sawTerminal = true
            setAnswer(parsed.data.result.content)
          } else if (parsed.data.type === 'requires_input') {
            sawTerminal = true
            status.value = 'requires_input'
            error.value = parsed.data.result.questions[0]
            messages.value.push({
              id: `msg-ai-${Date.now()}`,
              role: 'assistant',
              type: 'question',
              content: parsed.data.result.questions[0],
              timestamp: Date.now()
            })
          } else if (parsed.data.type === 'error') {
            sawTerminal = true
            status.value = 'failed'
            error.value = parsed.data.error.message
            messages.value.push({
              id: `msg-ai-${Date.now()}`,
              role: 'assistant',
              type: 'error',
              content: parsed.data.error.message,
              timestamp: Date.now()
            })
          } else if (parsed.data.status === 'cancelled') {
            sawTerminal = true
            status.value = 'cancelled'
          }
        }
      })

      if (token === activeSubmitToken && readyPlan && !controller.signal.aborted) {
        await buildPreview(readyPlan)
      }

      if (token === activeSubmitToken && !sawTerminal && !controller.signal.aborted) {
        await recoverRun(task.runId, token, controller.signal)
      }
    } catch (submitError) {
      if (token !== activeSubmitToken) return
      if (controller.signal.aborted || submitError.code === 'AI_CANCELLED') {
        status.value = 'cancelled'
        return
      }
      if (submitError.retryable && runId.value) {
        try {
          await recoverRun(runId.value, token, controller.signal)
          if (['preview_ready', 'answer_ready', 'requires_input', 'failed', 'cancelled'].includes(status.value)) return
        } catch {}
      }
      status.value = 'failed'
      error.value = submitError?.message || 'AI 请求失败'
      messages.value.push({
        id: `msg-ai-${Date.now()}`,
        role: 'assistant',
        type: 'error',
        content: submitError?.message || 'AI 请求失败',
        timestamp: Date.now()
      })
    } finally {
      if (activeSubmitToken === token) controller = null
    }
  }

  async function cancel() {
    if (!runId.value || isBusy.value && status.value !== 'generating') return

    controller?.abort()
    if (runId.value) {
      try {
        await client.cancelRun(runId.value)
      } catch {}
    }
    status.value = 'cancelled'
    preview.value = null
  }

  async function apply() {
    if (status.value !== 'preview_ready' || !preview.value || !currentTrustedEnvelope) return

    status.value = 'applying'
    internalMutation = true
    try {
      const result = await patchExecutor.apply(preview.value, currentTrustedEnvelope)
      appliedPatch.value = result
      undoRevision.value = null
      changedCells.value = result.changedCells
      status.value = 'applied'
      syncHistoryState()
    } catch (applyError) {
      status.value = 'failed'
      error.value = applyError.message
      canUndo.value = false
      canRedo.value = false
    } finally {
      internalMutation = false
    }
  }

  async function applyAnswer() {
    if (status.value !== 'answer_ready' || !answerPatch.value || !currentTrustedEnvelope) return

    status.value = 'applying'
    internalMutation = true
    try {
      const result = await patchExecutor.apply(answerPatch.value, currentTrustedEnvelope)
      appliedPatch.value = result
      undoRevision.value = null
      changedCells.value = result.changedCells
      status.value = 'applied'
      syncHistoryState()
    } catch (applyError) {
      status.value = 'failed'
      error.value = applyError.message
      canUndo.value = false
      canRedo.value = false
    } finally {
      internalMutation = false
    }
  }

  async function undo() {
    if (!canUndo.value || !appliedPatch.value) return

    status.value = 'undoing'
    internalMutation = true
    try {
      const result = await patchExecutor.undo(appliedPatch.value)
      undoRevision.value = result.revision
      status.value = 'undone'
      syncHistoryState()
    } catch (undoError) {
      status.value = 'applied'
      error.value = undoError.message
      syncHistoryState()
    } finally {
      internalMutation = false
    }
  }

  async function redo() {
    if (!canRedo.value || !appliedPatch.value || undoRevision.value === null) return

    status.value = 'redoing'
    internalMutation = true
    try {
      const result = await patchExecutor.redo(appliedPatch.value, undoRevision.value)
      appliedPatch.value = { ...appliedPatch.value, revision: result.revision }
      undoRevision.value = null
      status.value = 'applied'
      syncHistoryState()
    } catch (redoError) {
      status.value = 'undone'
      error.value = redoError.message
      syncHistoryState()
    } finally {
      internalMutation = false
    }
  }

  function dispose() {
    disposed = true
    activeSubmitToken++
    controller?.abort()
    unsubscribeContent?.()
  }

  if (getCurrentScope()) onScopeDispose(dispose)

  return {
    prompt,
    status,
    preview,
    answerPatch,
    canApplyAnswer: computed(() => Boolean(status.value === 'answer_ready' && answerPatch.value)),
    error,
    runId,
    appliedPatch,
    canUndo,
    canRedo,
    changedCells,
    messages,
    isBusy,
    submit,
    cancel,
    apply,
    applyAnswer,
    undo,
    redo,
    dispose
  }
}
