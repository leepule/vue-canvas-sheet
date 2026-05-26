import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Workbook } from '../../src/core/Workbook';

describe('Workbook range dependency parsing and index', () => {
  let workbook;

  beforeEach(() => {
    workbook = new Workbook();
  });

  afterEach(() => {
    workbook.destroy();
  });

  it('parses single-cell dependencies separately from ranges', () => {
    const deps = workbook.getDependencies('=A1+B2');

    expect(Array.from(deps.cells).sort()).toEqual([
      workbook._cellKey(0, 0),
      workbook._cellKey(1, 1)
    ].sort());
    expect(deps.ranges).toHaveLength(0);
  });

  it('parses small rectangular ranges without expanding every cell', () => {
    const deps = workbook.getDependencies('=SUM(A1:C3)');

    expect(deps.cells.size).toBe(0);
    expect(deps.ranges).toEqual([
      { startR: 0, endR: 2, startC: 0, endC: 2 }
    ]);
  });

  it('parses whole-column ranges into the range index', () => {
    const cellId = workbook._cellKey(0, 1);
    workbook.setCell(0, 1, { v: '=SUM(A:A)' });

    expect(workbook.rangeDependencyIndex.findDependents(0, 0).has(cellId)).toBe(true);
    expect(workbook.rangeDependencyIndex.findDependents(1048575, 0).has(cellId)).toBe(true);
    expect(workbook.rangeDependencyIndex.findDependents(0, 1).has(cellId)).toBe(false);
  });

  it('parses whole-row ranges into the range index', () => {
    const cellId = workbook._cellKey(1, 0);
    workbook.setCell(1, 0, { v: '=SUM(1:1)' });

    expect(workbook.rangeDependencyIndex.findDependents(0, 0).has(cellId)).toBe(true);
    expect(workbook.rangeDependencyIndex.findDependents(0, 16383).has(cellId)).toBe(true);
    expect(workbook.rangeDependencyIndex.findDependents(1, 0).has(cellId)).toBe(false);
  });

  it('indexes huge rectangular ranges without cell expansion', () => {
    const cellId = workbook._cellKey(0, 26);
    workbook.setCell(0, 26, { v: '=SUM(A1:Z999999)' });

    expect(workbook.rangeDependencyIndex.findDependents(999998, 25).has(cellId)).toBe(true);
    expect(workbook.rangeDependencyIndex.findDependents(999999, 25).has(cellId)).toBe(false);

    const reverseDeps = workbook.reverseDependencyMap.get(cellId);
    expect(reverseDeps.cells.size).toBe(0);
    expect(reverseDeps.ranges).toHaveLength(1);
  });

  it('does not drop dependencies for whole-row ranges spanning > 1000 rows', () => {
    // 回归用例：旧实现在 _addToLinearIndex 中按 break 截断到 1000 行内，
    // 导致远端行的依赖被丢失。修复后应提升到 l2_global。
    const cellId = workbook._cellKey(0, 26);
    // SUM(A1:Z3000) 横跨 3000 行 26 列，列方向不是 full-column；
    // 但 _addToGrid 路径无问题，构造一个 full-column 的等价大跨度场景：
    workbook.setCell(0, 26, { v: '=SUM(A1:A3000)' });

    const idx = workbook.rangeDependencyIndex;
    expect(idx.findDependents(0, 0).has(cellId)).toBe(true);
    // 远端、超出原 1000 截断点：必须仍能找到
    expect(idx.findDependents(1500, 0).has(cellId)).toBe(true);
    expect(idx.findDependents(2999, 0).has(cellId)).toBe(true);
    // 范围之外：不应命中
    expect(idx.findDependents(3000, 0).has(cellId)).toBe(false);
  });

  it('does not drop dependencies for whole-column ranges spanning > 1000 columns', () => {
    // 同上回归用例，但跨列方向（fullCols 线性索引路径）
    const cellId = workbook._cellKey(0, 0);
    // 构造横跨大量列的整行范围（跨度 > 1000 列）
    // 注意：full-row 判定要求 startC===0 && endC>=16383，这里直接调用底层 API 验证
    const idx = workbook.rangeDependencyIndex;
    idx.add({ startR: 5, endR: 5, startC: 0, endC: 1500 }, cellId);

    expect(idx.findDependents(5, 0).has(cellId)).toBe(true);
    expect(idx.findDependents(5, 1200).has(cellId)).toBe(true);
    expect(idx.findDependents(5, 1500).has(cellId)).toBe(true);
    expect(idx.findDependents(5, 1501).has(cellId)).toBe(false);
  });

  it('removes huge-span range dependencies cleanly', () => {
    // 大跨度 entry 进入 l2_global 后，remove() 应正确清理
    const cellId = workbook._cellKey(0, 0);
    const idx = workbook.rangeDependencyIndex;
    idx.add({ startR: 0, endR: 5000, startC: 0, endC: 16383 }, cellId);

    expect(idx.findDependents(2500, 100).has(cellId)).toBe(true);

    idx.remove(cellId);
    expect(idx.findDependents(2500, 100).has(cellId)).toBe(false);
    expect(idx.l2_global.size).toBe(0);
  });

  it('removes range dependencies when formula is overwritten', () => {
    const cellId = workbook._cellKey(0, 1);
    workbook.setCell(0, 1, { v: '=SUM(A:A)' });
    expect(workbook.rangeDependencyIndex.findDependents(10, 0).has(cellId)).toBe(true);

    workbook.setCell(0, 1, { v: 100 });

    expect(workbook.rangeDependencyIndex.findDependents(10, 0).has(cellId)).toBe(false);
    expect(workbook.reverseDependencyMap.get(cellId)).toBeUndefined();
  });
});
