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
  return {
    close: vi.fn(),
    exportSheet: vi.fn().mockResolvedValue(null),
    saveDiffs: vi.fn().mockResolvedValue(undefined),
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    importSheet: vi.fn().mockResolvedValue(undefined),
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
});
