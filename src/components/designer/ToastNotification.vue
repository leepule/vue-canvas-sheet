<template>
  <Teleport to="body">
    <TransitionGroup
      name="toast"
      tag="div"
      class="toast-container"
      :style="{ '--toast-bottom-offset': containerBottom + 'px' }"
    >
      <div
        v-for="item in toasts"
        :key="item.id"
        class="toast-item"
        :class="[`toast-${item.severity || 'info'}`]"
        @click="item.dismissible !== false && dismiss(item.id)"
      >
        <div class="toast-body">
          <span class="toast-icon" v-html="severityIcon(item.severity)"></span>
          <div class="toast-content">
            <div class="toast-title">{{ item.title }}</div>
            <div class="toast-message">{{ item.message }}</div>
            <div v-if="item.severity === 'warning' && item.status" class="toast-detail">
              <span v-if="!item.status.crossOriginIsolated" class="toast-detail-tag">
                ⚠ 未跨域隔离
              </span>
              <span v-if="!item.status.sharedArrayBufferAvailable" class="toast-detail-tag">
                ⚠ SAB 不可用
              </span>
              <span v-if="!item.status.wasmLoaded" class="toast-detail-tag">
                ⚠ WASM 未加载
              </span>
            </div>
          </div>
          <button
            v-if="item.dismissible !== false"
            class="toast-close"
            @click.stop="dismiss(item.id)"
            :aria-label="'关闭提示'"
          >
            &times;
          </button>
        </div>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script>
let toastIdCounter = 0;

export default {
  name: 'ToastNotification',

  props: {
    /** Toast 容器距底部的偏移量（px），用于避开公式栏等底部元素 */
    containerBottom: {
      type: Number,
      default: 12,
    },
    /** 默认自动消失时间 (ms)，设为 0 禁止自动消失 */
    defaultDuration: {
      type: Number,
      default: 6000,
    },
    /** 最大同时显示数量 */
    maxToasts: {
      type: Number,
      default: 4,
    },
  },

  data() {
    return {
      toasts: [],
      _timers: new Map(),
    };
  },

  methods: {
    severityIcon(severity) {
      switch (severity) {
        case 'error':
          return '&#10060;';
        case 'warning':
          return '&#9888;&#65039;';
        case 'success':
          return '&#9989;';
        default:
          return '&#8505;&#65039;';
      }
    },

    /**
     * 创建一个 Toast 并返回其 ID。
     * @param {Object} opts
     * @param {string} opts.title        - 标题
     * @param {string} opts.message      - 正文
     * @param {'info'|'warning'|'error'|'success'} [opts.severity] - 严重程度
     * @param {number} [opts.duration]   - 自动消失毫秒数，覆盖 props.defaultDuration；0 表示不自动消失
     * @param {boolean} [opts.dismissible] - 是否可手动关闭，默认 true
     * @param {Object} [opts.status]     - 可选的 wasmBridge 状态对象，用于展示细节
     * @returns {number} toast 唯一 ID
     */
    show(opts = {}) {
      const id = ++toastIdCounter;

      const item = {
        id,
        title: opts.title || '',
        message: opts.message || '',
        severity: opts.severity || 'info',
        dismissible: opts.dismissible !== false,
        status: opts.status || null,
      };

      // 限制最大数量：超限移除最早的一项
      if (this.toasts.length >= this.maxToasts) {
        const oldest = this.toasts.shift();
        this._clearTimer(oldest.id);
      }

      this.toasts.push(item);

      // 自动消失
      const duration = opts.duration !== undefined ? opts.duration : this.defaultDuration;
      if (duration > 0) {
        const timer = setTimeout(() => this.dismiss(id), duration);
        this._timers.set(id, timer);
      }

      return id;
    },

    /**
     * 手动关闭一个 Toast
     * @param {number} id
     */
    dismiss(id) {
      this._clearTimer(id);
      const idx = this.toasts.findIndex((t) => t.id === id);
      if (idx >= 0) {
        this.toasts.splice(idx, 1);
      }
    },

    /**
     * 清除指定 toast 的自动消失定时器
     */
    _clearTimer(id) {
      if (this._timers.has(id)) {
        clearTimeout(this._timers.get(id));
        this._timers.delete(id);
      }
    },
  },

  beforeUnmount() {
    this._timers.forEach((t) => clearTimeout(t));
    this._timers.clear();
    this.toasts = [];
  },
};
</script>

<style scoped>
.toast-container {
  position: fixed;
  bottom: var(--toast-bottom-offset, 12px);
  right: 12px;
  z-index: 10000;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  pointer-events: none;
  max-width: 420px;
}

.toast-item {
  pointer-events: auto;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 2px 4px rgba(0, 0, 0, 0.06);
  padding: 12px 16px;
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  border-left: 4px solid #909399;
}

.toast-item:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16), 0 3px 6px rgba(0, 0, 0, 0.08);
}

/* ── 严重程度着色 ── */
.toast-warning {
  border-left-color: #e6a23c;
  background: #fdf6ec;
}
.toast-error {
  border-left-color: #f56c6c;
  background: #fef0f0;
}
.toast-success {
  border-left-color: #67c23a;
  background: #f0f9eb;
}
.toast-info {
  border-left-color: #409eff;
  background: #ecf5ff;
}

.toast-body {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.toast-icon {
  font-size: 16px;
  line-height: 1.4;
  flex-shrink: 0;
  margin-top: 1px;
}

.toast-content {
  flex: 1;
  min-width: 0;
}

.toast-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 2px;
}

.toast-message {
  font-size: 13px;
  color: #606266;
  line-height: 1.5;
  word-break: break-word;
}

.toast-detail {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.toast-detail-tag {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(230, 162, 60, 0.15);
  color: #b88230;
  white-space: nowrap;
}

.toast-close {
  flex-shrink: 0;
  background: none;
  border: none;
  font-size: 18px;
  color: #909399;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  margin-top: -2px;
  transition: color 0.15s;
}

.toast-close:hover {
  color: #303133;
}

/* ── TransitionGroup 动画 ── */
.toast-enter-active {
  transition: all 0.3s ease-out;
}
.toast-leave-active {
  transition: all 0.25s ease-in;
  position: absolute;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(60px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(60px);
}
.toast-move {
  transition: transform 0.25s ease;
}
</style>
