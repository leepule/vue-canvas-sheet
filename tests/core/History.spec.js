/**
 * History 单元测试
 * 测试撤销/重做、操作合并、批量操作等功能
 */

import { HistoryManager } from '@/core/history/History';


describe('HistoryManager', () => {
  let history;
  let mockWorkbook;

  beforeEach(() => {
    mockWorkbook = {
      applyCommand: vi.fn()
    };
    history = new HistoryManager(mockWorkbook);
  });

  describe('execute', () => {
    test('应该将命令添加到撤销栈', () => {
      const cmd = { type: 'set-cell', r: 0, c: 0, oldValue: null, newValue: 'test' };
      history.execute(cmd);
      
      expect(history.undoStackSize).toBe(1);
      expect(history.redoStackSize).toBe(0);
    });

    test('应该清空重做栈', () => {
      // 先执行一个命令
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: null, newValue: 'a' });
      
      // 撤销
      history.undo();
      expect(history.redoStackSize).toBe(1);
      
      // 执行新命令，应该清空重做栈
      history.execute({ type: 'set-cell', r: 1, c: 0, oldValue: null, newValue: 'b' });
      expect(history.redoStackSize).toBe(0);
    });

    test('超过最大深度时应该移除最早的命令', () => {
      history.maxDepth = 3;
      
      for (let i = 0; i < 5; i++) {
        history.execute({ type: 'set-cell', r: i, c: 0, oldValue: null, newValue: i });
      }
      
      expect(history.undoStackSize).toBe(3);
    });
  });

  describe('操作合并', () => {
    test('同一单元格的连续操作应该合并', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: null, newValue: 'a' });
      
      // 在合并窗口内
      Date.now.mockReturnValue(1200);
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: 'a', newValue: 'ab' });
      
      // 应该合并为一个命令
      expect(history.undoStackSize).toBe(1);
      
      // 检查合并结果
      const cmd = history.undoStack.get(0);
      expect(cmd.oldValue).toBeNull(); // 保留最早的 oldValue
      expect(cmd.newValue).toBe('ab'); // 保留最新的 newValue
      
      Date.now.mockRestore();
    });

    test('超过合并窗口的操作不应合并', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: null, newValue: 'a' });
      
      // 超过合并窗口
      Date.now.mockReturnValue(2000); // 1000ms 后
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: 'a', newValue: 'b' });
      
      // 不应该合并
      expect(history.undoStackSize).toBe(2);
      
      Date.now.mockRestore();
    });

    test('不同单元格的操作不应合并', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: null, newValue: 'a' });
      history.execute({ type: 'set-cell', r: 0, c: 1, oldValue: null, newValue: 'b' });
      
      expect(history.undoStackSize).toBe(2);
      
      Date.now.mockRestore();
    });

    test('非 set-cell 类型的操作不应合并', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: null, newValue: 'a' });
      history.execute({ type: 'merge', range: { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } } });
      
      expect(history.undoStackSize).toBe(2);
      
      Date.now.mockRestore();
    });
  });

  describe('undo', () => {
    test('应该撤销最后一个命令', () => {
      const cmd = { type: 'set-cell', r: 0, c: 0, oldValue: 'old', newValue: 'new' };
      history.execute(cmd);
      
      history.undo();
      
      expect(mockWorkbook.applyCommand).toHaveBeenCalledWith(cmd, true);
      expect(history.undoStackSize).toBe(0);
      expect(history.redoStackSize).toBe(1);
    });

    test('撤销栈为空时不应操作', () => {
      history.undo();
      expect(mockWorkbook.applyCommand).not.toHaveBeenCalled();
    });

    test('撤销后应该重置合并状态', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: null, newValue: 'a' });
      history.undo();
      
      expect(history.lastOpTime).toBe(0);
      
      Date.now.mockRestore();
    });
  });

  describe('redo', () => {
    test('应该重做最后一个撤销的命令', () => {
      const cmd = { type: 'set-cell', r: 0, c: 0, oldValue: 'old', newValue: 'new' };
      history.execute(cmd);
      history.undo();
      
      history.redo();
      
      expect(mockWorkbook.applyCommand).toHaveBeenCalledWith(cmd, false);
      expect(history.undoStackSize).toBe(1);
      expect(history.redoStackSize).toBe(0);
    });

    test('重做栈为空时不应操作', () => {
      history.redo();
      expect(mockWorkbook.applyCommand).not.toHaveBeenCalled();
    });
  });

  describe('批量操作', () => {
    test('批量操作应该合并为一个命令', () => {
      history.startBatch();
      
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: null, newValue: 'a' });
      history.execute({ type: 'set-cell', r: 0, c: 1, oldValue: null, newValue: 'b' });
      history.execute({ type: 'set-cell', r: 0, c: 2, oldValue: null, newValue: 'c' });
      
      // 批量期间不应添加到撤销栈
      expect(history.undoStackSize).toBe(0);
      
      history.endBatch();
      
      // 结束批量后应该作为一个命令添加
      expect(history.undoStackSize).toBe(1);
      
      const batchCmd = history.undoStack.get(0);
      expect(batchCmd.type).toBe('batch');
      expect(batchCmd.cmds).toHaveLength(3);
    });

    test('空批量不应添加命令', () => {
      history.startBatch();
      history.endBatch();
      
      expect(history.undoStackSize).toBe(0);
    });

    test('批量操作期间禁用合并', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      
      history.startBatch();
      
      // 这些操作在批量期间，合并被禁用
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: null, newValue: 'a' });
      Date.now.mockReturnValue(1100);
      history.execute({ type: 'set-cell', r: 0, c: 0, oldValue: 'a', newValue: 'ab' });
      
      history.endBatch();
      
      // 应该有两个子命令，而不是合并为一个
      const batchCmd = history.undoStack.get(0);
      expect(batchCmd.cmds).toHaveLength(2);
      
      Date.now.mockRestore();
    });
  });

  describe('canUndo/canRedo', () => {
    test('canUndo 应该返回正确状态', () => {
      expect(history.canUndo()).toBe(false);
      
      history.execute({ type: 'set-cell', r: 0, c: 0 });
      expect(history.canUndo()).toBe(true);
      
      history.undo();
      expect(history.canUndo()).toBe(false);
    });

    test('canRedo 应该返回正确状态', () => {
      expect(history.canRedo()).toBe(false);
      
      history.execute({ type: 'set-cell', r: 0, c: 0 });
      expect(history.canRedo()).toBe(false);
      
      history.undo();
      expect(history.canRedo()).toBe(true);
      
      history.redo();
      expect(history.canRedo()).toBe(false);
    });
  });

  describe('clear', () => {
    test('应该清空所有历史记录', () => {
      history.execute({ type: 'set-cell', r: 0, c: 0 });
      history.execute({ type: 'set-cell', r: 1, c: 0 });
      history.undo();
      
      history.clear();
      
      expect(history.undoStackSize).toBe(0);
      expect(history.redoStackSize).toBe(0);
      expect(history.lastOpTime).toBe(0);
      expect(history.lastOpType).toBeNull();
      expect(history.lastOpCell).toBeNull();
    });
  });

  describe('属性访问器', () => {
    test('undoStackSize 应该返回撤销栈大小', () => {
      expect(history.undoStackSize).toBe(0);
      
      history.execute({ type: 'set-cell', r: 0, c: 0 });
      expect(history.undoStackSize).toBe(1);
      
      history.execute({ type: 'set-cell', r: 1, c: 0 });
      expect(history.undoStackSize).toBe(2);
    });

    test('redoStackSize 应该返回重做栈大小', () => {
      history.execute({ type: 'set-cell', r: 0, c: 0 });
      history.execute({ type: 'set-cell', r: 1, c: 0 });
      history.undo();
      
      expect(history.redoStackSize).toBe(1);
      
      history.undo();
      expect(history.redoStackSize).toBe(2);
    });
  });
});