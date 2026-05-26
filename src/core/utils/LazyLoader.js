/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * @typedef {Object} DataSourceAdapter - 数据源适配器接口
 * @property {Function} getTotalCount - 获取总记录数 () => Promise<number>
 * @property {Function} fetchRange - 获取指定范围数据 (start, end) => Promise<Array>
 * @property {Function} [onLoad] - 数据加载回调 (data, range) => void
 */

/**
 * @typedef {Object} LazyLoaderOptions - 懒加载配置
 * @property {number} [pageSize=100] - 每页数据量
 * @property {number} [preloadThreshold=0.5] - 预加载阈值（距离已加载区域的比例）
 * @property {number} [maxCachedPages=10] - 最大缓存页数
 * @property {number} [preloadPages=1] - 预加载页数
 */

/**
 * @typedef {Object} PageCache - 页面缓存
 * @property {number} pageIndex - 页索引
 * @property {Array} data - 页数据
 * @property {number} timestamp - 缓存时间戳
 * @property {boolean} loading - 是否正在加载
 */

/**
 * 数组数据源适配器
 * 适用于数据已在内存中，但需要按需切片的场景
 */
export class ArrayAdapter {
  /**
   * @param {Array} data - 数据数组
   */
  constructor(data) {
    this._data = data || [];
    this._totalCount = this._data.length;
  }

  /**
   * 获取总记录数
   * @returns {Promise<number>}
   */
  async getTotalCount() {
    return this._totalCount;
  }

  /**
   * 获取指定范围数据
   * @param {number} start - 起始索引
   * @param {number} end - 结束索引（不包含）
   * @returns {Promise<Array>}
   */
  async fetchRange(start, end) {
    return this._data.slice(start, Math.min(end, this._totalCount));
  }

  /**
   * 更新数据源
   * @param {Array} data - 新数据数组
   */
  setData(data) {
    this._data = data || [];
    this._totalCount = this._data.length;
  }

  /**
   * 获取原始数据
   * @returns {Array}
   */
  getRawData() {
    return this._data;
  }
}

/**
 * API 数据源适配器
 * 适用于从服务器分页获取数据的场景
 */
export class APIArrayAdapter {
  /**
   * @param {Object} options - 配置选项
   * @param {string|Function} options.fetchFn - 获取数据的函数或 URL
   * @param {Function} [options.countFn] - 获取总数的函数
   * @param {Object} [options.params] - 额外参数
   * @param {number} [options.timeout=30000] - 请求超时时间
   */
  constructor(options) {
    this._fetchFn = options.fetchFn;
    this._countFn = options.countFn;
    this._params = options.params || {};
    this._timeout = options.timeout || 30000;
    this._totalCount = null;
    this._totalCountPromise = null;
  }

  /**
   * 获取总记录数
   * @returns {Promise<number>}
   */
  async getTotalCount() {
    if (this._totalCount !== null) {
      return this._totalCount;
    }

    // 避免重复请求
    if (this._totalCountPromise) {
      return this._totalCountPromise;
    }

    this._totalCountPromise = this._fetchCount();
    return this._totalCountPromise;
  }

  async _fetchCount() {
    if (this._countFn) {
      this._totalCount = await this._countFn(this._params);
      return this._totalCount;
    }

    // 如果没有单独的计数函数，尝试从首次请求中获取
    const result = await this._fetchPage(0, 1);
    if (result && result.total !== undefined) {
      this._totalCount = result.total;
    } else {
      this._totalCount = 0;
    }
    return this._totalCount;
  }

  /**
   * 获取指定范围数据
   * @param {number} start - 起始索引
   * @param {number} end - 结束索引（不包含）
   * @returns {Promise<Array>}
   */
  async fetchRange(start, end) {
    const result = await this._fetchPage(start, end - start);
    
    if (result && result.data) {
      // 如果响应包含总数，更新缓存
      if (result.total !== undefined && this._totalCount === null) {
        this._totalCount = result.total;
      }
      return result.data;
    }
    
    return result || [];
  }

  async _fetchPage(offset, limit) {
    if (typeof this._fetchFn === 'function') {
      return await this._withTimeout(
        this._fetchFn({ offset, limit, ...this._params })
      );
    }

    // 如果是 URL 字符串
    if (typeof this._fetchFn === 'string') {
      const url = `${this._fetchFn}?offset=${offset}&limit=${limit}`;
      const response = await this._withTimeout(
        fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        }).then(res => res.json())
      );
      return response;
    }

    throw new Error('Invalid fetch function or URL');
  }

  async _withTimeout(promise) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, this._timeout);

      promise
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * 更新请求参数
   * @param {Object} params - 新参数
   */
  setParams(params) {
    this._params = { ...this._params, ...params };
    // 参数变化后需要重新获取总数
    this._totalCount = null;
    this._totalCountPromise = null;
  }

  /**
   * 重置缓存
   */
  reset() {
    this._totalCount = null;
    this._totalCountPromise = null;
  }
}

