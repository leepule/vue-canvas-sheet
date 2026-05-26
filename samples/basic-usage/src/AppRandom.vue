<template>
  <div class="random-demo">
    <div class="header">
      <h1>Vue Canvas Sheet - 随机样式 Demo</h1>
      <div class="controls">
        <div class="ctrl-group">
          <label>行数</label>
          <input type="number" v-model.number="rows" min="5" max="500" />
        </div>
        <div class="ctrl-group">
          <label>列数</label>
          <input type="number" v-model.number="cols" min="3" max="30" />
        </div>
        <div class="ctrl-group">
          <label>样式密度</label>
          <input type="range" v-model.number="density" min="0" max="100" />
          <span class="hint">{{ density }}%</span>
        </div>
        <button class="primary" @click="generate">🎲 重新生成</button>
        <button @click="resetStyles">🧹 清空样式</button>
        <button @click="addBorders">▦ 给所有格加边框</button>
        <button @click="addFormula">∑ 追加汇总行</button>
        <div class="divider"></div>
        <span class="stat">行 × 列 = {{ rows }} × {{ cols }} = {{ rows * cols }} 单元格</span>
      </div>
    </div>

    <div class="sheet-wrapper">
      <TableDesigner ref="table" :initial-data="initialData" :reload-key="reloadKey" />
    </div>
  </div>
</template>

<script setup>
import { ref, shallowRef, onMounted, nextTick } from 'vue';
import { TableDesigner } from 'vue-canvas-sheet';

const table = ref(null);
const rows = ref(30);
const cols = ref(8);
const density = ref(60);
const reloadKey = ref(0);
const initialData = shallowRef([]);

const HEADERS = ['名称', '部门', '岗位', '基础薪资', '奖金', '小计', '完成率', '备注'];
const NAMES = ['赵雷', '钱诗', '孙瑶', '李娜', '周扬', '吴桐', '郑亮', '王朗', '冯婷', '陈昊', '楚河', '魏然'];
const DEPTS = ['研发', '产品', '设计', '运营', '销售', '财务', '行政', 'HR'];
const ROLES = ['工程师', '主管', '专家', '经理', '总监', '助理'];
const NOTES = ['优秀', '继续努力', '请重点关注', '本月之星', '需要补训', '稳定输出', ''];
const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#0ea5e9', '#22c55e'];
const BG_TINTS = ['#fef3c7', '#dcfce7', '#dbeafe', '#fce7f3', '#ede9fe', '#fee2e2', '#f1f5f9', '#fff7ed'];
const FONT_SIZES = [12, 13, 14, 15, 16];
const ALIGNS = ['left', 'center', 'right'];
const VALIGNS = ['top', 'middle', 'bottom'];

function rand(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr[rand(arr.length)]; }
function chance(p) { return Math.random() * 100 < p; }

function randomStyle() {
  const s = {};
  const p = density.value;

  if (chance(p * 0.6)) s.bold = true;
  if (chance(p * 0.3)) s.italic = true;
  if (chance(p * 0.15)) s.td = 'line-through';
  if (chance(p * 0.7)) s.color = pick(COLORS);
  if (chance(p * 0.5)) s.bg = pick(BG_TINTS);
  if (chance(p * 0.5)) s.fontSize = pick(FONT_SIZES);
  if (chance(p * 0.4)) s.align = pick(ALIGNS);
  if (chance(p * 0.25)) s.valign = pick(VALIGNS);
  if (chance(p * 0.1)) s.wrap = true;

  return Object.keys(s).length > 0 ? s : null;
}

function makeHeader(c) {
  return {
    v: HEADERS[c] || `列${c + 1}`,
    s: {
      bold: true,
      align: 'center',
      bg: '#1e293b',
      color: '#ffffff',
      fontSize: 14,
    },
  };
}

function makeCell(r, c) {
  let value;
  switch (c) {
    case 0: value = pick(NAMES); break;
    case 1: value = pick(DEPTS); break;
    case 2: value = pick(ROLES); break;
    case 3: value = 5000 + rand(15000); break;
    case 4: value = rand(8000); break;
    case 5: value = { f: `=D${r + 2}+E${r + 2}` }; break;
    case 6: value = Math.round(Math.random() * 100) / 100; break;
    case 7: value = pick(NOTES); break;
    default: value = rand(1000);
  }

  const cell = typeof value === 'object' && value !== null
    ? { ...value }
    : { v: value };

  if (c === 6) {
    cell.s = { ...(cell.s || {}), fmt: 'percent', decimals: 1, align: 'center' };
  } else if (c === 3 || c === 4 || c === 5) {
    cell.s = { ...(cell.s || {}), fmt: 'comma', decimals: 0, align: 'right' };
  }

  const extra = randomStyle();
  if (extra) cell.s = { ...(cell.s || {}), ...extra };

  return cell;
}

