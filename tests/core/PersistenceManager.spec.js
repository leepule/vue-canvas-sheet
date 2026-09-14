/**
 * PersistenceManager 持久化恢复、自动保存与安全关闭回归测试。
 */

import { Workbook } from '@/core/Workbook';

/**
 * 构造一个最小的 storage mock，模拟 IndexedDBStorage.exportSheet 的返回结构。
 * 保存的公式单元格形如 { v: <计算结果>, f: <公式串> }，与 persist() 写出的结构一致。
 */
function makeMockStorage() {
  return {
    close: () => {},
    exportSheet: async () => ({
      config: {
        rowCount: 100,
        colCount: 26,
        colWidths: {},
        rowHeights: {},
        merges: [],
        mergeMap: {},
        defaultColWidth: 80,
        defaultRowHeight: 25,
      },
      data: {
        '0-0': { v: 10 },               // A1 = 10
        '0-1': { v: 20 },               // B1 = 20
        '1-0': { v: 30, f: '=A1+B1' },  // A2 = A1+B1（持久化时已算得 30）
      },
    }),
  };
}

describe('PersistenceManager.loadFromStorage 数据恢复', () => {
  let workbook;

  beforeEach(() => {
    workbook = new Workbook();
  });

  afterEach(() => {
    workbook.destroy();
  });

  test('加载后应保留公式单元格的 f（公式不被剥离）', async () => {
    workbook._storage = makeMockStorage();
    workbook.enablePersistenceStorage({ sheetId: 'default' });

    const ok = await workbook.loadFromStorage('default');
    expect(ok).toBe(true);

    const a2 = workbook.getCell(1, 0);
    expect(a2).toBeTruthy();
    expect(a2.f).toBe('=A1+B1');
  });

  test('加载后修改前置单元格应自动引发依赖单元格的重算', async () => {
    workbook._storage = makeMockStorage();
    workbook.enablePersistenceStorage({ sheetId: 'default' });

    await workbook.loadFromStorage('default');

    // 恢复时的初始结果
    expect(workbook.formulaEvaluator.getCellValue(1, 0)).toBe(30);

    // 修改前置单元格 A1：10 -> 50
    workbook.setCell(0, 0, { v: 50 });

    // 依赖图若已重建，A2 应重算为 50 + 20 = 70
    expect(workbook.formulaEvaluator.getCellValue(1, 0)).toBe(70);
  });
});

function makeWritableStorage(overrides = {}) {
  const metadata = new Map();
  return {
    close: vi.fn(),
    exportSheet: vi.fn().mockResolvedValue(null),
    getMetadata: vi.fn(async key => (metadata.has(key) ? metadata.get(key) : null)),
    saveDiffs: vi.fn().mockResolvedValue(undefined),
    saveMetadata: vi.fn(async (key, value) => {
      metadata.set(key, value);
    }),
    importSheet: vi.fn().mockResolvedValue(undefined),
    metadata,
    ...overrides,
  };
}

