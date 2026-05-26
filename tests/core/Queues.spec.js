import { describe, it, expect } from 'vitest';
import { HeadPointerQueue, RingBuffer } from '../../src/core/utils/Queues';


describe('HeadPointerQueue', () => {
  it('FIFO 顺序', () => {
    const q = new HeadPointerQueue();
    q.push(1); q.push(2); q.push(3);
    expect(q.length).toBe(3);
    expect(q.peek()).toBe(1);
    expect(q.shift()).toBe(1);
    expect(q.shift()).toBe(2);
    expect(q.shift()).toBe(3);
    expect(q.shift()).toBeUndefined();
    expect(q.length).toBe(0);
  });

  it('push 与 shift 交替混合', () => {
    const q = new HeadPointerQueue();
    q.push('a');
    expect(q.shift()).toBe('a');
    q.push('b'); q.push('c');
    expect(q.shift()).toBe('b');
    q.push('d');
    expect(q.length).toBe(2);
    expect(q.shift()).toBe('c');
    expect(q.shift()).toBe('d');
  });

  it('周期性压缩触发后，仍保持正确顺序与长度', () => {
    const q = new HeadPointerQueue();
    for (let i = 0; i < 100; i++) q.push(i);
    // 连续 shift 60 个触发压缩（threshold: head>32 且 head*2>length）
    for (let i = 0; i < 60; i++) expect(q.shift()).toBe(i);
    expect(q.length).toBe(40);
    expect(q.peek()).toBe(60);
    // 继续追加再消费，验证压缩后状态完好
    q.push(100);
    expect(q.length).toBe(41);
    for (let i = 60; i <= 100; i++) expect(q.shift()).toBe(i);
    expect(q.length).toBe(0);
  });

  it('clear 重置状态', () => {
    const q = new HeadPointerQueue();
    q.push(1); q.push(2); q.shift();
    q.clear();
    expect(q.length).toBe(0);
    expect(q.peek()).toBeUndefined();
  });

  it('forEach 遍历当前有效元素', () => {
    const q = new HeadPointerQueue();
    q.push(1); q.push(2); q.push(3); q.shift();
    const seen = [];
    q.forEach(v => seen.push(v));
    expect(seen).toEqual([2, 3]);
  });
});

describe('RingBuffer', () => {
  it('未满时 push 顺序保留', () => {
    const rb = new RingBuffer(5);
    rb.push('a'); rb.push('b'); rb.push('c');
    expect(rb.length).toBe(3);
    expect(rb.toArray()).toEqual(['a', 'b', 'c']);
    expect(rb.first()).toBe('a');
    expect(rb.last()).toBe('c');
  });

  it('溢出时自动淘汰最旧元素', () => {
    const rb = new RingBuffer(3);
    rb.push(1); rb.push(2); rb.push(3); rb.push(4); rb.push(5);
    expect(rb.length).toBe(3);
    expect(rb.toArray()).toEqual([3, 4, 5]);
    expect(rb.first()).toBe(3);
    expect(rb.last()).toBe(5);
  });

  it('索引访问 get(i)：0=最旧，length-1=最新', () => {
    const rb = new RingBuffer(3);
    rb.push('x'); rb.push('y'); rb.push('z'); rb.push('w'); // 'x' 被挤出
    expect(rb.get(0)).toBe('y');
    expect(rb.get(1)).toBe('z');
    expect(rb.get(2)).toBe('w');
    expect(rb.get(3)).toBeUndefined();
    expect(rb.get(-1)).toBeUndefined();
  });

  it('pop 从尾部弹出', () => {
    const rb = new RingBuffer(3);
    rb.push(10); rb.push(20); rb.push(30);
    expect(rb.pop()).toBe(30);
    expect(rb.length).toBe(2);
    expect(rb.last()).toBe(20);
    expect(rb.pop()).toBe(20);
    expect(rb.pop()).toBe(10);
    expect(rb.pop()).toBeUndefined();
  });

  it('shift 从头部弹出（用于主动 drain）', () => {
    const rb = new RingBuffer(5);
    rb.push(1); rb.push(2); rb.push(3);
    expect(rb.shift()).toBe(1);
    expect(rb.first()).toBe(2);
    expect(rb.length).toBe(2);
    // shift 后继续 push 不影响顺序
    rb.push(4); rb.push(5); rb.push(6);
    expect(rb.toArray()).toEqual([2, 3, 4, 5, 6]);
  });

  it('lastN(n) 返回最后 n 个元素', () => {
    const rb = new RingBuffer(5);
    for (let i = 1; i <= 7; i++) rb.push(i); // 3,4,5,6,7
    expect(rb.lastN(3)).toEqual([5, 6, 7]);
    expect(rb.lastN(10)).toEqual([3, 4, 5, 6, 7]);
    expect(rb.lastN(0)).toEqual([]);
  });

  it('forEach 与迭代器顺序一致', () => {
    const rb = new RingBuffer(4);
    rb.push('a'); rb.push('b'); rb.push('c'); rb.push('d'); rb.push('e'); // 'a' 出
    const seenForEach = [];
    rb.forEach(v => seenForEach.push(v));
    expect(seenForEach).toEqual(['b', 'c', 'd', 'e']);

    const seenIter = [];
    for (const v of rb) seenIter.push(v);
    expect(seenIter).toEqual(['b', 'c', 'd', 'e']);
  });

  it('clear 重置状态', () => {
    const rb = new RingBuffer(3);
    rb.push(1); rb.push(2);
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.first()).toBeUndefined();
    expect(rb.last()).toBeUndefined();
    expect(rb.toArray()).toEqual([]);
  });

  it('slice 返回指定区间普通数组', () => {
    const rb = new RingBuffer(5);
    for (let i = 1; i <= 7; i++) rb.push(i); // 3,4,5,6,7
    expect(rb.slice()).toEqual([3, 4, 5, 6, 7]);
    expect(rb.slice(1, 4)).toEqual([4, 5, 6]);
    expect(rb.slice(2)).toEqual([5, 6, 7]);
    expect(rb.slice(-2)).toEqual([6, 7]);
    expect(rb.slice(10, 20)).toEqual([]);
  });

  it('replace 整体重置后保留 push 淘汰语义', () => {
    const rb = new RingBuffer(3);
    rb.push('a'); rb.push('b');
    rb.replace([10, 20, 30, 40]); // 40 个进来，10 被挤出
    expect(rb.toArray()).toEqual([20, 30, 40]);
    rb.replace([]);
    expect(rb.length).toBe(0);
  });

  it('容量为 1 的边界情况', () => {
    const rb = new RingBuffer(1);
    rb.push('a');
    expect(rb.last()).toBe('a');
    rb.push('b');
    expect(rb.length).toBe(1);
    expect(rb.last()).toBe('b');
    expect(rb.first()).toBe('b');
    expect(rb.pop()).toBe('b');
    expect(rb.length).toBe(0);
  });

  it('非法容量抛错', () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
    expect(() => new RingBuffer(1.5)).toThrow();
  });
});
