import { createApp } from 'vue';
import TableDesigner from '@/components/designer/index.vue';

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
});
