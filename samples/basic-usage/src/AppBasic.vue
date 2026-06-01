<template>
  <div class="demo-container">
    <div class="header">
      <h1>Vue Canvas Sheet - 基础使用</h1>
      <div class="actions">
        <button @click="loadBigData" class="big-data-btn" :disabled="loading">
          {{ loading ? "🚀 正在加载 5W 行..." : "⚡ 加载 5W 行测试" }}
        </button>
        <button @click="toggleReadOnly">
          {{ readOnly ? "🔓 解锁编辑" : "🔒 锁定编辑" }}
        </button>
        <button @click="clearData">🗑 清除数据</button>
        <button @click="toggleReport" class="report-btn">📊 诊断报告</button>

        <div class="divider"></div>

        <div class="plugin-section">
          <span class="section-label">选区导航:</span>
          <button @click="goBack" :disabled="!canGoBack" class="plugin-btn icon-btn" title="后退到上一次的选区位置">
            ⬅ 后退
          </button>
          <button @click="goForward" :disabled="!canGoForward" class="plugin-btn icon-btn" title="前进到下一次的选区位置">
            前进 ➡
          </button>
        </div>
      </div>
    </div>

    <div class="sheet-wrapper">
      <TableDesigner ref="table" :initial-data="initialData" :read-only="readOnly" :loading="loading" :plugins="designerPlugins" enable-persistence sheet-id="demo-sheet-basic">
        <template #toolbar-end-group>
          <button class="vue-canvas-sheet-tool-btn" @click="handleExportExcel" title="导出为 Excel 文件">
            <SvgIcon name="document-xls" />
          </button>
          <button class="vue-canvas-sheet-tool-btn" @click="handleExportCSV" title="导出为 CSV 文件">
            <SvgIcon name="document-csv" />
          </button>
          <button class="vue-canvas-sheet-tool-btn" @click="handleExportJSON" title="导出为 JSON 文件">
            <SvgIcon name="code" />
          </button>
          <button class="vue-canvas-sheet-tool-btn" @click="handleImport" title="导入 Excel 或 JSON 文件">
            <SvgIcon name="upload" />
          </button>
          <input type="file" ref="fileInput" style="display: none" @change="handleFileChange" accept=".json,.xlsx,.xls" />
        </template>
      </TableDesigner>
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
                <tr>
                  <td>引擎版本 (Version)</td>
                  <td>{{ reportData.version }}</td>
                </tr>
                <tr>
                  <td>存储模式 (Storage)</td>
                  <td>{{ reportData.storage }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="report-section" v-if="reportData.environment">
            <h4>运行环境 (Environment)</h4>
            <table class="report-table">
              <tbody>
                <tr>
                  <td>WASM 支持 (WASM Supported)</td>
                  <td>
                    {{
                      reportData.environment.wasmSupported
                        ? "✅ 是 (Yes)"
                        : "❌ 否 (No)"
                    }}
                  </td>
                </tr>
                <tr>
                  <td>共享内存 (SharedArrayBuffer)</td>
                  <td>
                    {{
                      reportData.environment.sharedArrayBuffer
                        ? "✅ 是 (Yes)"
                        : "❌ 否 (No)"
                    }}
                  </td>
                </tr>
                <tr>
                  <td>跨源隔离 (crossOriginIsolated)</td>
                  <td>
                    {{
                      reportData.environment.crossOriginIsolated
                        ? "✅ 是 (Yes)"
                        : "❌ 否 (No)"
                    }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="report-section" v-if="reportData.calculation">
            <h4>计算性能 (Calculation)</h4>
            <table class="report-table">
              <tbody>
                <tr>
                  <td>多线程批次数 (Batches)</td>
                  <td>{{ reportData.calculation.batches }}</td>
                </tr>
                <tr>
                  <td>最近计算公式数 (Last Result Count)</td>
                  <td>{{ reportData.calculation.lastResultCount }}</td>
                </tr>
                <tr>
                  <td>最近计算耗时 (Last Duration)</td>
                  <td>
                    {{
                      reportData.calculation.lastDuration
                        ? reportData.calculation.lastDuration.toFixed(2) + " ms"
                        : "N/A"
                    }}
                  </td>
                </tr>
                <tr>
                  <td>最近排队公式数 (Last Queue Size)</td>
                  <td>{{ reportData.calculation.lastQueueSize }}</td>
                </tr>
                <tr>
                  <td>历史累计执行公式 (Formulas Evaluated)</td>
                  <td>{{ reportData.calculation.formulasEvaluated }}</td>
                </tr>
                <tr>
                  <td>跳过的缓存公式 (Formulas Skipped)</td>
                  <td>{{ reportData.calculation.formulasSkipped }}</td>
                </tr>
                <tr>
                  <td>缓存未命中 (Cache Misses)</td>
                  <td>{{ reportData.calculation.cacheMisses }}</td>
                </tr>
                <tr>
                  <td>Worker 传输字节数 (Payload Bytes)</td>
                  <td>{{ reportData.calculation.lastWorkerPayloadBytes }}</td>
                </tr>
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
import { ref, onMounted, onBeforeUnmount } from "vue";
import {
  TableDesigner,
  SvgIcon,
  createSelectionHistoryPlugin,
  createExportPlugin,
  createImportPlugin,
} from "vue-canvas-sheet";

const readOnly = ref(false);
const table = ref(null);
const showReport = ref(false);
const loading = ref(false);
const reportData = ref(null);

const historyPlugin = createSelectionHistoryPlugin({ maxSize: 50 });
const exportPlugin = createExportPlugin({ defaultFileName: "demo-data" });
const importPlugin = createImportPlugin({
  onComplete: (result) => {
    console.log("导入完成:", result);
  },
  onError: (error) => {
    alert("导入失败: " + error.message);
  },
});

const designerPlugins = [historyPlugin, exportPlugin, importPlugin];

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

const fileInput = ref(null);

const handleExportExcel = () => {
  exportPlugin.exportExcel({ fileName: "demo-data.xlsx" });
};

const handleExportCSV = () => {
  exportPlugin.exportCSV({ fileName: "demo-data.csv" });
};

const handleExportJSON = () => {
  exportPlugin.exportJSON({ fileName: "demo-data.json" });
};

const handleImport = () => {
  fileInput.value?.click();
};

const handleFileChange = (e) => {
  const file = e.target.files[0];
  if (file) {
    importPlugin.importFile(file);
    e.target.value = "";
  }
};

let selectionListener = null;

onMounted(() => {
  if (table.value && table.value.workbook) {
    selectionListener = table.value.workbook.on("selection-change", () => {
      setTimeout(updateHistoryState, 50);
    });
  }
});

onBeforeUnmount(() => {
  if (selectionListener) {
    selectionListener();
    selectionListener = null;
  }
});

const initialData = [
  ["Category", "Input 1", "Input 2", "Formula Description", "Result"],
  ["Basic Math", 10, 20, "10 + 20", { f: "=B2+C2" }],
  ["Division by Zero", 100, 0, "100 / 0", { f: "=B3/C3" }],
  [
    "Text Functions",
    "Hello",
    "World",
    'CONCAT(B4, " ", C4)',
    { f: '=CONCAT(B4, " ", C4)' },
  ],
  ["Logic (TRUE)", 1, "Pass", 'IF(B5, C5, "Fail")', { f: '=IF(B5, C5, "No")' }],
  [
    "Logic (FALSE)",
    0,
    "Pass",
    'IF(B6, C6, "Fail")',
    { f: '=IF(B6, C6, "Fail")' },
  ],
  ["Type Error", "Text", 5, "Text / 5", { f: "=B7/C7" }],
  ["Unknown Function", "", "", "UNKNOWN()", { f: "=UNKNOWN()" }],
  ["Circular Ref", "", "", "Self Reference", { f: "=E9" }],
  [
    "Nested IF",
    5,
    10,
    "Nested Logic",
    { f: '=IF(B10>C10, "Big", CONCAT("Small-", C10))' },
  ],
  ["Range Sum", 1, 2, "Sum B2:C10", { f: "=SUM(B2:C10)" }],
  ["Text Length", "Antigravity", "", "LEN(B12)", { f: "=LEN(B12)" }],
  ["Case Conversion", "vUe sHeEt", "", "UPPER(B13)", { f: "=UPPER(B13)" }],
  ["Nested Error", 1, 1, "1 / (B14 - C14)", { f: "=1/(B14-C14)" }],
  [
    "Logic String",
    "TRUE",
    "Yes",
    'IF(B15="TRUE", C15, "No")',
    { f: '=IF(B15="TRUE", C15, "No")' },
  ],
  ["Comparison >", 10, 5, "B16 > C16", { f: "=B16>C16" }],
  ["Comparison =", 10, 10, "B17 = C17", { f: "=B17=C17" }],
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
      e: { r: 100, c: 100 },
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
      (i) => `=SUM(A${i + 1}:C${i + 1})`,
      (i) => `=AVERAGE(A${i + 1}:C${i + 1})`,
      (i) => `=MAX(A${i + 1}:C${i + 1})`,
      (i) => `=MIN(A${i + 1}:C${i + 1})`,
      (i) => `=A${i + 1}+B${i + 1}+C${i + 1}`,
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
        console.log(
          `%c[Performance] 5W 行数据（含公式）加载完成，总耗时: ${duration.toFixed(
            2
          )}ms`,
          "color: #409eff; font-weight: bold;"
        );
        loading.value = false;
      }
    }, 50);
  }
};
</script>

<style lang="scss" scoped>
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
  background-clip: text;
  -webkit-text-fill-color: transparent;
  font-family: "Outfit", "Inter", sans-serif;
  letter-spacing: -0.5px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.actions button,
.plugin-btn {
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
  font-family: "Inter", sans-serif;
  font-size: 13px;
  font-weight: 500;
  box-sizing: border-box;
}

.actions button:hover:not(:disabled),
.plugin-btn:hover:not(:disabled) {
  background: #334155;
  border-color: #64748b;
  color: #f8fafc;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.actions button:active:not(:disabled),
.plugin-btn:active:not(:disabled) {
  transform: translateY(0);
}

.actions button:disabled,
.plugin-btn:disabled {
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
  font-family: "Inter", sans-serif;
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
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
  border: 1px solid #e2e8f0;
  overflow: hidden;
  font-family: "Inter", sans-serif;
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
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02), 0 1px 2px rgba(0, 0, 0, 0.04);
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
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier,
    monospace;
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