/**
 * 懒加载管理器
 * 管理数据的按需加载、缓存和预加载
 */
export class LazyLoader {
  /**
   * @param {DataSourceAdapter} dataSource - 数据源适配器
   * @param {LazyLoaderOptions} options - 配置选项
   */
  constructor(dataSource, options = {}) {
    /** @type {DataSourceAdapter} */
    this._dataSource = dataSource;
    
    /** @type {LazyLoaderOptions} */
    this._options = {
      pageSize: options.pageSize || 100,
      preloadThreshold: options.preloadThreshold || 0.5,
      maxCachedPages: options.maxCachedPages || 10,
      preloadPages: options.preloadPages || 1,
      ...options
    };

    /** @type {Map<number, PageCache>} 页面缓存 */
    this._pageCache = new Map();
    
    /** @type {Map<number, Promise<Array>>>} 加载中的页面 */
    this._loadingPages = new Map();
    
    /** @type {number} 总记录数 */
    this._totalCount = null;
    
    /** @type {boolean} 是否已初始化 */
    this._initialized = false;
    
    /** @type {Array<Function>} 数据加载回调 */
    this._onDataLoad = [];
    
    /** @type {Array<Function>} 加载状态变化回调 */
    this._onLoadingChange = [];
    
    /** @type {boolean} 是否正在加载 */
    this._isLoading = false;
    
    /** @type {LRUCache} LRU 缓存管理 */
    this._lruList = [];
  }

  /**
   * 初始化懒加载器
   * @returns {Promise<number>} 总记录数
   */
  async init() {
    if (this._initialized) {
      return this._totalCount;
    }

    this._totalCount = await this._dataSource.getTotalCount();
    this._initialized = true;
    return this._totalCount;
  }

  /**
   * 获取总记录数
   * @returns {number}
   */
  getTotalCount() {
    return this._totalCount || 0;
  }

  /**
   * 获取总页数
   * @returns {number}
   */
  getTotalPages() {
    if (this._totalCount === null) return 0;
    return Math.ceil(this._totalCount / this._options.pageSize);
  }

  /**
   * 获取指定行范围的数据
   * @param {number} startRow - 起始行索引
   * @param {number} endRow - 结束行索引（不包含）
   * @returns {Promise<Array>} 数据数组
   */
  async getRows(startRow, endRow) {
    if (!this._initialized) {
      await this.init();
    }

    // 边界检查
    if (startRow < 0) startRow = 0;
    if (endRow > this._totalCount) endRow = this._totalCount;
    if (startRow >= endRow) return [];

    const pageSize = this._options.pageSize;
    const startPage = Math.floor(startRow / pageSize);
    const endPage = Math.ceil(endRow / pageSize);

    // 收集需要加载的页面
    const pagesToLoad = [];
    for (let p = startPage; p < endPage; p++) {
      pagesToLoad.push(p);
    }

    // 并行加载所有需要的页面
    const loadPromises = pagesToLoad.map(p => this._loadPage(p));
    await Promise.all(loadPromises);

    // 组装结果
    const result = [];
    for (let p = startPage; p < endPage; p++) {
      const pageData = this._getPageData(p);
      if (pageData) {
        const pageStart = p * pageSize;
        const pageEnd = pageStart + pageSize;
        
        // 计算当前页面中需要的行
        const needStart = Math.max(startRow, pageStart);
        const needEnd = Math.min(endRow, pageEnd);
        
        for (let i = needStart - pageStart; i < needEnd - pageStart; i++) {
          if (pageData[i] !== undefined) {
            result.push(pageData[i]);
          }
        }
      }
    }

    // 触发预加载
    this._triggerPreload(endPage);

    return result;
  }

