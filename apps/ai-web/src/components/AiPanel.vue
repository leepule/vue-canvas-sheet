<template>
  <section class="ai-panel">
    <header class="ai-panel-mode" aria-label="AI 模式">
      <div class="ai-panel-mode-toggle" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="isTableMode"
          :class="{ 'is-active': isTableMode }"
          @click="setMode('table')"
        >表格修改</button>
        <button
          type="button"
          role="tab"
          :aria-selected="isChatMode"
          :class="{ 'is-active': isChatMode }"
          @click="setMode('chat')"
        >对话</button>
      </div>
    </header>

    <div ref="chatContainerRef" class="ai-panel-chat-stream">
      <div v-if="!displayMessages.length && !activeError" class="ai-panel-empty">
        <p>{{ emptyText }}</p>
      </div>

      <div
        v-for="msg in displayMessages"
        :key="msg.id"
        class="ai-chat-item"
        :class="[`is-${msg.role}`, `type-${msg.type}`]"
      >
        <div class="ai-chat-avatar">
          {{ msg.role === 'user' ? '我' : 'AI' }}
        </div>
        <div class="ai-chat-bubble">
          <p class="ai-chat-text" :class="{ 'is-answer': msg.type === 'answer' }">{{ msg.content }}</p>
        </div>
      </div>

      <ChangePreview v-if="isTableMode && preview" :preview="preview" />

      <div v-if="isChatGenerating" class="ai-chat-item is-assistant type-generating">
        <div class="ai-chat-avatar">AI</div>
        <div class="ai-chat-bubble">
          <p class="ai-chat-text is-loading">AI 正在思考...</p>
        </div>
      </div>

      <div v-if="activeError && !hasMatchingErrorMessage" class="ai-chat-item is-assistant type-error">
        <div class="ai-chat-avatar">AI</div>
        <div class="ai-chat-bubble">
          <p class="ai-panel-error">{{ activeError }}</p>
        </div>
      </div>
    </div>

    <div class="ai-panel-footer">
      <label class="ai-panel-field">
        <textarea
          v-model="promptModel"
          rows="3"
          :disabled="isTableMode ? isGenerating : isChatGenerating"
          :placeholder="placeholder"
          @keydown.enter.exact.prevent="handleSubmit"
        />
      </label>

      <div class="ai-panel-actions">
        <button
          type="button"
          class="is-primary"
          :disabled="!canSubmit"
          @click="handleSubmit"
        >生成</button>
        <button
          v-if="isTableMode && isGenerating"
          type="button"
          @click="emit('cancel')"
        >取消</button>
        <button
          v-if="isChatMode && isChatGenerating"
          type="button"
          @click="chat.stop"
        >停止</button>
        <button
          v-if="isTableMode && isPreviewReady"
          type="button"
          class="is-primary"
          :disabled="isApplying"
          @click="emit('apply')"
        >应用修改</button>
        <button
          v-if="isTableMode && status === 'answer_ready' && canApplyAnswer"
          type="button"
          class="is-primary"
          @click="emit('apply-answer')"
        >插入表格</button>
        <button
          v-if="isTableMode && canUndo"
          type="button"
          @click="emit('undo')"
        >撤销</button>
        <button
          v-if="isTableMode && canRedo"
          type="button"
          @click="emit('redo')"
        >重做</button>
      </div>

      <div class="ai-panel-status-bar">
        <span class="ai-panel-status" :data-status="displayStatus">{{ statusText }}</span>
        <span v-if="isTableMode && changedCells" class="ai-panel-result">已应用 {{ changedCells }} 个单元格</span>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useChat } from '@ai-sdk/vue'
import { DefaultChatTransport } from 'ai'
import ChangePreview from './ChangePreview.vue'

