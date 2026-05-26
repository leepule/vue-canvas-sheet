<template>
  <div class="demo-container">
    <div class="header">
      <h1>Vue Canvas Sheet - 实时协同</h1>
      <div class="actions">
        <button 
          @click="loadBigData" 
          class="big-data-btn"
          :disabled="loading"
        >
          {{ loading ? '🚀 正在加载 5W 行...' : '⚡ 加载 5W 行测试' }}
        </button>
        <button @click="toggleReadOnly">
          {{ readOnly ? '🔓 解锁编辑' : '🔒 锁定编辑' }}
        </button>
        <button @click="clearData">🗑 清除数据</button>
        <button @click="toggleReport" class="report-btn">📊 诊断报告</button>
        
        <div class="divider"></div>

        <div class="plugin-section">
          <span class="section-label">选区导航:</span>
          <button 
            @click="goBack" 
            :disabled="!canGoBack" 
            class="plugin-btn icon-btn" 
            title="后退到上一次的选区位置"
          >
            ⬅ 后退
          </button>
          <button 
            @click="goForward" 
            :disabled="!canGoForward" 
            class="plugin-btn icon-btn" 
            title="前进到下一次的选区位置"
          >
            前进 ➡
          </button>
        </div>
      </div>
    </div>
    
    <div class="sheet-wrapper">
      <TableDesigner 
        ref="table"
        :initial-data="initialData"
        :read-only="readOnly"
        :loading="loading"
        :plugins="designerPlugins"
        enable-persistence
        sheet-id="demo-sheet-collab"
      />

      <div :class="['collab-floating-card', { collapsed: isCardCollapsed }]">
        <div v-if="isCardCollapsed" class="collapsed-trigger" @click="isCardCollapsed = false" title="展开协同控制台">
          <span :class="['status-pulse-dot', connectionStatus.toLowerCase()]"></span>
          <span class="collapsed-icon">👥</span>
        </div>

        <div v-else class="card-content">
          <div class="card-header">
            <div class="title-area">
              <span :class="['status-indicator-dot', connectionStatus.toLowerCase()]"></span>
              <h4>多人实时协同</h4>
            </div>
            <button class="collapse-btn" @click="isCardCollapsed = true" title="收起面板">×</button>
          </div>

          <div class="card-body">
            <div class="input-group">
              <label>服务地址</label>
              <input 
                v-model="wsUrl" 
                placeholder="ws://localhost:8080" 
                :disabled="connectionStatus === 'CONNECTED' || connectionStatus === 'CONNECTING'"
                class="card-input"
              />
            </div>
            
            <div class="input-row">
              <div class="input-group">
                <label>协同房间</label>
                <input 
                  v-model="roomId" 
                  placeholder="房间ID" 
                  :disabled="connectionStatus === 'CONNECTED' || connectionStatus === 'CONNECTING'"
                  class="card-input"
                />
              </div>
              <div class="input-group">
                <label>您的昵称</label>
                <input 
                  v-model="userName" 
                  placeholder="您的昵称" 
                  :disabled="connectionStatus === 'CONNECTED' || connectionStatus === 'CONNECTING'"
                  class="card-input"
                />
              </div>
            </div>

            <div class="input-group color-pick-group">
              <label>光标颜色</label>
              <div class="color-picker-container">
                <input 
                  type="color" 
                  v-model="userColor" 
                  :disabled="connectionStatus === 'CONNECTED' || connectionStatus === 'CONNECTING'"
                  class="card-color-picker"
                />
                <span class="color-hex-label" :style="{ color: userColor }">{{ userColor.toUpperCase() }}</span>
              </div>
            </div>
          </div>

          <div class="card-footer">
            <button 
              @click="connectionStatus === 'CONNECTED' ? disconnectRealtime() : connectRealtime()"
              :class="['connect-action-btn', connectionStatus.toLowerCase()]"
            >
              {{ connectionStatus === 'CONNECTED' ? '断开协同连接' : (connectionStatus === 'CONNECTING' ? '正在连接中...' : '建立协同连接') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showReport" class="report-overlay" @click.self="showReport = false">
      <div class="report-panel">
        <div class="report-header">
          <h3>引擎诊断报告 (Engine Diagnostics)</h3>
          <button @click="showReport = false">×</button>
        </div>
        <div class="report-content" v-if="reportData">
          <div class="report-section">
            <h4>基础信息 (Basic Info)</h4>
            <table class="report-table">
              <tbody>
                <tr><td>引擎版本 (Version)</td><td>{{ reportData.version }}</td></tr>
                <tr><td>存储模式 (Storage)</td><td>{{ reportData.storage }}</td></tr>
              </tbody>
            </table>
          </div>

          <div class="report-section" v-if="reportData.environment">
            <h4>运行环境 (Environment)</h4>
            <table class="report-table">
              <tbody>
                <tr><td>WASM 支持 (WASM Supported)</td><td>{{ reportData.environment.wasmSupported ? '✅ 是 (Yes)' : '❌ 否 (No)' }}</td></tr>
                <tr><td>共享内存 (SharedArrayBuffer)</td><td>{{ reportData.environment.sharedArrayBuffer ? '✅ 是 (Yes)' : '❌ 否 (No)' }}</td></tr>
                <tr><td>跨源隔离 (crossOriginIsolated)</td><td>{{ reportData.environment.crossOriginIsolated ? '✅ 是 (Yes)' : '❌ 否 (No)' }}</td></tr>
              </tbody>
            </table>
          </div>

          <div class="report-section" v-if="reportData.calculation">
            <h4>计算性能 (Calculation)</h4>
            <table class="report-table">
              <tbody>
                <tr><td>多线程批次数 (Batches)</td><td>{{ reportData.calculation.batches }}</td></tr>
                <tr><td>最近计算公式数 (Last Result Count)</td><td>{{ reportData.calculation.lastResultCount }}</td></tr>
                <tr><td>最近计算耗时 (Last Duration)</td><td>{{ reportData.calculation.lastDuration ? reportData.calculation.lastDuration.toFixed(2) + ' ms' : 'N/A' }}</td></tr>
                <tr><td>最近排队公式数 (Last Queue Size)</td><td>{{ reportData.calculation.lastQueueSize }}</td></tr>
                <tr><td>历史累计执行公式 (Formulas Evaluated)</td><td>{{ reportData.calculation.formulasEvaluated }}</td></tr>
                <tr><td>跳过的缓存公式 (Formulas Skipped)</td><td>{{ reportData.calculation.formulasSkipped }}</td></tr>
                <tr><td>缓存未命中 (Cache Misses)</td><td>{{ reportData.calculation.cacheMisses }}</td></tr>
                <tr><td>Worker 传输字节数 (Payload Bytes)</td><td>{{ reportData.calculation.lastWorkerPayloadBytes }}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="report-footer">
          <button @click="refreshReport">刷新数据 (Refresh)</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { 
  TableDesigner, 
  createSelectionHistoryPlugin, 
  createCollaborativeCursorPlugin,
  createRealtimeCollaborationPlugin
} from 'vue-canvas-sheet';

const readOnly = ref(false);
const table = ref(null);
const showReport = ref(false);
const loading = ref(false);
const reportData = ref(null);
const isCardCollapsed = ref(false);

const historyPlugin = createSelectionHistoryPlugin({ maxSize: 50 });
const collaborativePlugin = createCollaborativeCursorPlugin({ expireTime: 12000 });

const randomNames = ['Alice', 'Bob', 'Charlie', 'David', 'Emma', 'Frank', 'Grace', 'Henry', 'Ivy', 'Jack'];
const randomColors = ['#3498db', '#e74c3c', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#d35400', '#16a085'];
const randomIndex = Math.floor(Math.random() * randomNames.length);
const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
const chosenName = `${randomNames[randomIndex]} (${randomSuffix})`;
const chosenColor = randomColors[randomIndex];

const wsUrl = ref('ws://127.0.0.1:8800');
const roomId = ref('demo-sheet');
const userName = ref(chosenName);
const userColor = ref(chosenColor);
const connectionStatus = ref('DISCONNECTED');
let statusTimer = null;

const realCollabPlugin = createRealtimeCollaborationPlugin({
  serverUrl: '',
  roomId: roomId.value,
  userName: userName.value,
  userColor: userColor.value,
  autoConnect: false,
  fieldNames: {}
});

const designerPlugins = [historyPlugin, collaborativePlugin, realCollabPlugin];

const canGoBack = ref(false);
const canGoForward = ref(false);

const updateHistoryState = () => {
  canGoBack.value = historyPlugin.canGoBack();
  canGoForward.value = historyPlugin.canGoForward();
};

const goBack = () => {
  if (historyPlugin.canGoBack()) {
    historyPlugin.goBack();
    updateHistoryState();
  }
};

const goForward = () => {
  if (historyPlugin.canGoForward()) {
    historyPlugin.goForward();
    updateHistoryState();
  }
};

const updateCollabStatus = () => {
  connectionStatus.value = realCollabPlugin.getConnectionStatus();
};

const connectRealtime = () => {
  realCollabPlugin.roomId = roomId.value;
  realCollabPlugin.userName = userName.value;
  realCollabPlugin.userColor = userColor.value;

  realCollabPlugin.connect(wsUrl.value);
  updateCollabStatus();
  
  if (!statusTimer) {
    statusTimer = setInterval(updateCollabStatus, 1000);
  }
};

const disconnectRealtime = () => {
  realCollabPlugin.disconnect();
  updateCollabStatus();
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
};

let selectionListener = null;

onMounted(() => {
  if (table.value && table.value.workbook) {
    selectionListener = table.value.workbook.on('selection-change', () => {
      setTimeout(updateHistoryState, 50);
    });
  }
});

onBeforeUnmount(() => {
  if (selectionListener) {
    selectionListener();
    selectionListener = null;
  }
  disconnectRealtime();
});

const initialData = [
  ["Category", "Input 1", "Input 2", "Formula Description", "Result"],
  ["Basic Math", 10, 20, "10 + 20", { f: "=B2+C2" }],
  ["Division by Zero", 100, 0, "100 / 0", { f: "=B3/C3" }],
  ["Text Functions", "Hello", "World", 'CONCAT(B4, " ", C4)', { f: '=CONCAT(B4, " ", C4)' }],
  ["Logic (TRUE)", 1, "Pass", 'IF(B5, C5, "Fail")', { f: '=IF(B5, C5, "No")' }],
  ["Logic (FALSE)", 0, "Pass", 'IF(B6, C6, "Fail")', { f: '=IF(B6, C6, "Fail")' }],
  ["Type Error", "Text", 5, "Text / 5", { f: "=B7/C7" }],
  ["Unknown Function", "", "", "UNKNOWN()", { f: "=UNKNOWN()" }],
  ["Circular Ref", "", "", "Self Reference", { f: "=E9" }],
  ["Nested IF", 5, 10, "Nested Logic", { f: '=IF(B10>C10, "Big", CONCAT("Small-", C10))' }],
  ["Range Sum", 1, 2, "Sum B2:C10", { f: "=SUM(B2:C10)" }],
  ["Text Length", "Antigravity", "", "LEN(B12)", { f: "=LEN(B12)" }],
  ["Case Conversion", "vUe sHeEt", "", "UPPER(B13)", { f: "=UPPER(B13)" }],
  ["Nested Error", 1, 1, "1 / (B14 - C14)", { f: "=1/(B14-C14)" }],
  ["Logic String", "TRUE", "Yes", 'IF(B15="TRUE", C15, "No")', { f: '=IF(B15="TRUE", C15, "No")' }],
  ["Comparison >", 10, 5, "B16 > C16", { f: "=B16>C16" }],
  ["Comparison =", 10, 10, "B17 = C17", { f: "=B17=C17" }]
];

const toggleReadOnly = () => {
  readOnly.value = !readOnly.value;
};

const toggleReport = () => {
  if (table.value && table.value.workbook) {
    reportData.value = table.value.workbook.getSystemReport();
    showReport.value = true;
  }
};

const refreshReport = () => {
  if (table.value && table.value.workbook) {
    reportData.value = table.value.workbook.getSystemReport();
  }
};

const clearData = () => {
  if (table.value && table.value.workbook) {
    table.value.workbook.clearCells({
      s: { r: 0, c: 0 },
      e: { r: 100, c: 100 }
    });
  }
};

const loadBigData = () => {
  if (table.value && table.value.workbook) {
    const startTime = performance.now();
    loading.value = true;
    const wb = table.value.workbook;
    const ROWS = 50000;
    
    const data = new Array(ROWS);
    
    const formulaTemplates = [
      (i) => `=SUM(A${i+1}:C${i+1})`,
      (i) => `=AVERAGE(A${i+1}:C${i+1})`,
      (i) => `=MAX(A${i+1}:C${i+1})`,
      (i) => `=MIN(A${i+1}:C${i+1})`,
      (i) => `=A${i+1}+B${i+1}+C${i+1}`
    ];

    for (let i = 0; i < ROWS; i++) {
      const getFormula = formulaTemplates[i % formulaTemplates.length];
      data[i] = [i, i * 2, i * 3, { f: getFormula(i) }];
    }

    setTimeout(() => {
      try {
        wb.setData(data);
        wb.recalcAll({ useWorker: true });
      } finally {
        const duration = performance.now() - startTime;
        console.log(`%c[Performance] 5W 行数据（含公式）加载完成，总耗时: ${duration.toFixed(2)}ms`, "color: #409eff; font-weight: bold;");
        loading.value = false;
      }
    }, 50);
  }
};
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;700&display=swap');

.demo-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.header {
  padding: 12px 24px;
  background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
  border-bottom: 1px solid #334155;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  color: #f1f5f9;
  user-select: none;
}

.header h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  background: linear-gradient(to right, #38bdf8, #818cf8);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  font-family: 'Outfit', 'Inter', sans-serif;
  letter-spacing: -0.5px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.actions button, .plugin-btn {
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  border: 1px solid #475569;
  background: #1e293b;
  color: #cbd5e1;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  font-family: 'Inter', sans-serif;
  font-size: 13px;
  font-weight: 500;
  box-sizing: border-box;
}

.actions button:hover:not(:disabled), .plugin-btn:hover:not(:disabled) {
  background: #334155;
  border-color: #64748b;
  color: #f8fafc;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.actions button:active:not(:disabled), .plugin-btn:active:not(:disabled) {
  transform: translateY(0);
}

.actions button:disabled, .plugin-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.divider {
  width: 1px;
  height: 20px;
  background: #334155;
  margin: 0 4px;
}

.plugin-section {
  display: flex;
  align-items: center;
  gap: 6px;
}

.section-label {
  font-size: 11px;
  color: #64748b;
  font-weight: 600;
  margin-right: 4px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  font-family: 'Inter', sans-serif;
}

.plugin-btn.icon-btn {
  background: rgba(30, 41, 59, 0.6);
  border-color: #334155;
}

.plugin-btn.icon-btn:hover:not(:disabled) {
  background: #3b82f6;
  border-color: #60a5fa;
  color: white;
}

.sheet-wrapper {
  flex: 1;
  overflow: hidden;
  background: #f8fafc;
  position: relative;
}

.collab-floating-card,
.collab-floating-card * {
  box-sizing: border-box;
}

.collab-floating-card {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 280px;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(16px) saturate(120%);
  -webkit-backdrop-filter: blur(16px) saturate(120%);
  border: 1px solid rgba(226, 232, 240, 0.8);
  border-radius: 12px;
  box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.1), 0 8px 10px -6px rgba(15, 23, 42, 0.05);
  transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  z-index: 100;
  overflow: hidden;
  font-family: 'Inter', -apple-system, sans-serif;
}

.collab-floating-card.collapsed {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  cursor: pointer;
  background: rgba(15, 23, 42, 0.85);
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.collab-floating-card.collapsed:hover {
  transform: scale(1.05) translateY(-2px);
  background: rgba(15, 23, 42, 0.95);
}

.collapsed-trigger {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.collapsed-icon {
  font-size: 20px;
  line-height: 1;
}

.status-pulse-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #94a3b8;
}

.status-pulse-dot.connected {
  background-color: #10b981;
  box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
  animation: pulse-green 1.5s infinite;
}

.status-pulse-dot.connecting {
  background-color: #f59e0b;
  box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.7);
  animation: pulse-yellow 1.5s infinite;
}

.card-content {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(226, 232, 240, 0.8);
  padding-bottom: 10px;
}

.title-area {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-area h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
}

.status-indicator-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #94a3b8;
}

.status-indicator-dot.connected {
  background-color: #10b981;
}

.status-indicator-dot.connecting {
  background-color: #f59e0b;
}

.collapse-btn {
  background: none;
  border: none;
  font-size: 18px;
  color: #94a3b8;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  transition: color 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
}

.collapse-btn:hover {
  color: #475569;
  background: rgba(0, 0, 0, 0.05);
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.input-row {
  display: flex;
  gap: 8px;
}

.input-row .input-group {
  flex: 1;
  min-width: 0;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.input-group label {
  font-size: 10px;
  font-weight: 600;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.card-input {
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  color: #334155;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: all 0.2s;
}

.card-input:focus {
  border-color: #3b82f6;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.card-input:disabled {
  background: #f1f5f9;
  color: #94a3b8;
  cursor: not-allowed;
  border-color: #e2e8f0;
}

.color-pick-group {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  background: #f8fafc;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
}

.color-pick-group label {
  margin: 0;
}

.color-picker-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-color-picker {
  border: none;
  outline: none;
  background: transparent;
  width: 20px;
  height: 20px;
  cursor: pointer;
  padding: 0;
}

.card-color-picker::-webkit-color-swatch-wrapper {
  padding: 0;
}

.card-color-picker::-webkit-color-swatch {
  border: 1px solid #cbd5e1;
  border-radius: 4px;
}

.card-color-picker:disabled {
  cursor: not-allowed;
}

.color-hex-label {
  font-size: 11px;
  font-family: monospace;
  font-weight: 600;
}

.card-footer {
  margin-top: 4px;
}

.connect-action-btn {
  width: 100%;
  height: 36px;
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
}

.connect-action-btn.disconnected {
  background: #3b82f6;
}

.connect-action-btn.disconnected:hover {
  background: #2563eb;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
}

.connect-action-btn.connecting {
  background: #d97706;
  cursor: not-allowed;
  animation: pulse-btn-yellow 1.5s infinite;
}

.connect-action-btn.connected {
  background: #ef4444;
}

.connect-action-btn.connected:hover {
  background: #dc2626;
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
}

@keyframes pulse-green {
  0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.6); }
  70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
  100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

@keyframes pulse-yellow {
  0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.6); }
  70% { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0); }
  100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
}

@keyframes pulse-btn-yellow {
  0% { opacity: 0.9; }
  50% { opacity: 0.7; }
  100% { opacity: 0.9; }
}

.actions .report-btn {
  background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
  color: white;
  border: none;
}

.actions .report-btn:hover {
  background: linear-gradient(135deg, #60a5fa 0%, #2563eb 100%);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
}

.actions .big-data-btn {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  color: white;
  border: none;
}

.actions .big-data-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
  box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
}

.report-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.report-panel {
  background: #fff;
  width: 600px;
  max-height: 80vh;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 40px rgba(0,0,0,0.25);
  border: 1px solid #e2e8f0;
  overflow: hidden;
  font-family: 'Inter', sans-serif;
}

.report-header {
  padding: 18px 24px;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f8fafc;
}

.report-header h3 { 
  margin: 0; 
  font-size: 16px; 
  color: #0f172a;
  font-weight: 600;
}

.report-header button { 
  background: none; 
  border: none; 
  font-size: 24px; 
  cursor: pointer; 
  color: #94a3b8;
  transition: color 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
}

.report-header button:hover {
  color: #475569;
  background: #e2e8f0;
}

.report-content {
  padding: 24px;
  flex: 1;
  overflow: auto;
  background: #f8fafc;
}

.report-section {
  margin-bottom: 20px;
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.02), 0 1px 2px rgba(0,0,0,0.04);
  border: 1px solid #e2e8f0;
}

.report-section h4 {
  margin: 0 0 12px 0;
  color: #0f172a;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid #f1f5f9;
  padding-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.report-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.report-table td {
  padding: 10px 8px;
  border-bottom: 1px solid #f1f5f9;
}

.report-table tr:last-child td {
  border-bottom: none;
}

.report-table td:first-child {
  color: #64748b;
  width: 55%;
  font-weight: 500;
}

.report-table td:last-child {
  color: #0f172a;
  font-weight: 600;
  text-align: right;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
}

.report-footer {
  padding: 16px 24px;
  border-top: 1px solid #e2e8f0;
  text-align: right;
  background: #f8fafc;
}

.report-footer button {
  padding: 10px 24px;
  background: #10b981;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
  font-size: 13px;
  transition: all 0.2s;
}

.report-footer button:hover {
  background: #059669;
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.25);
}
</style>

