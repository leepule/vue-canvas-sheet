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
});