  /**
   * 获取单行数据
   * @param {number} rowIndex - 行索引
   * @returns {Promise<Object|null>} 行数据
   */
  async getRow(rowIndex) {
    const rows = await this.getRows(rowIndex, rowIndex + 1);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * 加载指定页面
   * @param {number} pageIndex - 页索引
   * @returns {Promise<Array>}
   * @private
   */
  async _loadPage(pageIndex) {
    // 检查缓存
    const cached = this._pageCache.get(pageIndex);
    if (cached && cached.data) {
      this._updateLRU(pageIndex);
      return cached.data;
    }

    // 检查是否正在加载
    const loading = this._loadingPages.get(pageIndex);
    if (loading) {
      return loading;
    }

    // 开始加载
    this._setLoading(true);
    const pageSize = this._options.pageSize;
    const start = pageIndex * pageSize;
    const end = Math.min(start + pageSize, this._totalCount);

    const loadPromise = this._dataSource.fetchRange(start, end)
      .then(data => {
        // 存入缓存
        this._setPageData(pageIndex, data);
        this._loadingPages.delete(pageIndex);
        this._setLoading(false);
        
        // 触发回调
        this._notifyDataLoad(data, { start, end, pageIndex });
        
        return data;
      })
      .catch(error => {
        this._loadingPages.delete(pageIndex);
        this._setLoading(false);
        throw error;
      });

    this._loadingPages.set(pageIndex, loadPromise);
    return loadPromise;
  }

  /**
   * 获取页面缓存数据
   * @param {number} pageIndex - 页索引
   * @returns {Array|null}
   * @private
   */
  _getPageData(pageIndex) {
    const cached = this._pageCache.get(pageIndex);
    return cached ? cached.data : null;
  }

  /**
   * 设置页面缓存数据
   * @param {number} pageIndex - 页索引
   * @param {Array} data - 页数据
   * @private
   */
  _setPageData(pageIndex, data) {
    // 检查是否需要淘汰缓存
    while (this._pageCache.size >= this._options.maxCachedPages) {
      this._evictLRU();
    }

    this._pageCache.set(pageIndex, {
      pageIndex,
      data,
      timestamp: Date.now(),
      loading: false
    });
    
    this._updateLRU(pageIndex);
  }

  /**
   * 更新 LRU 列表
   * @param {number} pageIndex - 页索引
   * @private
   */
  _updateLRU(pageIndex) {
    // 移除旧位置
    const idx = this._lruList.indexOf(pageIndex);
    if (idx !== -1) {
      this._lruList.splice(idx, 1);
    }
    // 添加到最前面（最近使用）
    this._lruList.unshift(pageIndex);
  }

  /**
   * 淘汰最久未使用的页面
   * @private
   */
  _evictLRU() {
    if (this._lruList.length === 0) return;
    
    const evictPage = this._lruList.pop();
    this._pageCache.delete(evictPage);
  }

  /**
   * 触发预加载
   * @param {number} currentPage - 当前页面
   * @private
   */
  _triggerPreload(currentPage) {
    const preloadPages = this._options.preloadPages;
    const totalPages = this.getTotalPages();

    // 异步预加载后续页面
    for (let i = 1; i <= preloadPages; i++) {
      const nextPage = currentPage + i - 1;
      if (nextPage < totalPages && !this._pageCache.has(nextPage)) {
        // 不等待预加载完成
        this._loadPage(nextPage).catch(() => {
          // 预加载失败不处理
        });
      }
    }
  }

  /**
   * 设置加载状态
   * @param {boolean} loading
   * @private
   */
  _setLoading(loading) {
    if (this._isLoading !== loading) {
      this._isLoading = loading;
      this._onLoadingChange.forEach(cb => cb(loading));
    }
  }

  /**
   * 触发数据加载回调
   * @param {Array} data
   * @param {Object} range
   * @private
   */
  _notifyDataLoad(data, range) {
    this._onDataLoad.forEach(cb => cb(data, range));
  }

  /**
   * 注册数据加载回调
   * @param {Function} callback
   * @returns {Function} 取消注册函数
   */
  onDataLoad(callback) {
    this._onDataLoad.push(callback);
    return () => {
      const idx = this._onDataLoad.indexOf(callback);
      if (idx !== -1) {
        this._onDataLoad.splice(idx, 1);
      }
    };
  }

  /**
   * 注册加载状态变化回调
   * @param {Function} callback
   * @returns {Function} 取消注册函数
   */
  onLoadingChange(callback) {
    this._onLoadingChange.push(callback);
    return () => {
      const idx = this._onLoadingChange.indexOf(callback);
      if (idx !== -1) {
        this._onLoadingChange.splice(idx, 1);
      }
    };
  }

  /**
   * 检查行是否已加载
   * @param {number} rowIndex - 行索引
   * @returns {boolean}
   */
  isRowLoaded(rowIndex) {
    const pageIndex = Math.floor(rowIndex / this._options.pageSize);
    return this._pageCache.has(pageIndex);
  }

  /**
   * 检查行范围是否已加载
   * @param {number} startRow - 起始行
   * @param {number} endRow - 结束行
   * @returns {boolean}
   */
  isRangeLoaded(startRow, endRow) {
    const pageSize = this._options.pageSize;
    const startPage = Math.floor(startRow / pageSize);
    const endPage = Math.ceil(endRow / pageSize);

    for (let p = startPage; p < endPage; p++) {
      if (!this._pageCache.has(p)) return false;
    }
    return true;
  }

  /**
   * 获取缓存统计信息
   * @returns {Object}
   */
  getCacheStats() {
    return {
      totalPages: this.getTotalPages(),
      cachedPages: this._pageCache.size,
      maxCachedPages: this._options.maxCachedPages,
      pageSize: this._options.pageSize,
      totalCount: this._totalCount,
      isLoading: this._isLoading
    };
  }

  /**
   * 清空缓存
   */
  clearCache() {
    this._pageCache.clear();
    this._loadingPages.clear();
    this._lruList = [];
  }

  /**
   * 重置懒加载器
   */
  async reset() {
    this.clearCache();
    this._totalCount = null;
    this._initialized = false;
    
    if (this._dataSource.reset) {
      this._dataSource.reset();
    }
  }

  /**
   * 刷新数据（清空缓存并重新加载）
   * @param {number} [pageIndex] - 指定刷新的页面，不指定则刷新所有
   */
  async refresh(pageIndex) {
    if (pageIndex !== undefined) {
      this._pageCache.delete(pageIndex);
      await this._loadPage(pageIndex);
    } else {
      this.clearCache();
      await this.init();
    }
  }

  /**
   * 销毁懒加载器
   */
  destroy() {
    this.clearCache();
    this._onDataLoad = [];
    this._onLoadingChange = [];
    this._dataSource = null;
  }
}

/**
 * 滚动加载管理器
 * 与滚动事件配合，自动触发数据加载
 */
export class ScrollLoader {
  /**
   * @param {LazyLoader} lazyLoader - 懒加载器
   * @param {Object} options - 配置选项
   * @param {number} [options.loadThreshold=200] - 触发加载的阈值（像素）
   * @param {Function} [options.onLoad] - 加载回调
   */
  constructor(lazyLoader, options = {}) {
    this._lazyLoader = lazyLoader;
    this._options = {
      loadThreshold: options.loadThreshold || 200,
      onLoad: options.onLoad
    };
    
    this._lastLoadRow = 0;
    this._isLoading = false;
    this._scrollHandler = null;
    this._rowHeight = 25; // 默认行高
  }