const props = defineProps({
  api: {
    type: String,
    default: '/api/ai/chat'
  },
  headers: {
    type: [Object, Function],
    default: undefined
  },
  mode: {
    type: String,
    default: 'table',
    validator: value => ['table', 'chat'].includes(value)
  },
  prompt: {
    type: String,
    required: true
  },
  status: {
    type: String,
    required: true
  },
  messages: {
    type: Array,
    default: () => []
  },
  preview: {
    type: Object,
    default: null
  },
  error: {
    type: String,
    default: ''
  },
  canUndo: {
    type: Boolean,
    default: false
  },
  canRedo: {
    type: Boolean,
    default: false
  },
  changedCells: {
    type: Number,
    default: 0
  },
  canApplyAnswer: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:prompt', 'update:mode', 'submit', 'apply', 'apply-answer', 'cancel', 'undo', 'redo'])

const chatContainerRef = ref(null)
const activeMode = ref(props.mode)

const chat = useChat(() => ({
  transport: new DefaultChatTransport({
    api: props.api,
    ...(props.headers ? { headers: props.headers } : {})
  })
}))

const promptModel = computed({
  get: () => props.prompt,
  set: value => emit('update:prompt', value)
})

const isTableMode = computed(() => activeMode.value === 'table')
const isChatMode = computed(() => activeMode.value === 'chat')
const isGenerating = computed(() => props.status === 'generating')
const isChatGenerating = computed(() => ['submitted', 'streaming'].includes(chat.status.value))
const isPreviewReady = computed(() => props.status === 'preview_ready')
const isApplying = computed(() => props.status === 'applying')
const canSubmit = computed(() => {
  if (!props.prompt.trim()) return false
  if (isChatMode.value) return ['ready', 'error'].includes(chat.status.value)

  return [
    'idle',
    'failed',
    'cancelled',
    'requires_input',
    'answer_ready',
    'preview_ready',
    'undone',
    'applied'
  ].includes(props.status)
})

const hasMatchingErrorMessage = computed(() => {
  if (!isTableMode.value) return false
  return props.messages.some(m => m.type === 'error' && m.content === props.error)
})

const chatMessages = computed(() => chat.messages.value.map(message => ({
  id: message.id,
  role: message.role,
  type: message.role === 'assistant' ? 'answer' : 'prompt',
  content: message.parts
    ?.filter(part => part.type === 'text')
    .map(part => part.text)
    .join('') ?? ''
})))

const displayMessages = computed(() => isChatMode.value ? chatMessages.value : props.messages)
const activeError = computed(() => isChatMode.value ? chat.error.value?.message : props.error)
const emptyText = computed(() => isChatMode.value
  ? '输入问题，AI 将基于当前对话上下文回答。'
  : '输入你的修改需求，AI 将为你分析并生成表格修改方案。')
const placeholder = computed(() => isChatMode.value
  ? '例如：解释这个表格的业务含义 (Enter 发送)'
  : '例如：根据单价和数量生成销售额列 (Enter 发送)')

const tableStatusText = computed(() => ({
  idle: '待输入',
  generating: '思考中...',
  answer_ready: '已生成',
  requires_input: '待澄清回答',
  preview_ready: '方案已就绪',
  applying: '应用中...',
  applied: '已应用',
  undoing: '撤销中...',
  undone: '已撤销',
  redoing: '重做中...',
  failed: '异常',
  cancelled: '已取消'
})[props.status] || props.status)

const chatStatusText = computed(() => ({
  ready: '待输入',
  submitted: '思考中...',
  streaming: '思考中...',
  error: '异常'
})[chat.status.value] || chat.status.value)

const statusText = computed(() => isChatMode.value ? chatStatusText.value : tableStatusText.value)
const displayStatus = computed(() => isChatMode.value ? chat.status.value : props.status)

function setMode(mode) {
  if (activeMode.value === mode) return
  activeMode.value = mode
  emit('update:mode', mode)
}

function scrollToBottom() {
  nextTick(() => {
    const container = chatContainerRef.value
    if (container?.scrollTo) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth'
      })
    }
  })
}

async function handleSubmit() {
  if (!canSubmit.value) return

  const text = promptModel.value.trim()
  if (!text) return

  if (isChatMode.value) {
    promptModel.value = ''
    await chat.sendMessage({ text })
    return
  }

  emit('submit')
}

watch(() => displayMessages.value.length, scrollToBottom, { deep: true })
watch(() => props.status, scrollToBottom)
watch(() => chat.status.value, scrollToBottom)
watch(() => props.preview, scrollToBottom)
watch(activeMode, scrollToBottom)

watch(() => props.mode, mode => {
  activeMode.value = mode
})
</script>

<style scoped>
.ai-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
}

.ai-panel-mode {
  flex: none;
  padding: 10px 12px;
  border-bottom: 1px solid #d0d7de;
  background: #ffffff;
}

.ai-panel-mode-toggle {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: 100%;
  padding: 2px;
  border: 1px solid #c9ced3;
  border-radius: 6px;
  background: #eef1f4;
}

.ai-panel-mode-toggle button {
  min-height: 26px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #57606a;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ai-panel-mode-toggle button.is-active {
  background: #ffffff;
  color: #176440;
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(31 35 40 / 12%);
}

.ai-panel-chat-stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scroll-behavior: smooth;

  &::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  &::-webkit-scrollbar-thumb {
    background: #d0d7de;
    border-radius: 3px;

    &:hover {
      background: #afb8c1;
    }
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }
}

.ai-panel-empty {
  color: #6e7781;
  font-size: 13px;
  line-height: 20px;
  text-align: center;
  margin: auto 0;
  padding: 24px 12px;
}

.ai-chat-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.ai-chat-item.is-user {
  flex-direction: row-reverse;
}

.ai-chat-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #eaeef2;
  color: #424a53;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.ai-chat-item.is-user .ai-chat-avatar {
  background: #176440;
  color: #ffffff;
}

.ai-chat-bubble {
  max-width: 82%;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  font-size: 13px;
  line-height: 20px;
  color: #1f2328;
}

.ai-chat-item.is-user .ai-chat-bubble {
  background: #e6f4ea;
  border-color: #b7e1cd;
}

.ai-chat-item.type-error .ai-chat-bubble {
  background: #ffebe9;
  border-color: #ffc1c0;
}

.ai-chat-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-chat-text.is-loading {
  color: #57606a;
  font-style: italic;
}

.ai-panel-footer {
  border-top: 1px solid #d0d7de;
  padding: 12px;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.ai-panel-field {
  display: block;
}

.ai-panel-field textarea {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: 1px solid #c9ced3;
  border-radius: 6px;
  padding: 8px;
  color: #1f2328;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}

.ai-panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-panel-actions button {
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid #b7bdc3;
  border-radius: 4px;
  background: #ffffff;
  color: #1f2328;
  font-size: 13px;
  cursor: pointer;
}

.ai-panel-actions button.is-primary {
  border-color: #176440;
  background: #176440;
  color: #ffffff;
}

.ai-panel-actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ai-panel-status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}

.ai-panel-status {
  color: #57606a;
}

.ai-panel-error {
  color: #cf222e;
  margin: 0;
}

.ai-panel-result {
  color: #176440;
  font-weight: 500;
}
</style>
