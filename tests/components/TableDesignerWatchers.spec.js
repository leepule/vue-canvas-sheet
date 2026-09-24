// @vitest-environment jsdom

import { createApp, nextTick } from 'vue';
import TableDesigner from '@/components/designer/index.vue';
import { Workbook } from '@/core/Workbook';

describe('TableDesigner 数据重载 watcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('initialData 应该按引用变化重载，不再使用 JSON.stringify 深比较', () => {
    const setData = vi.fn();
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    const oldData = [{ id: 1, name: 'A' }];
    const newData = [{ id: 1, name: 'A' }];

    TableDesigner.watch.initialData.handler.call({ setData }, newData, oldData);

    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData).toHaveBeenCalledWith(newData);
    expect(stringifySpy).not.toHaveBeenCalled();
  });

  test('initialData 引用不变时不应重载', () => {
    const setData = vi.fn();
    const data = [{ id: 1, name: 'A' }];

    TableDesigner.watch.initialData.handler.call({ setData }, data, data);

    expect(setData).not.toHaveBeenCalled();
  });

  test('reloadKey 变化时应该使用当前 initialData 显式重载', () => {
    const initialData = [{ id: 1, name: 'A' }];
    const setData = vi.fn();

    TableDesigner.watch.reloadKey.call({ initialData, setData }, 2, 1);

    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData).toHaveBeenCalledWith(initialData);
  });

  test('reloadKey 引用值不变时不应重载', () => {
    const setData = vi.fn();

    TableDesigner.watch.reloadKey.call({ initialData: [], setData }, 'v1', 'v1');

    expect(setData).not.toHaveBeenCalled();
  });

  test('enableWasm 默认应使用公式触发懒加载的 auto 模式', () => {
    expect(TableDesigner.props.enableWasm.default).toBe('auto');
    expect(TableDesigner.props.enableWasm.validator('auto')).toBe(true);
    expect(TableDesigner.props.enableWasm.validator(true)).toBe(true);
    expect(TableDesigner.props.enableWasm.validator(false)).toBe(true);
    expect(TableDesigner.props.enableWasm.validator('invalid')).toBe(false);
  });

  test('TableDesigner 代理多工作表公开 API', () => {
    const workbook = {
      addSheet: vi.fn(() => 'sheet-2'),
      switchSheet: vi.fn(() => true),
      renameSheet: vi.fn(() => true),
      getSheets: vi.fn(() => [])
    };
    const context = { workbook };

    expect(TableDesigner.methods.addSheet.call(context, '明细')).toBe('sheet-2');
    expect(workbook.addSheet).toHaveBeenCalledWith('明细', {});
    expect(TableDesigner.methods.switchSheet.call(context, '明细')).toBe(true);
    expect(workbook.switchSheet).toHaveBeenCalledWith('明细');
    expect(TableDesigner.methods.renameSheet.call(context, '明细', '数据')).toBe(true);
    expect(workbook.renameSheet).toHaveBeenCalledWith('明细', '数据');
    expect(TableDesigner.methods.getSheets.call(context)).toEqual([]);
  });

  test('双击重命名状态支持确认、取消和错误保持编辑', async () => {
    const makeContext = (renameSheet) => ({
      readOnly: false,
      workbook: { renameSheet },
      renameSheet: TableDesigner.methods.renameSheet,
      editingSheetId: null,
      sheetRenameDraft: '',
      sheetRenameError: '',
      _sheetRenameInput: { focus: vi.fn(), select: vi.fn() },
      $nextTick: callback => Promise.resolve(callback()).then(() => {})
    });

    const confirmed = makeContext(vi.fn(() => true));
    TableDesigner.methods.handleSheetRenameStart.call(confirmed, { id: 'sheet-1', name: '总表' });
    await confirmed.$nextTick(() => {});
    expect(confirmed.editingSheetId).toBe('sheet-1');
    expect(confirmed.sheetRenameDraft).toBe('总表');
    expect(confirmed._sheetRenameInput.focus).toHaveBeenCalledTimes(1);
    expect(confirmed._sheetRenameInput.select).toHaveBeenCalledTimes(1);

    confirmed.sheetRenameDraft = '汇总';
    TableDesigner.methods.confirmSheetRename.call(confirmed);
    expect(confirmed.workbook.renameSheet).toHaveBeenCalledWith('sheet-1', '汇总');
    expect(confirmed.editingSheetId).toBeNull();
    expect(confirmed.sheetRenameDraft).toBe('');

    const cancelled = makeContext(vi.fn(() => true));
    TableDesigner.methods.handleSheetRenameStart.call(cancelled, { id: 'sheet-1', name: '总表' });
    TableDesigner.methods.cancelSheetRename.call(cancelled);
    expect(cancelled.editingSheetId).toBeNull();
    expect(cancelled.sheetRenameDraft).toBe('');
    expect(cancelled.workbook.renameSheet).not.toHaveBeenCalled();

    const invalid = makeContext(vi.fn(() => {
      throw new Error('工作表名称已存在: 汇总');
    }));
    TableDesigner.methods.handleSheetRenameStart.call(invalid, { id: 'sheet-1', name: '总表' });
    invalid._sheetRenameInput.focus.mockClear();
    invalid._sheetRenameInput.select.mockClear();
    invalid.sheetRenameDraft = '汇总';
    TableDesigner.methods.confirmSheetRename.call(invalid);
    await invalid.$nextTick(() => {});
    expect(invalid.editingSheetId).toBe('sheet-1');
    expect(invalid.sheetRenameError).toBe('工作表名称已存在: 汇总');
    expect(invalid._sheetRenameInput.focus).toHaveBeenCalledTimes(1);
    expect(invalid._sheetRenameInput.select).toHaveBeenCalledTimes(1);
  });
});