function buildMatrix() {
  const totalCols = Math.min(cols.value, 30);
  const totalRows = Math.min(rows.value, 500);

  const header = [];
  for (let c = 0; c < totalCols; c++) {
    header.push(makeHeader(c));
  }

  const matrix = [header];
  for (let r = 0; r < totalRows; r++) {
    const row = [];
    for (let c = 0; c < totalCols; c++) {
      row.push(makeCell(r, c));
    }
    matrix.push(row);
  }
  return matrix;
}

function generate() {
  initialData.value = buildMatrix();
  reloadKey.value++;
}

function resetStyles() {
  const wb = table.value?.workbook;
  if (!wb) return;
  wb.clearCells({ s: { r: 0, c: 0 }, e: { r: rows.value, c: cols.value - 1 } });
  generate();
}

function addBorders() {
  const wb = table.value?.workbook;
  if (!wb) return;
  wb.setBorder(
    { s: { r: 0, c: 0 }, e: { r: rows.value, c: cols.value - 1 } },
    'all',
    '#cbd5e1',
    'solid'
  );
}

function addFormula() {
  const wb = table.value?.workbook;
  if (!wb) return;
  const lastDataRow = rows.value;
  const totalRow = lastDataRow + 1;

  wb.setCell(totalRow, 0, {
    v: '合计',
    s: { bold: true, align: 'right', bg: '#0f172a', color: '#fde68a' },
  });
  if (cols.value > 3) {
    wb.setCell(totalRow, 3, {
      f: `=SUM(D2:D${lastDataRow + 1})`,
      s: { bold: true, fmt: 'comma', decimals: 0, bg: '#fef3c7' },
    });
  }
  if (cols.value > 4) {
    wb.setCell(totalRow, 4, {
      f: `=SUM(E2:E${lastDataRow + 1})`,
      s: { bold: true, fmt: 'comma', decimals: 0, bg: '#fef3c7' },
    });
  }
  if (cols.value > 5) {
    wb.setCell(totalRow, 5, {
      f: `=SUM(F2:F${lastDataRow + 1})`,
      s: { bold: true, fmt: 'comma', decimals: 0, bg: '#fde68a' },
    });
  }
  if (cols.value > 6) {
    wb.setCell(totalRow, 6, {
      f: `=AVERAGE(G2:G${lastDataRow + 1})`,
      s: { bold: true, fmt: 'percent', decimals: 1, align: 'center', bg: '#fef3c7' },
    });
  }

  wb.recalcAll({ useWorker: true });
}

onMounted(async () => {
  generate();
  await nextTick();
  table.value?.workbook?.enableWorker();
});
</script>

<style scoped>
.random-demo {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.header {
  padding: 12px 24px;
  background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
  border-bottom: 1px solid #334155;
  color: #f1f5f9;
  flex-shrink: 0;
}

.header h1 {
  margin: 0 0 10px 0;
  font-size: 18px;
  font-weight: 700;
  background: linear-gradient(to right, #fbbf24, #f472b6);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.ctrl-group {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(30, 41, 59, 0.6);
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #334155;
}

.ctrl-group label {
  color: #94a3b8;
  font-size: 12px;
  font-weight: 500;
}

.ctrl-group input[type='number'] {
  width: 56px;
  height: 26px;
  background: #0f172a;
  border: 1px solid #334155;
  color: #f1f5f9;
  border-radius: 4px;
  padding: 0 6px;
  font-size: 13px;
  outline: none;
}

.ctrl-group input[type='number']:focus {
  border-color: #3b82f6;
}

.ctrl-group input[type='range'] {
  width: 100px;
  accent-color: #3b82f6;
}

.hint {
  color: #64748b;
  font-size: 12px;
  min-width: 32px;
}

.controls button {
  height: 32px;
  padding: 0 14px;
  background: #1e293b;
  color: #cbd5e1;
  border: 1px solid #475569;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.controls button:hover {
  background: #334155;
  color: #f8fafc;
  border-color: #64748b;
}

.controls button.primary {
  background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
  color: #fff;
  border-color: #60a5fa;
}

.controls button.primary:hover {
  background: linear-gradient(135deg, #60a5fa 0%, #2563eb 100%);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
}

.divider {
  width: 1px;
  height: 20px;
  background: #334155;
  margin: 0 4px;
}

.stat {
  color: #64748b;
  font-size: 12px;
  font-family: 'SFMono-Regular', Consolas, monospace;
}

.sheet-wrapper {
  flex: 1;
  overflow: hidden;
  background: #f8fafc;
}
</style>
