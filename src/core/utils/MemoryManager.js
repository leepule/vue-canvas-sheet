/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
export class MemoryManager {
  constructor() {
    this.allocations = new Map();
    this.totalAllocated = 0;
    this.maxMemory = 50 * 1024 * 1024; // 50MB
    this.warningThreshold = 0.8; // 80%
  }
  
  /**
   * 分配内存（跟踪）
   */
  allocate(id, size, object) {
    this.allocations.set(id, { size, object, timestamp: Date.now() });
    this.totalAllocated += size;
    
    // 检查内存使用
    this._checkMemory();
  }
  
  /**
   * 释放内存
   */
  deallocate(id) {
    const allocation = this.allocations.get(id);
    if (allocation) {
      this.totalAllocated -= allocation.size;
      this.allocations.delete(id);
    }
  }
  
  /**
   * 检查内存使用
   */
  _checkMemory() {
    const usage = this.totalAllocated / this.maxMemory;
    
    if (usage > this.warningThreshold) {
      console.warn(`[MemoryManager] Memory usage: ${(usage * 100).toFixed(1)}%`);
      this._triggerGC();
    }
  }
  
  /**
   * 触发垃圾回收
   */
  _triggerGC() {
    // 清理长期未使用的对象
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5分钟
    
    for (const [id, allocation] of this.allocations) {
      if (now - allocation.timestamp > staleThreshold) {
        this.deallocate(id);
      }
    }
  }
  
  /**
   * 获取内存统计
   */
  getStats() {
    return {
      totalAllocated: this.totalAllocated,
      allocations: this.allocations.size,
      usagePercent: (this.totalAllocated / this.maxMemory * 100).toFixed(2)
    };
  }
  
  /**
   * 强制清理所有
   */
  forceCleanup() {
    this.allocations.clear();
    this.totalAllocated = 0;
  }
}