describe('TableDesigner 卸载持久化', () => {
  test('卸载时通过 close 刷新工作簿而不直接丢弃待保存数据', async () => {
    const workbook = { close: vi.fn().mockResolvedValue(undefined) };
    const dataController = { destroy: vi.fn() };
    const context = {
      workbook,
      dataController,
      _unsubLockChange: null,
      _unsubWasmDowngrade: null,
      _workbookClosePromise: null,
    };

    TableDesigner.beforeUnmount.call(context);
    await context._workbookClosePromise;

    expect(dataController.destroy).toHaveBeenCalledTimes(1);
    expect(workbook.close).toHaveBeenCalledTimes(1);
  });
});

describe('TableDesigner 全局封装', () => {
  test('多个实例挂载和卸载都不应暴露或覆盖 window.__wb', async () => {
    const LifecycleOnlyTableDesigner = {
      ...TableDesigner,
      render: () => null,
    };
    const firstContainer = document.createElement('div');
    const secondContainer = document.createElement('div');
    document.body.append(firstContainer, secondContainer);

    delete window.__wb;
    const firstApp = createApp(LifecycleOnlyTableDesigner);
    const secondApp = createApp(LifecycleOnlyTableDesigner);
    const firstInstance = firstApp.mount(firstContainer);
    const secondInstance = secondApp.mount(secondContainer);

    expect(window.__wb).toBeUndefined();
    firstApp.unmount();
    expect(window.__wb).toBeUndefined();
    secondApp.unmount();
    expect(window.__wb).toBeUndefined();

    await Promise.all([
      firstInstance._workbookClosePromise,
      secondInstance._workbookClosePromise,
    ]);
    firstContainer.remove();
    secondContainer.remove();
  });

  test('双击工作表标签后可直接输入并回车重命名', async () => {
    const CanvasTableStub = {
      props: ['workbook', 'version', 'readOnly', 'dataController'],
      methods: {
        focus() {},
        scrollIntoView() {}
      },
      render: () => null
    };
    const RenameTableDesigner = {
      ...TableDesigner,
      components: {
        ...TableDesigner.components,
        CanvasTable: CanvasTableStub
      }
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = createApp(RenameTableDesigner);
    const instance = app.mount(container);

    const tab = container.querySelector('.vue-canvas-sheet-tab');
    expect(tab).toBeTruthy();
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await nextTick();

    const input = container.querySelector('.vue-canvas-sheet-tab-input');
    expect(input).toBeTruthy();
    expect(input.value).toBe('Sheet1');

    input.value = '汇总';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();

    expect(instance.workbook.sheetName).toBe('汇总');
    expect(instance.workbook.getSheets()).toEqual([
      { id: 'sheet-1', name: '汇总', isActive: true }
    ]);
    expect(container.querySelector('.vue-canvas-sheet-tab-input')).toBeNull();
    expect(container.querySelector('.vue-canvas-sheet-tab-name').textContent).toBe('汇总');

    app.unmount();
    await instance._workbookClosePromise;
    container.remove();
  });

  test('持久化数据异步加载完成后应主动推进 UI 重绘版本', async () => {
    const source = new Workbook({ enableWasm: false });
    source.addSheet('明细');
    source.setCell(0, 0, { v: '恢复后立即可见' });
    const snapshot = JSON.parse(JSON.stringify(source.toJSON()));
    source.destroy();

    const storage = {
      close: vi.fn(),
      getMetadata: vi.fn(async key => key === 'workbook-restore-render' ? snapshot : null),
      exportSheet: vi.fn().mockResolvedValue(null),
      saveDiffs: vi.fn().mockResolvedValue(undefined),
      saveMetadata: vi.fn().mockResolvedValue(undefined),
      importSheet: vi.fn().mockResolvedValue(undefined)
    };
    const CanvasTableStub = {
      props: ['workbook', 'version', 'readOnly', 'dataController'],
      methods: {
        scrollIntoView() {}
      },
      render: () => null
    };
    const RestoreTableDesigner = {
      ...TableDesigner,
      components: {
        ...TableDesigner.components,
        CanvasTable: CanvasTableStub
      }
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = createApp(RestoreTableDesigner);
    const instance = app.mount(container);

    instance.workbook._storage = storage;
    instance.workbook.enablePersistenceStorage({ sheetId: 'restore-render' });
    const versionBeforeLoad = instance.uiVersion;
    const loaded = await instance.workbook.loadFromStorage('restore-render');
    await nextTick();

    expect(loaded).toBe(true);
    expect(instance.uiVersion).toBeGreaterThan(versionBeforeLoad);
    expect(instance.getSheets().map(sheet => sheet.name)).toEqual(['Sheet1', '明细']);

    app.unmount();
    await instance._workbookClosePromise;
    container.remove();
  });

  test('点击标签页删除按钮应删除对应工作表', async () => {
    const CanvasTableStub = {
      props: ['workbook', 'version', 'readOnly', 'dataController'],
      methods: {
        focus() {},
        scrollIntoView() {}
      },
      render: () => null
    };
    const DeleteTableDesigner = {
      ...TableDesigner,
      components: {
        ...TableDesigner.components,
        CanvasTable: CanvasTableStub
      }
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = createApp(DeleteTableDesigner);
    const instance = app.mount(container);

    instance.addSheet('明细');
    await nextTick();

    const deleteButtons = container.querySelectorAll('.vue-canvas-sheet-tab-delete');
    expect(deleteButtons).toHaveLength(2);
    deleteButtons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    expect(instance.getSheets()).toEqual([
      { id: 'sheet-1', name: 'Sheet1', isActive: true }
    ]);
    expect(container.querySelectorAll('.vue-canvas-sheet-tab-delete')).toHaveLength(0);

    app.unmount();
    await instance._workbookClosePromise;
    container.remove();
  });
});
