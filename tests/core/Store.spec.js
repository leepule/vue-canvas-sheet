import { Store, DataStore, SelectionStore, UIStore, StoreManager } from '@/core/data/Store';

describe('Store', () => {
  describe('Base Store', () => {
    test('应该能够创建带有初始状态的 Store', () => {
      const store = new Store({ count: 0 });
      expect(store.getState().count).toBe(0);
    });

    test('deep 模式下 getState 应该返回完整冻结的对象', () => {
      const store = new Store({ nested: { a: 1 } }, { freezeMode: 'deep' });
      const state = store.getState();
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.nested)).toBe(true);
    });

    test('setState 应该能够更新状态', () => {
      const store = new Store({ count: 0 });
      store.setState({ count: 1 });
      expect(store.getState().count).toBe(1);
    });

    test('setState 支持传入函数来更新状态', () => {
      const store = new Store({ count: 1 });
      store.setState((prev) => ({ count: prev.count + 1 }));
      expect(store.getState().count).toBe(2);
    });

    test('subscribe 应该能够监听状态变化', () => {
      const store = new Store({ count: 0 });
      const listener = vi.fn();
      store.subscribe(listener);
      
      store.setState({ count: 1 });
      
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ count: 1 }, { count: 0 });
    });

    test('能够取消订阅', () => {
      const store = new Store({ count: 0 });
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      
      unsubscribe();
      store.setState({ count: 1 });
      
      expect(listener).not.toHaveBeenCalled();
    });

    test('select 应该只在特定状态改变时触发', () => {
      const store = new Store({ count: 0, other: 'a' });
      const listener = vi.fn();
      
      // select 会立即调用一次
      store.select(state => state.count, listener);
      expect(listener).toHaveBeenCalledWith(0);
      expect(listener).toHaveBeenCalledTimes(1);
      
      // 更新 other 不应触发 count 的监听
      store.setState({ other: 'b' });
      expect(listener).toHaveBeenCalledTimes(1);
      
      // 更新 count 触发监听
      store.setState({ count: 1 });
      expect(listener).toHaveBeenCalledWith(1);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    test('批量更新 (beginBatch/endBatch) 应该只触发一次事件并且合并状态', () => {
      const store = new Store({ count: 0, name: '' });
      const listener = vi.fn();
      store.subscribe(listener);
      
      store.beginBatch();
      store.setState({ count: 1 });
      store.setState({ name: 'test' });
      
      // 在 endBatch 之前不会触发 listener，并且状态不变
      expect(listener).not.toHaveBeenCalled();
      expect(store.getState()).toEqual({ count: 0, name: '' });
      
      store.endBatch();
      
      // endBatch 之后触发，并且状态合并
      expect(listener).toHaveBeenCalledTimes(1);
      expect(store.getState()).toEqual({ count: 1, name: 'test' });
      expect(listener).toHaveBeenCalledWith({ count: 1, name: 'test' }, { count: 0, name: '' });
    });

    test('处理监听器内部抛出的错误', () => {
      const store = new Store({ count: 0 });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // 一个会抛错的监听器
      store.subscribe(() => { throw new Error('test error'); });
      // 一个正常的监听器
      const mockListener = vi.fn();
      store.subscribe(mockListener);
      
      store.setState({ count: 1 });
      
      // 正常的监听器应该仍然能被调用
      expect(mockListener).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('可以清除所有监听器', () => {
      const store = new Store({ count: 0 });
      const listener = vi.fn();
      store.subscribe(listener);
      
      expect(store.listenerCount).toBe(1);
      store.clear();
      expect(store.listenerCount).toBe(0);
      
      store.setState({ count: 1 });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('Freeze Strategies', () => {
    test('none 模式下不应该冻结对象', () => {
      const store = new Store({ a: { b: 1 } }, { freezeMode: 'none' });
      const state = store.getState();
      expect(Object.isFrozen(state)).toBe(false);
      expect(Object.isFrozen(state.a)).toBe(false);
    });

    test('shallow 模式下只应冻结顶层对象', () => {
      const store = new Store({ a: { b: 1 } }, { freezeMode: 'shallow' });
      const state = store.getState();
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.a)).toBe(false);
    });

    test('incremental 模式下应正确执行增量冻结', () => {
      const store = new Store({ a: { b: 1 }, c: { d: 2 } }, { freezeMode: 'incremental' });
      
      // 初始化时 incremental 会回退到 deep 模式（所以全部冻结）
      expect(Object.isFrozen(store.getState().a)).toBe(true);
      expect(Object.isFrozen(store.getState().c)).toBe(true);

      // 更新 a 时，新创建的 a 应该被冻结，但未更新的 c 引用保持原样（原本就是冻结的）
      const newA = { b: 2 };
      store.setState({ a: newA });
      
      const state = store.getState();
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.a)).toBe(true);
      expect(state.a).toEqual({ b: 2 });
    });
  });

  describe('Performance Stats', () => {
    test('应能记录冻结性能统计', () => {
      const store = new Store({ count: 0 }, { freezeMode: 'deep' });
      store.setState({ count: 1 });
      store.setState({ count: 2 });
      
      const stats = store.getFreezeStats();
      expect(stats.freezeMode).toBe('deep');
      // 初始冻结 1 次 + 两次 setState = 3 次
      expect(stats.deepFreezeCalls).toBe(3);
      expect(stats.totalCalls).toBe(3);
      expect(stats.totalTime).toBeGreaterThanOrEqual(0);
    });

    test('resetFreezeStats 应能重置统计数据', () => {
      const store = new Store({ count: 0 }, { freezeMode: 'deep' });
      store.setState({ count: 1 });
      
      store.resetFreezeStats();
      const stats = store.getFreezeStats();
      expect(stats.deepFreezeCalls).toBe(0);
      expect(stats.totalTime).toBe(0);
    });
  });

  describe('DataStore', () => {
    test('应该能够初始化 DataStore', () => {
      const store = new DataStore();
      expect(store.getState().dataVersion).toBe(1);
    });

    test('能够读取未初始化的单元格 (返回 null)', () => {
      const store = new DataStore();
      expect(store.getCell(0, 0)).toBeNull();
    });

    test('字符串键模式 (useCompactKey: false)', () => {
      const store = new DataStore({
        data: { '0-0': { v: 1 } }
      }, { useCompactKey: false });
      
      expect(store.getCell(0, 0)).toEqual({ v: 1 });
    });

    test('安全键模式 (useCompactKey: true)', () => {
      const store = new DataStore({
        data: { '0-1': { v: 'B1' } }
      }, { useCompactKey: true });
      
      expect(store.getCell(0, 1)).toEqual({ v: 'B1' });
    });

    test('能够获取默认和自定义的行高与列宽', () => {
      const store = new DataStore({
        colWidths: { 1: 200 },
        rowHeights: { 2: 50 },
        defaultColWidth: 100,
        defaultRowHeight: 25
      });
      
      expect(store.getColWidth(0)).toBe(100);
      expect(store.getColWidth(1)).toBe(200);
      
      expect(store.getRowHeight(0)).toBe(25);
      expect(store.getRowHeight(2)).toBe(50);
    });

    test('合并单元格信息读取', () => {
      const store = new DataStore({
        mergeMap: { '1-1': { r: 1, c: 1, rs: 2, cs: 2 } }
      }, { useCompactKey: false });
      
      expect(store.getMerge(1, 1)).toEqual({ r: 1, c: 1, rs: 2, cs: 2 });
    });
  });

  describe('SelectionStore', () => {
    test('初始化和获取数据', () => {
      const store = new SelectionStore({
        activeCell: { r: 2, c: 3 },
        selection: { s: { r: 1, c: 1 }, e: { r: 5, c: 5 } }
      });
      
      expect(store.getActiveCell()).toEqual({ r: 2, c: 3 });
      expect(store.getSelection()).toEqual({ s: { r: 1, c: 1 }, e: { r: 5, c: 5 } });
    });
  });

  describe('UIStore', () => {
    test('初始化和获取配置', () => {
      const store = new UIStore({
        freeze: { r: 2, c: 2 }
      });
      
      expect(store.getFreeze()).toEqual({ r: 2, c: 2 });
    });
  });

  describe('StoreManager', () => {
    test('能够管理多个 store', () => {
      const dataStore = new DataStore();
      const uiStore = new UIStore();
      
      const manager = new StoreManager({
        data: dataStore,
        ui: uiStore
      });
      
      expect(manager.getStore('data')).toBe(dataStore);
      expect(manager.getStore('ui')).toBe(uiStore);
    });

    test('动态添加 Store', () => {
      const manager = new StoreManager();
      const dataStore = new DataStore();
      
      manager.addStore('data', dataStore);
      expect(manager.getStore('data')).toBe(dataStore);
    });

    test('订阅全部 Store 改变', () => {
      const dataStore = new DataStore({ version: 1 });
      const manager = new StoreManager({ data: dataStore });
      const listener = vi.fn();
      
      manager.subscribe(listener);
      
      dataStore.setState({ version: 2 });
      
      expect(listener).toHaveBeenCalledWith(
        'data',
        expect.objectContaining({ version: 2 }),
        expect.objectContaining({ version: 1 })
      );
    });

    test('能够批量合并和分发事件', () => {
      const dataStore = new DataStore({ v1: 0, v2: 0 });
      const uiStore = new UIStore({ scrollY: 0 });
      const manager = new StoreManager({ data: dataStore, ui: uiStore });
      
      manager.beginBatch();
      dataStore.setState({ v1: 1 });
      dataStore.setState({ v2: 2 });
      uiStore.setState({ scrollY: 100 });
      
      expect(dataStore.getState().v1).toBe(0);
      manager.endBatch();
      expect(dataStore.getState().v1).toBe(1);
    });

    test('销毁时清除所有的 Store', () => {
      const dataStore = new DataStore();
      const manager = new StoreManager({ data: dataStore });
      
      manager.destroy();
      expect(manager.getStore('data')).toBeUndefined();
    });
  });
});
