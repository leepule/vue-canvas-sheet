<template>
  <Teleport to="body">
    <Transition name="alert-dialog-fade">
      <div
        v-if="visible"
        class="alert-dialog-overlay"
        @keydown.esc.prevent="close"
        @keydown.tab.prevent
        @mousedown.self="close"
      >
        <div
          class="alert-dialog"
          :class="`alert-dialog-${severity}`"
          role="alertdialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="messageId"
          tabindex="-1"
          ref="dialog"
        >
          <div class="alert-dialog-icon" aria-hidden="true">!</div>
          <div class="alert-dialog-content">
            <div class="alert-dialog-title" :id="titleId">{{ title }}</div>
            <div class="alert-dialog-message" :id="messageId">{{ message }}</div>
          </div>
          <div class="alert-dialog-actions">
            <button type="button" ref="confirmButton" @click="close">知道了</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script>
let alertDialogId = 0;

export default {
  name: 'AlertDialog',

  data() {
    const id = `vue-canvas-sheet-alert-${++alertDialogId}`;
    return {
      visible: false,
      title: '提示',
      message: '',
      severity: 'warning',
      titleId: `${id}-title`,
      messageId: `${id}-message`,
      previousActiveElement: null
    };
  },

  methods: {
    open(options = {}) {
      this.title = options.title || '提示';
      this.message = options.message || '';
      this.severity = options.severity || 'warning';
      this.previousActiveElement = document.activeElement;
      this.visible = true;

      this.$nextTick(() => {
        if (this.$refs.confirmButton) {
          this.$refs.confirmButton.focus();
        }
      });
    },

    close() {
      if (!this.visible) return;
      this.visible = false;
      const element = this.previousActiveElement;
      this.previousActiveElement = null;
      if (element && typeof element.focus === 'function') {
        this.$nextTick(() => element.focus());
      }
    }
  }
};
</script>

<style scoped>
.alert-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.38);
}

.alert-dialog {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 14px 16px;
  width: min(420px, 100%);
  padding: 20px;
  background: #fff;
  border-radius: 8px;
  border-top: 4px solid #e6a23c;
  box-shadow: 0 18px 45px rgba(15, 23, 42, 0.22);
}

.alert-dialog-error {
  border-top-color: #ef4444;
}

.alert-dialog-info {
  border-top-color: #3b82f6;
}

.alert-dialog-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #fdf3e3;
  color: #b7791f;
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}

.alert-dialog-error .alert-dialog-icon {
  background: #fee2e2;
  color: #dc2626;
}

.alert-dialog-info .alert-dialog-icon {
  background: #dbeafe;
  color: #2563eb;
}

.alert-dialog-content {
  min-width: 0;
}

.alert-dialog-title {
  color: #1f2937;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.4;
}

.alert-dialog-message {
  margin-top: 6px;
  color: #4b5563;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-line;
  word-break: break-word;
}

.alert-dialog-actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
}

.alert-dialog-actions button {
  min-width: 76px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  font-size: 13px;
  cursor: pointer;
}

.alert-dialog-actions button:hover {
  border-color: #9ca3af;
  background: #f9fafb;
}

.alert-dialog-actions button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

.alert-dialog-fade-enter-active,
.alert-dialog-fade-leave-active {
  transition: opacity 0.16s ease;
}

.alert-dialog-fade-enter-from,
.alert-dialog-fade-leave-to {
  opacity: 0;
}

@media (max-width: 480px) {
  .alert-dialog-overlay {
    padding: 16px;
    align-items: flex-end;
  }

  .alert-dialog {
    padding: 16px;
  }
}
</style>
