import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Workbook } from '../../src/core/Workbook';
import { cellKeyNumeric } from '../../src/core/data/CellKey';


describe('IncrementalCalculationEngine', () => {
  let workbook;

  beforeEach(() => {
    workbook = new Workbook();
    workbook.calcEngine.batchDelay = 0;
  });

  afterEach(() => {
    workbook.destroy();
  });

  it('marks direct and range dependents dirty from one edit path', () => {
    workbook.setCell(0, 0, { v: 1 });
    workbook.setCell(0, 1, { v: '=A1+1' });
    workbook.setCell(0, 2, { v: '=SUM(A:A)' });

    workbook.getCell(0, 1).dirty = false;
    workbook.getCell(0, 2).dirty = false;

    const triggerSpy = vi.spyOn(workbook, 'triggerRecalc');
    workbook.setCell(0, 0, { v: 2 });

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(workbook.getCell(0, 1).dirty).toBe(true);
    expect(workbook.getCell(0, 2).dirty).toBe(true);
  });

  it('collects range dependents in the dirty graph', () => {
    const formulaNumeric = cellKeyNumeric(0, 1);

    workbook.setCell(0, 1, { v: '=SUM(A:A)' });
    workbook.calcEngine.dirtyBitset.clear();
    workbook.calcEngine.markDirty(workbook._cellKey(999, 0));

    const { queue } = workbook.calcEngine._collectDirtyGraph();

    expect(queue).toContain(cellKeyNumeric(999, 0));
    expect(queue).toContain(formulaNumeric);
  });

  it('tracks cache hit rate and batch stats', () => {
    const numericKey = cellKeyNumeric(0, 1);
    workbook.setCell(0, 0, { v: 10 });
    workbook.setCell(0, 1, { v: '=A1+1' });

    workbook.calcEngine.dirtyBitset.clear();
    workbook.getCell(0, 1).dirty = false;
    workbook.calcEngine._cacheResult(0, 1, 11, '=A1+1');
    workbook.calcEngine._calculateBatch([numericKey]);

    const stats = workbook.calcEngine.getCacheStats();
    expect(stats.cacheHits).toBe(1);
    expect(stats.cacheMisses).toBe(0);
    expect(stats.hitRate).toBe(1);
    expect(stats.lastQueueSize).toBe(1);
    expect(workbook.getCalculationStats().hitRate).toBe(1);
  });

  it('builds worker payload from dirty formula dependencies instead of all cells', () => {
    workbook.setCell(0, 0, { v: 1 });
    workbook.setCell(0, 1, { v: 2 });
    workbook.setCell(10, 10, { v: 'unrelated' });
    workbook.setCell(0, 2, { v: '=A1+B1' });

    const payload = workbook._buildFormulaWorkerPayload([workbook._cellKey(0, 2)]);

    expect(payload.formulas).toHaveLength(1);
    expect(Object.keys(payload.task.data).sort()).toEqual([
      workbook._cellKey(0, 0),
      workbook._cellKey(0, 1),
      workbook._cellKey(0, 2)
    ].sort());
    expect(payload.task.data[workbook._cellKey(10, 10)]).toBeUndefined();
    expect(payload.stats.cellCount).toBe(3);
  });

  describe('DirtyBitset AABB + 版本号', () => {
    it('AABB 早退：脏区与查询范围不相交时 hasAnyInRange 直接返回 false', () => {
      const bs = workbook.calcEngine.dirtyBitset;
      bs.clear();
      bs.add(2, 3);
      bs.add(2, 5);

      // 完全位于 bbox 之外
      expect(bs.hasAnyInRange(100, 200, 100, 200)).toBe(false);
      expect(bs.hasAnyInRange(0, 0, 0, 10)).toBe(false);
      expect(bs.hasAnyInRange(2, 2, 6, 100)).toBe(false);

      // 与 bbox 相交
      expect(bs.hasAnyInRange(0, 5, 0, 10)).toBe(true);
      expect(bs.hasAnyInRange(2, 2, 5, 5)).toBe(true);

      // 与 bbox 相交但实际无脏位（应回退到位图扫描后返回 false）
      expect(bs.hasAnyInRange(2, 2, 4, 4)).toBe(false);
    });

    it('版本号在 add/clear 时自增，重复 add 同一位不递增', () => {
      const bs = workbook.calcEngine.dirtyBitset;
      bs.clear();
      const v0 = bs.version;

      bs.add(0, 0);
      const v1 = bs.version;
      expect(v1).toBeGreaterThan(v0);

      // 重复 add 同一位：版本号保持不变
      bs.add(0, 0);
      expect(bs.version).toBe(v1);

      bs.add(0, 1);
      expect(bs.version).toBeGreaterThan(v1);

      const beforeClear = bs.version;
      bs.clear();
      expect(bs.version).toBeGreaterThan(beforeClear);
    });

    it('_isCacheValid 版本号快路径：版本号未变直接返回 true，无需检查 ranges', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(1, 0, { v: '=SUM(A:A)' });

      const engine = workbook.calcEngine;
      engine.dirtyBitset.clear();
      engine._cacheResult(1, 0, 1, '=SUM(A:A)');

      const cacheKey = engine._getCacheKey(1, 0);
      const cached = engine.calcCache.get(cacheKey);
      const stampedVersion = cached.dirtyVersion;
      expect(stampedVersion).toBe(engine.dirtyBitset.version);

      // 监控 hasAnyInRange 是否被调用
      const spy = vi.spyOn(engine.dirtyBitset, 'hasAnyInRange');
      const ok = engine._isCacheValid(cached, 1, 0);
      expect(ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('_isCacheValid 校验通过后回写 dirtyVersion，再次校验走快路径', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 5, { v: '=SUM(A1:A10)' }); // 不依赖 B 列

      const engine = workbook.calcEngine;
      engine.dirtyBitset.clear();
      engine._cacheResult(0, 5, 1, '=SUM(A1:A10)');

      const cacheKey = engine._getCacheKey(0, 5);
      const cached = engine.calcCache.get(cacheKey);
      const oldVersion = cached.dirtyVersion;

      // 改动 B 列（与 A1:A10 不相交），版本号上升但缓存仍应有效
      engine.dirtyBitset.add(0, 1);
      const newVersion = engine.dirtyBitset.version;
      expect(newVersion).toBeGreaterThan(oldVersion);

      const spy = vi.spyOn(engine.dirtyBitset, 'hasAnyInRange');
      const ok1 = engine._isCacheValid(cached, 0, 5);
      expect(ok1).toBe(true);
      // 第一次：版本号不匹配走完整路径，hasAnyInRange 被调用（AABB 内部会早退）
      expect(spy).toHaveBeenCalled();
      // 完整校验通过后 dirtyVersion 已回写
      expect(cached.dirtyVersion).toBe(newVersion);

      // 第二次：版本号已匹配，应走快路径
      spy.mockClear();
      const ok2 = engine._isCacheValid(cached, 0, 5);
      expect(ok2).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('range 依赖被新脏单元格命中时，缓存正确失效', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 5, { v: '=SUM(A1:A10)' });

      const engine = workbook.calcEngine;
      engine.dirtyBitset.clear();
      engine._cacheResult(0, 5, 1, '=SUM(A1:A10)');

      const cached = engine.calcCache.get(engine._getCacheKey(0, 5));

      // 在依赖范围内引入脏单元格
      engine.dirtyBitset.add(3, 0);
      expect(engine._isCacheValid(cached, 0, 5)).toBe(false);
    });
  });
});