describe('PersistenceManager 自动保存与安全关闭', () => {
  let workbook;

  afterEach(() => {
    workbook?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('单格、清空、批量和撤销重做在同一 debounce 窗口只保存一次', async () => {
    vi.useFakeTimers();
    const storage = makeWritableStorage();
    workbook = new Workbook();
    workbook._storage = storage;
    workbook.enablePersistenceStorage({ sheetId: 'sheet-1' });

    workbook.setCell(0, 0, { v: 'temporary' });
    workbook.clearCells({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } });
    workbook.bulkSetCells([{ r: 0, c: 1, val: { v: 'batch' } }]);
    workbook.undo();
    workbook.redo();

    await vi.advanceTimersByTimeAsync(999);
    expect(storage.saveDiffs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(storage.saveDiffs).toHaveBeenCalledTimes(1);
    const savedDiffs = storage.saveDiffs.mock.calls[0][1];
    expect(savedDiffs.get('0-0')).toBeNull();
    expect(savedDiffs.get('0-1')).toMatchObject({ v: 'batch' });
  });

  test('保存失败时 close 保留脏数据且不销毁工作簿', async () => {
    const storage = makeWritableStorage({
      saveDiffs: vi.fn().mockRejectedValue(new Error('idb failed')),
    });
    workbook = new Workbook();
    workbook._storage = storage;
    workbook.enablePersistenceStorage({ sheetId: 'sheet-1' });
    workbook.setCell(0, 0, { v: 'unsaved' });

    await expect(workbook.close()).rejects.toThrow('idb failed');

    expect(workbook.getDirtyCells().get('0-0')).toMatchObject({ v: 'unsaved' });
    expect(workbook.getCell(0, 0)).toMatchObject({ v: 'unsaved' });
    expect(storage.close).not.toHaveBeenCalled();
  });

  test('close 等待单元格与布局配置持久化后再关闭存储', async () => {
    let finishConfigSave;
    const configSaved = new Promise(resolve => { finishConfigSave = resolve; });
    const storage = makeWritableStorage({
      saveMetadata: vi.fn().mockReturnValue(configSaved),
    });
    workbook = new Workbook();
    workbook._storage = storage;
    workbook.enablePersistenceStorage({ sheetId: 'sheet-1' });
    workbook.setCell(0, 0, { v: 'saved' });
    workbook.setColWidth(2, 180);
    workbook.setFreeze(1, 1);

    const closePromise = workbook.close();
    await vi.waitFor(() => expect(storage.saveMetadata).toHaveBeenCalledTimes(1));

    expect(storage.saveDiffs).toHaveBeenCalledTimes(1);
    expect(storage.close).not.toHaveBeenCalled();
    const savedConfig = storage.saveMetadata.mock.calls[0][1];
    expect(savedConfig.colWidths[2]).toBe(180);
    expect(savedConfig.freeze).toEqual({ r: 1, c: 1 });

    finishConfigSave();
    await closePromise;

    expect(storage.close).toHaveBeenCalledTimes(1);
    expect(workbook.getCell(0, 0)).toBeNull();
  });

  test('直接 destroy 且有待保存数据时应告警并取消定时写入', async () => {
    vi.useFakeTimers();
    const storage = makeWritableStorage();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    workbook = new Workbook({ enableWasm: false });
    workbook._storage = storage;
    workbook.enablePersistenceStorage({ sheetId: 'sheet-1' });
    workbook.setCell(0, 0, { v: 'unsaved' });

    workbook.destroy();
    await vi.advanceTimersByTimeAsync(1100);

    expect(storage.saveDiffs).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('await workbook.close()'));
    warnSpy.mockRestore();
  });

  test('自动保存应持久化并恢复多 Sheet 名称、活动表与数据', async () => {
    const storage = makeWritableStorage();
    workbook = new Workbook({ enableWasm: false });
    workbook._storage = storage;
    workbook.enablePersistenceStorage({ sheetId: 'multi-sheet' });

    workbook.renameSheet('sheet-1', '总表');
    workbook.setCell(0, 0, { v: '总表数据' });
    workbook.addSheet('明细');
    workbook.setCell(1, 1, { v: '明细数据' });
    workbook.switchSheet('总表');

    const result = await workbook.savePendingChanges('multi-sheet');
    expect(result).toMatchObject({ mode: 'workbook', sheetId: 'multi-sheet' });

    const snapshot = storage.metadata.get('workbook-multi-sheet');
    expect(snapshot.sheets.map(sheet => sheet.name)).toEqual(['总表', '明细']);
    expect(snapshot.activeSheetId).toBe('sheet-1');
    expect(snapshot.sheets[0].state.data['0-0']).toMatchObject({ v: '总表数据' });
    expect(snapshot.sheets[1].state.data['1-1']).toMatchObject({ v: '明细数据' });
    expect(workbook.getDirtyCells().size).toBe(0);

    const restored = new Workbook({ enableWasm: false });
    restored._storage = storage;
    restored.enablePersistenceStorage({ sheetId: 'multi-sheet' });
    await restored.loadFromStorage('multi-sheet');

    expect(restored.getSheets()).toEqual([
      { id: 'sheet-1', name: '总表', isActive: true },
      { id: 'sheet-2', name: '明细', isActive: false },
    ]);
    expect(restored.sheetName).toBe('总表');
    expect(restored.getCell(0, 0)).toMatchObject({ v: '总表数据' });
    restored.switchSheet('明细');
    expect(restored.getCell(1, 1)).toMatchObject({ v: '明细数据' });
    await restored.close();
  });

  test('初始快照加载完成前自动保存不得覆盖多 Sheet 数据', async () => {
    vi.useFakeTimers();
    const sourceStorage = makeWritableStorage();
    const source = new Workbook({ enableWasm: false });
    source._storage = sourceStorage;
    source.enablePersistenceStorage({ sheetId: 'slow-load' });
    source.addSheet('第二张表');
    source.setCell(0, 0, { v: '历史数据' });
    await source.savePendingChanges('slow-load');
    const historicalSnapshot = JSON.parse(JSON.stringify(
      sourceStorage.metadata.get('workbook-slow-load')
    ));
    await source.close();

    const delayedStorage = makeWritableStorage({
      getMetadata: vi.fn(async key => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return key === 'workbook-slow-load' ? historicalSnapshot : null;
      }),
    });
    workbook = new Workbook({ enableWasm: false });
    workbook._storage = delayedStorage;
    workbook.enablePersistenceStorage({ sheetId: 'slow-load' });

    const loadPromise = workbook.loadFromStorage('slow-load');
    workbook.setCell(0, 0, { v: '启动期覆盖数据' });
    const savePromise = workbook.savePendingChanges('slow-load');

    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([loadPromise, savePromise]);

    const snapshot = delayedStorage.metadata.get('workbook-slow-load');
    expect(snapshot.sheets.map(sheet => sheet.name)).toEqual(['Sheet1', '第二张表']);
    expect(snapshot.sheets[1].state.data['0-0']).toMatchObject({ v: '历史数据' });
    expect(workbook.getSheets()).toHaveLength(2);
  });

  test('删除工作表后自动保存的快照不应保留该表', async () => {
    const storage = makeWritableStorage();
    workbook = new Workbook({ enableWasm: false });
    workbook._storage = storage;
    workbook.enablePersistenceStorage({ sheetId: 'delete-sheet' });

    workbook.addSheet('明细');
    workbook.setCell(0, 0, { v: '明细数据' });
    await workbook.savePendingChanges('delete-sheet');

    expect(workbook.deleteSheet('明细')).toBe(true);
    await workbook.savePendingChanges('delete-sheet');

    const snapshot = storage.metadata.get('workbook-delete-sheet');
    expect(snapshot.sheets.map(sheet => sheet.name)).toEqual(['Sheet1']);

    const restored = new Workbook({ enableWasm: false });
    restored._storage = storage;
    restored.enablePersistenceStorage({ sheetId: 'delete-sheet' });
    await restored.loadFromStorage('delete-sheet');
    expect(restored.getSheets()).toHaveLength(1);
    await restored.close();
  });

  test('已有完整快照后单 Sheet 编辑也必须更新快照', async () => {
    const storage = makeWritableStorage();
    workbook = new Workbook({ enableWasm: false });
    workbook._storage = storage;
    workbook.enablePersistenceStorage({ sheetId: 'snapshot-diff' });

    workbook.addSheet('明细', { activate: false });
    workbook.setCell(0, 0, { v: '修改前' });
    await workbook.savePendingChanges('snapshot-diff');

    workbook.deleteSheet('明细');
    await workbook.savePendingChanges('snapshot-diff');

    workbook.setCell(0, 0, { v: '修改后' });
    const result = await workbook.savePendingChanges('snapshot-diff');
    expect(result.mode).toBe('workbook');

    const snapshot = storage.metadata.get('workbook-snapshot-diff');
    expect(snapshot.sheets[0].state.data['0-0']).toMatchObject({ v: '修改后' });

    const restored = new Workbook({ enableWasm: false });
    restored._storage = storage;
    restored.enablePersistenceStorage({ sheetId: 'snapshot-diff' });
    expect(await restored.loadFromStorage('snapshot-diff')).toBe(true);
    expect(restored.getCell(0, 0)).toMatchObject({ v: '修改后' });
    await restored.close();
  });
});