  /**
   * 设置行高
   * @param {number} height
   */
  setRowHeight(height) {
    this._rowHeight = height;
  }

  /**
   * 处理滚动事件
   * @param {number} scrollTop - 滚动位置
   * @param {number} viewportHeight - 视口高度
   * @param {number} totalHeight - 总高度
   * @returns {Promise<boolean>} 是否触发了加载
   */
  async handleScroll(scrollTop, viewportHeight, totalHeight) {
    // 计算当前可见范围
    const startRow = Math.floor(scrollTop / this._rowHeight);
    const endRow = Math.ceil((scrollTop + viewportHeight) / this._rowHeight);
    
    // 计算距离底部的距离
    const distanceToBottom = totalHeight - (scrollTop + viewportHeight);
    
    // 检查是否需要加载更多
    if (distanceToBottom < this._options.loadThreshold) {
      // 计算需要加载的行范围
      const totalCount = this._lazyLoader.getTotalCount();
      if (endRow < totalCount && !this._isLoading) {
        this._isLoading = true;
        
        try {
          // 加载下一批数据
          const loadStart = endRow;
          const loadEnd = Math.min(
            endRow + this._lazyLoader._options.pageSize,
            totalCount
          );
          
          const data = await this._lazyLoader.getRows(loadStart, loadEnd);
          
          if (this._options.onLoad) {
            this._options.onLoad(data, { start: loadStart, end: loadEnd });
          }
          
          this._lastLoadRow = loadEnd;
          return true;
        } finally {
          this._isLoading = false;
        }
      }
    }
    
    return false;
  }

  /**
   * 重置滚动加载器
   */
  reset() {
    this._lastLoadRow = 0;
    this._isLoading = false;
  }

  /**
   * 销毁滚动加载器
   */
  destroy() {
    this.reset();
    this._lazyLoader = null;
  }
}

// 默认导出
export default LazyLoader;