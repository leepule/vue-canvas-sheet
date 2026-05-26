/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

/**
 * 头指针 FIFO 队列。
 *
 * 替代「push + shift 消费」模式：原生 Array.shift() 是 O(n) 搬移，
 * 用头指针后 shift 成 O(1) 平均；当头指针前移超过 buffer 一半时整体压缩一次，
 * 避免内存无界增长。
 */
export class HeadPointerQueue {
  constructor() {
    this._items = [];
    this._head = 0;
  }

  get length() {
    return this._items.length - this._head;
  }

  push(item) {
    this._items.push(item);
  }

  shift() {
    if (this._head >= this._items.length) return undefined;
    const item = this._items[this._head];
    this._items[this._head] = undefined; // 解除引用，便于 GC
    this._head++;
    // 周期性压缩：头指针超过物理长度一半时整体重建
    if (this._head > 32 && this._head * 2 > this._items.length) {
      this._items = this._items.slice(this._head);
      this._head = 0;
    }
    return item;
  }

  peek() {
    return this._head < this._items.length ? this._items[this._head] : undefined;
  }

  clear() {
    this._items = [];
    this._head = 0;
  }

  /** 遍历当前有效元素（从头到尾） */
  forEach(callback) {
    for (let i = this._head; i < this._items.length; i++) {
      callback(this._items[i]);
    }
  }
}

/**
 * 固定容量环形缓冲，支持 push / pop / shift / 索引访问。
 *
 * 替代「Array.push + 超额 shift 淘汰」模式：原生 shift 是 O(n)，
 * 环形缓冲所有操作都是 O(1)。
 *
 * 索引语义：get(0) 永远是最旧元素，get(length-1) 永远是最新元素。
 *
 * @template T
 */
export class RingBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('RingBuffer capacity must be a positive integer');
    }
    this._capacity = capacity;
    this._buffer = new Array(capacity);
    this._head = 0; // 最旧元素物理下标
    this._size = 0;
  }

  get length() {
    return this._size;
  }

  get capacity() {
    return this._capacity;
  }

  /**
   * 入队尾部。容量已满时自动淘汰头部最旧元素。
   */
  push(item) {
    if (this._size < this._capacity) {
      this._buffer[(this._head + this._size) % this._capacity] = item;
      this._size++;
    } else {
      // 满：覆盖头部并前移
      this._buffer[this._head] = item;
      this._head = (this._head + 1) % this._capacity;
    }
  }

  /**
   * 弹出尾部（最新）元素。
   */
  pop() {
    if (this._size === 0) return undefined;
    this._size--;
    const idx = (this._head + this._size) % this._capacity;
    const item = this._buffer[idx];
    this._buffer[idx] = undefined;
    return item;
  }

  /**
   * 弹出头部（最旧）元素。
   */
  shift() {
    if (this._size === 0) return undefined;
    const item = this._buffer[this._head];
    this._buffer[this._head] = undefined;
    this._head = (this._head + 1) % this._capacity;
    this._size--;
    return item;
  }

  /**
   * 索引访问。i=0 → 最旧；i=length-1 → 最新。越界返回 undefined。
   */
  get(i) {
    if (i < 0 || i >= this._size) return undefined;
    return this._buffer[(this._head + i) % this._capacity];
  }

  at(i) {
    return this.get(i);
  }

  /** 最新元素 */
  last() {
    return this._size === 0 ? undefined : this.get(this._size - 1);
  }

  /** 最旧元素 */
  first() {
    return this._size === 0 ? undefined : this._buffer[this._head];
  }

  clear() {
    this._buffer = new Array(this._capacity);
    this._head = 0;
    this._size = 0;
  }

  /**
   * 调整容量。如果新容量小于当前元素数，最旧元素被截断。
   */
  resize(newCapacity) {
    if (!Number.isInteger(newCapacity) || newCapacity <= 0) {
      throw new Error('RingBuffer capacity must be a positive integer');
    }
    if (newCapacity === this._capacity) return;
    const items = this.toArray();
    this._capacity = newCapacity;
    this._buffer = new Array(newCapacity);
    this._head = 0;
    this._size = 0;
    // 截断最旧的，保留最新的 newCapacity 个
    const start = Math.max(0, items.length - newCapacity);
    for (let i = start; i < items.length; i++) this.push(items[i]);
  }

  /** 浅拷贝为普通数组（按 oldest→newest 顺序） */
  toArray() {
    const out = new Array(this._size);
    for (let i = 0; i < this._size; i++) {
      out[i] = this._buffer[(this._head + i) % this._capacity];
    }
    return out;
  }

  /**
   * 浅拷贝指定区间为普通数组（语义与 Array.prototype.slice 一致：[start, end)，支持省略 end）。
   */
  slice(start = 0, end = this._size) {
    if (start < 0) start = Math.max(0, this._size + start);
    if (end < 0) end = Math.max(0, this._size + end);
    end = Math.min(end, this._size);
    if (start >= end) return [];
    const out = new Array(end - start);
    for (let i = 0; i < end - start; i++) {
      out[i] = this._buffer[(this._head + start + i) % this._capacity];
    }
    return out;
  }

  /**
   * 用给定数组整体替换缓冲内容。多余的尾部 items 会按 push 语义淘汰最旧。
   * 用于 HistoryOptimizer 这类"压缩后整体回写"场景。
   */
  replace(items) {
    this.clear();
    for (const item of items) this.push(item);
  }

  /** 最后 n 个元素（按 oldest→newest 顺序） */
  lastN(n) {
    const count = Math.min(n, this._size);
    const out = new Array(count);
    const start = this._size - count;
    for (let i = 0; i < count; i++) {
      out[i] = this._buffer[(this._head + start + i) % this._capacity];
    }
    return out;
  }

  forEach(callback) {
    for (let i = 0; i < this._size; i++) {
      callback(this._buffer[(this._head + i) % this._capacity], i);
    }
  }

  *[Symbol.iterator]() {
    for (let i = 0; i < this._size; i++) {
      yield this._buffer[(this._head + i) % this._capacity];
    }
  }
}
