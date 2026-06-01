import { describe, it, expect, vi, afterEach } from 'vitest';
import { HistoryOptimizer } from '@/core/history/HistoryOptimizer';

// 构造函数只读取 history 引用与建立策略表，size 估算相关用例无需完整栈
function makeOptimizer() {
  return new HistoryOptimizer({ undoStack: { length: 0 }, redoStack: {} });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HistoryOptimizer._estimateCommandSize 缓存 (#22)', () => {
  it('对象值只 JSON.stringify 一次，后续读缓存', () => {
    const opt = makeOptimizer();
    const cmd = {
      type: 'set-cell',
      oldValue: { v: 1, s: { bg: '#ffffff' } },
      newValue: { v: 2, s: { bg: '#000000' } }
    };

    const spy = vi.spyOn(JSON, 'stringify');
    const s1 = opt._estimateCommandSize(cmd);
    const callsAfterFirst = spy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0); // 首次确实 stringify 了对象值

    const s2 = opt._estimateCommandSize(cmd);
    expect(s2).toBe(s1);
    expect(spy.mock.calls.length).toBe(callsAfterFirst); // 第二次不再 stringify
    expect(cmd._size).toBe(s1);
  });

  it('两个内容相同的命令估算值一致', () => {
    const opt = makeOptimizer();
    const make = () => ({ type: 'set-cell', oldValue: { v: 'hello' }, newValue: { v: 42 } });
    const a = opt._estimateCommandSize(make());
    const b = opt._estimateCommandSize(make());
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(100); // 含 base 开销 + 值大小
  });

  it('trackPush 与 trackRemove 对内存追踪可逆', () => {
    const opt = makeOptimizer();
    opt.memoryUsage = 0;
    const cmd = { type: 'batch-set-cell', changes: new Array(5).fill({ r: 0, c: 0 }) };

    opt.trackPush(cmd);
    const after = opt.memoryUsage;
    expect(after).toBeGreaterThan(0);

    opt.trackRemove(cmd);
    expect(opt.memoryUsage).toBe(0);
  });

  it('trackClearStack 复用缓存，不重复 stringify', () => {
    const opt = makeOptimizer();
    const stack = [
      { type: 'set-cell', newValue: { v: 1, s: { bg: '#fff' } } },
      { type: 'set-cell', newValue: { v: 2, s: { bg: '#000' } } }
    ];
    // 先各算一次填充缓存
    for (const c of stack) opt._estimateCommandSize(c);

    const spy = vi.spyOn(JSON, 'stringify');
    opt.trackClearStack(stack);
    expect(spy).not.toHaveBeenCalled(); // 全部命中 _size 缓存
  });
});
