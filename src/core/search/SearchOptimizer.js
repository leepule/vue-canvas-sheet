/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { getDefaultWorkerPoolSize } from '../worker/WorkerClient.js';

export class SearchOptimizer {
  constructor(searchEngine) {
    this.search = searchEngine;

    // 搜索结果缓存
    this.resultCache = new Map();
    this.cacheTimeout = 5000; // 5秒缓存

    // 并行搜索配置
    this.parallelThreshold = 1000; // 超过1000个单元格使用并行搜索
  }
  
  /**
   * 带缓存的查找
   */
  findWithCache(query, startFrom, options = {}) {
    const cacheKey = this._getCacheKey(query, startFrom, options);
    const cached = this.resultCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.result;
    }
    
    const result = this.search.find(query, startFrom, options);
    this.resultCache.set(cacheKey, {
      result,
      timestamp: Date.now()
    });
    
    return result;
  }

  /**
   * 并行查找所有匹配
   */
  findAllParallel(query, options = {}) {
    this.search._ensureIndex();
    const index = this.search.cache.index;
    
    // 如果索引太小，直接主线程处理
    if (index.length < this.parallelThreshold) {
      return this.search.findAll(query, options);
    }
    
    const poolSize = getDefaultWorkerPoolSize();
    // 分块并行处理
    const chunkSize = Math.ceil(index.length / poolSize);
    const chunks = [];
    
    for (let i = 0; i < index.length; i += chunkSize) {
      chunks.push(index.slice(i, i + chunkSize));
    }
    
    // 优先使用 Web Workers
    if (typeof Worker !== 'undefined') {
      return this._parallelSearchWithWorkers(chunks, query, options);
    }
    
    // 降级到主线程分块（避免主线程长时间阻塞）
    return this._parallelSearchInChunks(chunks, query, options);
  }

  /**
   * 主线程分块查找（带延时或分段执行的逻辑，这里简化为同步但按块处理）
   */
  _parallelSearchInChunks(chunks, query, options) {
    const results = [];
    const parsedQuery = this.search._parseQuery(query, options);
    
    for (const chunk of chunks) {
      for (const cellRef of chunk) {
        // 优先使用索引中的预存值 v
        const val = cellRef.v !== undefined ? cellRef.v : this.search._getCellByRef(cellRef)?.v;
        if (this.search._matchValue(val, parsedQuery, options)) {
          results.push({ r: cellRef.r, c: cellRef.c });
        }
      }
    }
    
    return results;
  }

  /**
   * Web Worker 并行搜索（使用常驻线程池）
   */
  async _parallelSearchWithWorkers(chunks, query, options) {
    const { getSearchWorkerPool } = await import('../worker/SearchWorkerPool.js');
    const pool = getSearchWorkerPool();
    
    try {
      const results = await Promise.all(
        chunks.map(chunk => pool.execute({ chunk, query, options }))
      );
      return results.flat();
    } catch (err) {
      console.error('[SearchOptimizer] Parallel search error, falling back to main thread:', err);
      return this._parallelSearchInChunks(chunks, query, options);
    }
  }
  
  _getCacheKey(query, startFrom, options) {
    return `${query}|${startFrom.r},${startFrom.c}|${JSON.stringify(options)}`;
  }

  clearCache() {
    this.resultCache.clear();
  }
}
