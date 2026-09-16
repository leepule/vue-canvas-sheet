<template>
  <main class="workspace">
    <header class="workspace-header">
      <h1>AI 表格</h1>
      <span class="workspace-document-name">订单</span>
    </header>

    <div class="workspace-body">
      <section class="workspace-editor" aria-label="订单表格">
        <WorkbookHost ref="workbookHostRef" :initial-data="initialData" />
      </section>

      <aside class="workspace-ai" aria-labelledby="ai-panel-title">
        <header class="workspace-ai-header">
          <h2 id="ai-panel-title">AI</h2>
        </header>
        <AiPanel
          v-if="aiRun"
          v-model:prompt="aiRun.prompt.value"
          :status="aiRun.status.value"
          :preview="aiRun.preview.value"
          :error="aiRun.error.value"
          :messages="aiRun.messages.value"
          :can-undo="aiRun.canUndo.value"
          :can-redo="aiRun.canRedo.value"
          :changed-cells="aiRun.changedCells.value"
          :can-apply-answer="aiRun.canApplyAnswer.value"
          @submit="submitPrompt"
          @apply="aiRun.apply"
          @apply-answer="aiRun.applyAnswer"
          @cancel="aiRun.cancel"
          @undo="aiRun.undo"
          @redo="aiRun.redo"
        />
      </aside>
    </div>
  </main>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, shallowRef } from 'vue'
import WorkbookHost from '../components/WorkbookHost.vue'
import AiPanel from '../components/AiPanel.vue'
import { WorkbookAdapter } from '../services/WorkbookAdapter.js'
import { ContextBuilder } from '../services/ContextBuilder.js'
import { PreviewEngine } from '../services/PreviewEngine.js'
import { AIClient } from '../services/aiClient.js'
import { PatchExecutor } from '../services/PatchExecutor.js'
import { useAiRun } from '../composables/useAiRun.js'
import { createOrdersFixture } from '../../../../tests/fixtures/ai-orders.js'

const initialData = createOrdersFixture()
const workbookHostRef = shallowRef(null)
const aiApiBaseUrl = import.meta.env.VITE_AI_API_BASE_URL || '/api'
let adapter = null
let previewEngine = null
let patchExecutor = null
let contextBuilder = null
const aiRun = shallowRef(null)
let mounted = true

onMounted(async () => {
  await nextTick()
  const workbook = workbookHostRef.value?.getWorkbook()
  if (!workbook) {
    return
  }

  adapter = new WorkbookAdapter(workbook)
  contextBuilder = new ContextBuilder(adapter)
  previewEngine = new PreviewEngine({
    adapter,
    trustedEnvelope: contextBuilder.build().envelope
  })
  patchExecutor = new PatchExecutor({ workbook, adapter })
  aiRun.value = useAiRun({
    adapter,
    client: new AIClient({ baseUrl: aiApiBaseUrl }),
    previewEngine,
    patchExecutor
  })
})

async function submitPrompt() {
  if (!contextBuilder || !aiRun.value) return

  const prompt = aiRun.value.prompt.value.trim()
  if (!prompt) return
  const fullSheetRange = {
    s: { r: 0, c: 0 },
    e: { r: 999, c: 99 }
  }

  const { request, envelope } = contextBuilder.build({
    prompt,
    requestId: `ai-${crypto.randomUUID()}`,
    readRange: fullSheetRange,
    writeRange: fullSheetRange,
    includeSample: true,
    history: aiRun.value.messages.value.map(m => ({ role: m.role, content: m.content }))
  })
  await aiRun.value.submit({ request, trustedEnvelope: envelope })
  aiRun.value.prompt.value = ''
}

onBeforeUnmount(() => {
  mounted = false
  aiRun.value?.dispose()
  adapter?.dispose()
  void previewEngine?.dispose()
})
</script>

<style scoped>
.workspace {
  display: grid;
  grid-template-rows: 48px minmax(0, 1fr);
  width: 100%;
  height: 100vh;
  height: 100dvh;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace-header {
  display: flex;
  align-items: center;
  gap: 20px;
  min-width: 0;
  padding: 0 16px;
  border-bottom: 1px solid #dce0e3;
  background: #ffffff;
}

.workspace-header h1 {
  flex: none;
  margin: 0;
  color: #176440;
  font-size: 16px;
  font-weight: 600;
  line-height: 24px;
}

.workspace-document-name {
  min-width: 0;
  padding-left: 20px;
  border-left: 1px solid #dce0e3;
  color: #50565b;
  font-size: 14px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.workspace-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace-editor {
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace-ai {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid #dce0e3;
  background: #f7f8fa;
  overflow: hidden;
}

.workspace-ai-header {
  flex: none;
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid #e5e7e9;
}

.workspace-ai-header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}

@media (max-width: 960px) {
  .workspace-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .workspace-ai {
    display: none;
  }
}
</style>
