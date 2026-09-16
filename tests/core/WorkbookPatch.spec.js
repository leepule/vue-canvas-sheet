import { Workbook } from '@/core/Workbook';
import { Events } from '@/core/events/EventEmitter';
import { SheetError } from '@/core/data/SheetError';
import { createOrdersFixture } from '../fixtures/ai-orders';

describe('Workbook atomic cell patch', () => {
  let workbook;
  let events;

  beforeEach(() => {
    workbook = new Workbook({ enableWasm: false, enablePersistence: false });
    workbook.setData(createOrdersFixture());
    events = [];
    workbook.on(Events.MUTATION_COMMITTED, event => events.push(event));
  });

  afterEach(() => {
    vi.clearAllTimers();
    workbook._dirtyCells?.clear();
    workbook._storage = null;
    workbook.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function formulaPatch(mutationId = 'patch-1', expectedRevision = workbook.getContentRevision()) {
    return {
      mutationId,
      sheetId: workbook.activeSheetId,
      expectedRevision,
      changes: [1, 2, 3].map(r => ({
        r,
        c: 2,
        before: null,
        after: { f: `=A${r + 1}*B${r + 1}` }
      }))
    };
  }

  function formulaValues() {
    return [1, 2, 3].map(r => workbook.getCellValue(r, 2));
  }

  test('applies three cells as one patch, history entry, and revision', () => {
    vi.useFakeTimers();
    workbook._storage = {};
    const previousRevision = workbook.getContentRevision();
    const historySize = workbook.history.undoStackSize;

    const result = workbook.applyCellPatch(formulaPatch());

    expect(result).toEqual({
      mutationId: 'patch-1',
      previousRevision,
      revision: previousRevision + 1,
      changedCells: 3
    });
    expect(workbook.history.undoStackSize).toBe(historySize + 1);
    expect(workbook.history.undoStack.last().type).toBe('batch-set-cell');
    expect(workbook.history.undoStack.last().changes).toHaveLength(3);
    expect(workbook._dirtyCells.size).toBe(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mutationId: 'patch-1',
      previousRevision,
      revision: previousRevision + 1,
      source: 'patch',
      changedCells: 3
    });

    workbook.recalcAll({ useWorker: false });
    expect(formulaValues()).toEqual([20, 15, 32]);
    vi.clearAllTimers();
  });

  test('one undo restores three values and styles, and redo restores the patch', () => {
    const style = { fontWeight: 'bold', color: '#123456' };
    workbook.setStyle({ s: { r: 1, c: 2 }, e: { r: 3, c: 2 } }, style);
    const historySize = workbook.history.undoStackSize;
    const patch = {
      mutationId: 'styled-patch',
      sheetId: workbook.activeSheetId,
      expectedRevision: workbook.getContentRevision(),
      changes: [1, 2, 3].map(r => ({
        r,
        c: 2,
        before: { s: style },
        after: { f: `=A${r + 1}*B${r + 1}`, s: style }
      }))
    };

    workbook.applyCellPatch(patch);
    expect(workbook.history.undoStackSize).toBe(historySize + 1);

    workbook.undo();
    for (const r of [1, 2, 3]) {
      expect(workbook.getCell(r, 2).f).toBeFalsy();
      expect(workbook.getCell(r, 2).v).toBeFalsy();
      expect(workbook.getStyle(r, 2)).toEqual(style);
    }

    workbook.redo();
    workbook.recalcAll({ useWorker: false });
    expect(formulaValues()).toEqual([20, 15, 32]);
    for (const r of [1, 2, 3]) {
      expect(workbook.getStyle(r, 2)).toEqual(style);
    }
  });

  test('rolls back everything when the second cell write throws', () => {
    workbook._storage = {};
    const revision = workbook.getContentRevision();
    const dataVersion = workbook.dataVersion;
    const historySize = workbook.history.undoStackSize;
    const dependencySize = workbook.dependencyMap.size;
    const reverseDependencySize = workbook.reverseDependencyMap.size;
    const originalSet = workbook._dataMatrix.set.bind(workbook._dataMatrix);
    let calls = 0;
    const setSpy = vi.spyOn(workbook._dataMatrix, 'set').mockImplementation((r, c, value) => {
      calls++;
      if (calls === 2) throw new Error('injected second-cell failure');
      return originalSet(r, c, value);
    });

    expect(() => workbook.applyCellPatch(formulaPatch('failed-patch'))).toThrow('injected second-cell failure');
    expect(setSpy).toHaveBeenCalledTimes(2);
    expect([1, 2, 3].map(r => workbook.getCell(r, 2))).toEqual([null, null, null]);
    expect(workbook.getContentRevision()).toBe(revision);
    expect(workbook.dataVersion).toBe(dataVersion);
    expect(workbook.history.undoStackSize).toBe(historySize);
    expect(workbook._dirtyCells.size).toBe(0);
    expect(workbook.calcEngine.dirtyBitset.size).toBe(0);
    expect(workbook.dependencyMap.size).toBe(dependencySize);
    expect(workbook.reverseDependencyMap.size).toBe(reverseDependencySize);
    expect(events).toHaveLength(0);
  });

  test('returns the original result for an identical mutation retry', () => {
    const patch = formulaPatch('idempotent-patch');
    const result = workbook.applyCellPatch(patch);
    workbook.setCell(1, 0, { v: 99 });

    expect(workbook.applyCellPatch(patch)).toEqual(result);
    expect(workbook.getCell(1, 2).f).toBe('=A2*B2');
  });

  test('rejects the same mutation ID with different content', () => {
    workbook.applyCellPatch(formulaPatch('same-id'));
    const different = formulaPatch('same-id');
    different.changes[0].after = { f: '=A2+B2' };

    expect(() => workbook.applyCellPatch(different)).toThrow(SheetError);
    try {
      workbook.applyCellPatch(different);
    } catch (error) {
      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.details.reason).toBe('MUTATION_ID_CONFLICT');
    }
  });

  test.each([
    ['read only', patch => {
      workbook.readOnly = true;
      return [patch, 'READ_ONLY'];
    }],
    ['wrong sheet', patch => {
      const sheetId = workbook.addSheet('Other');
      workbook.switchSheet(sheetId);
      return [patch, 'SHEET_MISMATCH'];
    }],
    ['stale revision', patch => [{ ...patch, expectedRevision: patch.expectedRevision + 1 }, 'VERSION_CONFLICT']],
    ['old value mismatch', patch => [
      { ...patch, changes: patch.changes.map(change => ({ ...change, before: { v: 'wrong' } })) },
      'BEFORE_MISMATCH'
    ]],
    ['invalid coordinate', patch => [
      { ...patch, changes: [{ r: -1, c: 0, before: null, after: { v: 1 } }] },
      'INVALID_COORDINATE'
    ]],
    ['duplicate target', patch => [
      { ...patch, changes: [{ r: 1, c: 2, before: null, after: { v: 1 } }, { r: 1, c: 2, before: null, after: { v: 2 } }] },
      'DUPLICATE_TARGET'
    ]],
    ['patch too large', patch => [
      { ...patch, changes: new Array(5001).fill({ r: 0, c: 0, before: null, after: { v: 1 } }) },
      'PATCH_TOO_LARGE'
    ]],
    ['invalid formula', patch => [
      { ...patch, changes: [{ r: 1, c: 2, before: null, after: { f: '=NOW()' } }] },
      'INVALID_FORMULA'
    ]]
  ])('rejects a patch with %s before writing', (_name, prepare) => {
    const [patch, reason] = prepare(formulaPatch(`rejected-${Math.random()}`));
    const revision = workbook.getContentRevision();
    const historySize = workbook.history.undoStackSize;
    events.length = 0;

    expect(() => workbook.applyCellPatch(patch)).toThrow(SheetError);
    try {
      workbook.applyCellPatch(patch);
    } catch (error) {
      expect(error.details.reason).toBe(reason);
    }
    expect(workbook.getContentRevision()).toBe(revision);
    expect(workbook.history.undoStackSize).toBe(historySize);
    expect(events).toHaveLength(0);
  });

  test('replaces a formula with text and restores the formula on undo', () => {
    workbook.setCell(1, 2, { v: '=A2*B2' });
    workbook.recalcAll({ useWorker: false });
    const revision = workbook.getContentRevision();
    const historySize = workbook.history.undoStackSize;
    const patch = {
      mutationId: 'formula-to-text',
      sheetId: workbook.activeSheetId,
      expectedRevision: revision,
      changes: [{
        r: 1,
        c: 2,
        before: { f: '=A2*B2' },
        after: { v: 'text value' }
      }]
    };

    workbook.applyCellPatch(patch);
    expect(workbook.getCell(1, 2)).toMatchObject({ v: 'text value', dirty: false });
    expect(workbook.getCell(1, 2).f).toBeUndefined();
    expect(workbook.history.undoStackSize).toBe(historySize + 1);

    workbook.undo();
    expect(workbook.getCell(1, 2).f).toBe('=A2*B2');
    expect(workbook.getCellValue(1, 2)).toBe(20);
  });
});
