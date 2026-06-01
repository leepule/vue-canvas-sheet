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
    workbook.calcEngine.markDirtyRC(999, 0);

    const { queue } = workbook.calcEngine._collectDirtyGraph();

    expect(queue).toContain(cellKeyNumeric(999, 0));
    expect(queue).toContain(formulaNumeric);
  });

  describe('增量 numeric 依赖索引 (_numericDepIndex)', () => {
    it('设置公式后在 numeric 索引中登记反向出边', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 1, { v: '=A1+1' });

      const a1 = cellKeyNumeric(0, 0);
      const b1 = cellKeyNumeric(0, 1);
      const index = workbook._numericDepIndex;

      expect(index.get(a1)).toBeInstanceOf(Set);
      expect(index.get(a1).has(b1)).toBe(true);
    });

    it('清除公式后移除对应出边，源条目变空时删除', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 1, { v: '=A1+1' });

      const a1 = cellKeyNumeric(0, 0);
      expect(workbook._numericDepIndex.has(a1)).toBe(true);

      // 用普通值覆盖公式，应清掉 A1 的唯一依赖者
      workbook.setCell(0, 1, { v: 42 });
      expect(workbook._numericDepIndex.has(a1)).toBe(false);
    });

    it('改写公式依赖时旧出边被回收、新出边被登记', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(1, 0, { v: 2 });
      workbook.setCell(0, 1, { v: '=A1+1' }); // 依赖 A1

      const a1 = cellKeyNumeric(0, 0);
      const a2 = cellKeyNumeric(1, 0);
      const b1 = cellKeyNumeric(0, 1);

      expect(workbook._numericDepIndex.get(a1).has(b1)).toBe(true);

      // 改为依赖 A2
      workbook.setCell(0, 1, { v: '=A2+1' });

      expect(workbook._numericDepIndex.has(a1)).toBe(false);
      expect(workbook._numericDepIndex.get(a2).has(b1)).toBe(true);
    });

    it('标脏沿增量索引传播到依赖者（无需全量重建）', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 1, { v: '=A1+1' });
      workbook.setCell(0, 2, { v: '=B1+1' });

      workbook.calcEngine.dirtyBitset.clear();
      workbook.calcEngine.markDirtyRC(0, 0); // 改 A1

      const { queue } = workbook.calcEngine._collectDirtyGraph();
      expect(queue).toContain(cellKeyNumeric(0, 1)); // B1
      expect(queue).toContain(cellKeyNumeric(0, 2)); // C1（间接依赖）
    });

    it('compactDependencyGraph 清理孤儿条目时同步删除 numeric 索引', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 1, { v: '=A1+1' });

      const a1 = cellKeyNumeric(0, 0);
      // 直接删除公式单元格使依赖图产生孤儿条目（绕过 _updateDependencyMap）
      workbook._dataMatrix.delete(0, 1);
      workbook.calcEngine.compactDependencyGraph();

      expect(workbook.dependencyMap.has(workbook._cellKey(0, 0))).toBe(false);
      expect(workbook._numericDepIndex.has(a1)).toBe(false);
    });

    it('rebuildDependencyMap 后 numeric 索引与 dependencyMap 一致', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 1, { v: '=A1+1' });

      workbook.rebuildDependencyMap();

      const a1 = cellKeyNumeric(0, 0);
      const b1 = cellKeyNumeric(0, 1);
      expect(workbook._numericDepIndex.get(a1).has(b1)).toBe(true);
    });
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

  describe('缓存依赖解析复用 (_resolveDependencies)', () => {
    it('缓存时复用 reverseDependencyMap，不再重新解析公式', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 1, { v: 2 });
      workbook.setCell(0, 2, { v: '=A1+B1' });

      const engine = workbook.calcEngine;
      const spy = vi.spyOn(workbook, 'getDependencies');
      engine._cacheResult(0, 2, 3, '=A1+B1');

      // 反向依赖已存在 → 不应触发重新解析
      expect(spy).not.toHaveBeenCalled();

      const cached = engine.calcCache.get(engine._getCacheKey(0, 2));
      const cellIds = [...cached.dependencies.cells];
      expect(cellIds).toContain(workbook._cellKey(0, 0));
      expect(cellIds).toContain(workbook._cellKey(0, 1));
      spy.mockRestore();
    });

    it('依赖与反向依赖映射内容等价', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 5, { v: '=SUM(A1:A10)+A1' });

      const engine = workbook.calcEngine;
      engine._cacheResult(0, 5, 1, '=SUM(A1:A10)+A1');
      const cached = engine.calcCache.get(engine._getCacheKey(0, 5));
      const fresh = workbook.getDependencies('=SUM(A1:A10)+A1');

      expect([...cached.dependencies.cells].sort()).toEqual([...fresh.cells].sort());
      expect(cached.dependencies.ranges.length).toBe(fresh.ranges.length);
    });

    it('缓存依赖是浅克隆，compact 原地删除不污染缓存快照', () => {
      workbook.setCell(0, 0, { v: 1 });
      workbook.setCell(0, 1, { v: '=A1+1' });

      const engine = workbook.calcEngine;
      engine.dirtyBitset.clear();
      engine._cacheResult(0, 1, 2, '=A1+1');
      const cached = engine.calcCache.get(engine._getCacheKey(0, 1));
      expect([...cached.dependencies.cells]).toContain(workbook._cellKey(0, 0));

      // 删除公式单元格并 compact，使 reverseDependencyMap 中的 Set 被原地修改/删除
      workbook._dataMatrix.delete(0, 1);
      engine.compactDependencyGraph();

      // 缓存快照应保留克隆的依赖，不被 compact 影响
      expect([...cached.dependencies.cells]).toContain(workbook._cellKey(0, 0));
    });

    it('反向依赖缺失时回退到完整解析', () => {
      const engine = workbook.calcEngine;
      const spy = vi.spyOn(workbook, 'getDependencies');

      // 未经 setCell 注册依赖，直接缓存 → reverseDependencyMap 无此项
      engine._cacheResult(5, 5, 99, '=A1+1');

      expect(spy).toHaveBeenCalledWith('=A1+1');
      spy.mockRestore();
    });
  });
});
