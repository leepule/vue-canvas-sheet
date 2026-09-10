/**
 * E2E 测试预设数据集
 */

/** 小型统一网格 — 基本交互测试 */
export const SMALL_DATASET: any[][] = [
  ['Name',   'Age', 'Score', 'Grade', 'Status'],
  ['Alice',  25,    95,      'A',     'Active'],
  ['Bob',    30,    87,      'B',     'Active'],
  ['Carol',  28,    92,      'A',     'Inactive'],
  ['Dave',   35,    78,      'C',     'Active'],
  ['Eve',    22,    88,      'B',     'Active'],
  ['Frank',  40,    65,      'D',     'Inactive'],
  ['Grace',  27,    91,      'A',     'Active'],
  ['Henry',  33,    73,      'C',     'Active'],
  ['Iris',   29,    84,      'B',     'Inactive'],
];

/** 含公式的数据集 — 编辑/计算测试 */
export const FORMULA_DATASET: any[][] = [
  ['Item',   'Price', 'Qty',  'Total'],
  ['Alpha',  10,      5,      { f: '=B2*C2' }],
  ['Beta',   20,      3,      { f: '=B3*C3' }],
  ['Gamma',  15,      8,      { f: '=B4*C4' }],
  ['Delta',  12,      10,     { f: '=B5*C5' }],
  ['Epsilon', 8,      6,      { f: '=SUM(B2:B5)' }],
];

/** 最小 3x3 网格 — 视觉回归基线 */
export const VISUAL_BASELINE_DATASET: any[][] = [
  ['A', 'B', 'C'],
  ['1', '2', '3'],
  ['X', 'Y', 'Z'],
];

/**
 * 生成大规模数据集
 */
export function generateLargeDataset(rows: number, cols: number): any[][] {
  const data: any[][] = [];
  const header = Array.from({ length: cols }, (_, i) => `Col${i + 1}`);
  data.push(header);
  for (let r = 1; r < rows; r++) {
    const row: any[] = [];
    for (let c = 0; c < cols; c++) {
      if (c === 0) row.push(`Row${r}`);
      else row.push(`R${r}C${c}`);
    }
    data.push(row);
  }
  return data;
}

/** 中等数据集 — 滚动测试（200 行 × 15 列） */
export const MEDIUM_DATASET: any[][] = generateLargeDataset(200, 15);

/** 大数据集 — 滚动和渐进渲染测试（1000 行 × 20 列） */
export const LARGE_DATASET: any[][] = generateLargeDataset(1000, 20);

/** 所有预设数据集的 Map */
export const TEST_DATASETS = {
  small: SMALL_DATASET,
  formulas: FORMULA_DATASET,
  visualBaseline: VISUAL_BASELINE_DATASET,
  medium: MEDIUM_DATASET,
  large: LARGE_DATASET,
} as const;
