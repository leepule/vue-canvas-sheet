import { describe, it, expect } from 'vitest';
import { __TaskQueueForTest as TaskQueue } from '../../src/core/render/ProgressiveRenderer';

function makeTask(id) {
  return { id, _cancelled: false, onCancel: null, state: 'pending' };
}

describe('ProgressiveRenderer TaskQueue', () => {
  it('push + shift 保持 FIFO 顺序', () => {
    const q = new TaskQueue();
    const a = makeTask('a');
    const b = makeTask('b');
    const c = makeTask('c');
    q.push(a); q.push(b); q.push(c);
    expect(q.length).toBe(3);
    expect(q.shift()).toBe(a);
    expect(q.shift()).toBe(b);
    expect(q.shift()).toBe(c);
    expect(q.shift()).toBeNull();
    expect(q.length).toBe(0);
  });

  it('cancelById 标记 tombstone，shift 跳过已取消任务', () => {
    const q = new TaskQueue();
    const a = makeTask('a');
    const b = makeTask('b');
    const c = makeTask('c');
    q.push(a); q.push(b); q.push(c);

    const cancelled = q.cancelById('b');
    expect(cancelled).toBe(b);
    expect(b._cancelled).toBe(true);
    expect(q.length).toBe(2);

    expect(q.shift()).toBe(a);
    // b 已取消，跳过；下一个应为 c
    expect(q.shift()).toBe(c);
    expect(q.shift()).toBeNull();
  });

  it('cancelById 对不存在或已取消的任务返回 null', () => {
    const q = new TaskQueue();
    const a = makeTask('a');
    q.push(a);
    expect(q.cancelById('nonexistent')).toBeNull();
    q.cancelById('a');
    expect(q.cancelById('a')).toBeNull();
  });

  it('unshiftFront 放回的任务下次被优先取出', () => {
    const q = new TaskQueue();
    const a = makeTask('a');
    const b = makeTask('b');
    const c = makeTask('c');
    q.push(a); q.push(b);
    const first = q.shift();
    expect(first).toBe(a);
    // a 未跑完，放回队首
    q.unshiftFront(a);
    q.push(c);
    expect(q.shift()).toBe(a);
    expect(q.shift()).toBe(b);
    expect(q.shift()).toBe(c);
  });

  it('cancelAll 对每个 active 任务调用回调并清空', () => {
    const q = new TaskQueue();
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    tasks.forEach(t => q.push(t));
    // 提前取消其中一个
    q.cancelById('b');

    const seen = [];
    q.cancelAll(t => seen.push(t.id));
    // b 已取消不应再次回调；a 和 c 应被回调
    expect(seen.sort()).toEqual(['a', 'c']);
    expect(q.length).toBe(0);
    expect(q.shift()).toBeNull();
  });

  it('全部消费完后内部数组与 head 被压缩，不导致内存累积', () => {
    const q = new TaskQueue();
    for (let i = 0; i < 100; i++) q.push(makeTask(`t${i}`));
    for (let i = 0; i < 100; i++) q.shift();
    // 内部数组应已重置
    expect(q.tasks.length).toBe(0);
    expect(q.head).toBe(0);
    // 之后继续 push 仍正常工作
    q.push(makeTask('x'));
    expect(q.shift().id).toBe('x');
  });
});
