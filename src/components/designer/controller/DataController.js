import { LazyLoader, ArrayAdapter, ScrollLoader } from '../../../core/utils/LazyLoader';

/**
 * @typedef {Object} DataControllerOptions - 数据控制器配置
 * @property {boolean} [lazyLoad=false] - 是否启用懒加载
 * @property {number} [pageSize=100] - 每页数据量
 * @property {number} [maxCachedPages=10] - 最大缓存页数
 * @property {number} [preloadPages=1] - 预加载页数
 */

export class DataController {
	/**
	 * 创建数据控制器
	 * @param {Workbook} workbook - 工作簿实例
	 * @param {Function} triggerUpdateCallback - 触发更新回调
	 * @param {DataControllerOptions} options - 配置选项
	 */
	constructor(workbook, triggerUpdateCallback, options = {}) {
		this.workbook = workbook;
		this.triggerUpdate = triggerUpdateCallback;
		this.bindings = [];
		this.initialData = null;
		
		/** @type {boolean} 数据是否已初始化 */
		this._dataInitialized = false;
		
		/** @type {Set<number>} 已删除的列索引集合 */
		this._deletedColumns = new Set();
		
		// 懒加载配置
		this._options = {
			lazyLoad: options.lazyLoad || false,
			pageSize: options.pageSize || 100,
			maxCachedPages: options.maxCachedPages || 10,
			preloadPages: options.preloadPages || 1
		};
		
		/** @type {LazyLoader|null} 懒加载器 */
		this._lazyLoader = null;
		
		/** @type {ScrollLoader|null} 滚动加载器 */
		this._scrollLoader = null;
		
		/** @type {ArrayDataAdapter|null} 数据适配器 */
		this._dataAdapter = null;
		
		/** @type {number} 已加载的起始行 */
		this._loadedStartRow = 0;
		
		/** @type {number} 已加载的结束行 */
		this._loadedEndRow = 0;
	}

	/**
	 * 设置初始数据
	 * @param {Array|Object} data - 数据
	 */
	setInitialData(data) {
		this.initialData = data;
		this._dataInitialized = false; // 重置初始化标志
		this._deletedColumns.clear(); // 清空已删除列记录
		
		// 如果启用懒加载，创建适配器
		if (this._options.lazyLoad && Array.isArray(data)) {
			this._dataAdapter = new ArrayAdapter(data);
			this._lazyLoader = new LazyLoader(this._dataAdapter, {
				pageSize: this._options.pageSize,
				maxCachedPages: this._options.maxCachedPages,
				preloadPages: this._options.preloadPages
			});
			
			this._scrollLoader = new ScrollLoader(this._lazyLoader, {
				loadThreshold: 200,
				onLoad: (loadedData, range) => {
					this._onLazyLoadData(loadedData, range);
				}
			});
		}
	}

	/**
	 * 懒加载数据回调
	 * @param {Array} data - 加载的数据
	 * @param {Object} range - 数据范围
	 * @private
	 */
	_onLazyLoadData(data, range) {
		if (!this.workbook || !data.length) return;
		
		const updates = [];
		const headerDepth = this.workbook.headerDepth || 0;
		
		// 应用绑定
		this.bindings.forEach(binding => {
			data.forEach((item, index) => {
				const targetR = headerDepth + range.start + index;
				const val = item[binding.field];
				updates.push({
					r: targetR,
					c: binding.col,
					val: { v: val }
				});
			});
		});
		
		if (updates.length > 0) {
			this.workbook.bulkSetCells(updates);
		}
		
		// 更新已加载范围
		this._loadedStartRow = Math.min(this._loadedStartRow, range.start);
		this._loadedEndRow = Math.max(this._loadedEndRow, range.end);
		
		if (this.triggerUpdate) this.triggerUpdate();
	}

	/**
	 * 渲染页面数据
	 * @param {boolean} [forceReset=false] - 是否强制重置数据
	 */
	renderPage(forceReset = false) {
		if (!this.workbook) return;

		const data = this.initialData || [];

		// 如果启用懒加载，使用懒加载模式
		if (this._options.lazyLoad && this._lazyLoader) {
			this._renderPageLazy();
			return;
		}

		// 核心优化：避免在有绑定时调用 setData，防止全量属性填充导致的 O(N*M) 单元格创建
		if (Array.isArray(data)) {
			const rowCount = data.length;
			const hasBindings = this.bindings.length > 0;

			if (!this._dataInitialized || forceReset) {
				if (hasBindings) {
					this.workbook.rowCount = Math.max(rowCount + 10, 1000);
					if (forceReset) this.workbook.clearCells();
				} else {
					this.workbook.setData(data);
				}
				this._dataInitialized = true;
			}

			if (hasBindings) {
				const updates = [];
				const bindingCount = this.bindings.length;

				// 1. 处理表头
				for (let i = 0; i < bindingCount; i++) {
					const binding = this.bindings[i];
					if (this._deletedColumns.has(binding.col)) continue;
					
					updates.push({
						r: binding.row,
						c: binding.col,
						val: {
							v: binding.name,
							s: { fontWeight: 'bold', align: 'center', bg: '#f8f8f9' }
						}
					});
				}

				// 2. 处理数据单元格 (使用高性能 for 循环)
				for (let i = 0; i < rowCount; i++) {
					const item = data[i];
					for (let j = 0; j < bindingCount; j++) {
						const binding = this.bindings[j];
						if (this._deletedColumns.has(binding.col)) continue;

						const val = item[binding.field];
						if (val !== undefined) {
							updates.push({
								r: binding.row + 1 + i,
								c: binding.col,
								val: { v: val }
							});
						}
					}
				}
				
				if (updates.length > 0) {
					this.workbook.bulkSetCells(updates);
				}
			}
		} else {
			this.workbook.setData(data);
		}

		if (this.triggerUpdate) this.triggerUpdate();
	}

	/**
	 * 懒加载模式渲染
	 * @private
	 */
	async _renderPageLazy() {
		// 初始化懒加载器
		await this._lazyLoader.init();
		
		const totalCount = this._lazyLoader.getTotalCount();
		const pageSize = this._options.pageSize;
		
		// 设置表头行
		const headerUpdates = [];
		this.bindings.forEach(binding => {
			headerUpdates.push({
				r: binding.row,
				c: binding.col,
				val: {
					v: binding.name,
					s: { fontWeight: 'bold', align: 'center', bg: '#f8f8f9' }
				}
			});
		});
		
		if (headerUpdates.length > 0) {
			this.workbook.bulkSetCells(headerUpdates);
		}
		
		// 设置初始行数
		const headerDepth = this.workbook.headerDepth || 0;
		this.workbook.rowCount = headerDepth + totalCount + 20;
		
		// 加载第一页数据
		const firstPageData = await this._lazyLoader.getRows(0, pageSize);
		this._onLazyLoadData(firstPageData, { start: 0, end: Math.min(pageSize, totalCount) });
		
		if (this.triggerUpdate) this.triggerUpdate();
	}

	/**
	 * 处理滚动事件（懒加载模式）
	 * @param {number} scrollTop - 滚动位置
	 * @param {number} viewportHeight - 视口高度
	 * @param {number} totalHeight - 总高度
	 * @param {number} rowHeight - 行高
	 * @returns {Promise<boolean>} 是否触发了加载
	 */
	async handleScroll(scrollTop, viewportHeight, totalHeight, rowHeight) {
		if (!this._scrollLoader) return false;
		
		this._scrollLoader.setRowHeight(rowHeight);
		return await this._scrollLoader.handleScroll(scrollTop, viewportHeight, totalHeight);
	}

	/**
	 * 获取指定范围的数据
	 * @param {number} startRow - 起始行
	 * @param {number} endRow - 结束行
	 * @returns {Promise<Array>}
	 */
	async getRows(startRow, endRow) {
		if (this._lazyLoader) {
			return await this._lazyLoader.getRows(startRow, endRow);
		}
		
		// 非懒加载模式，直接从初始数据切片
		if (Array.isArray(this.initialData)) {
			return this.initialData.slice(startRow, endRow);
		}
		return [];
	}

	/**
	 * 检查行是否已加载
	 * @param {number} rowIndex - 行索引
	 * @returns {boolean}
	 */
	isRowLoaded(rowIndex) {
		if (this._lazyLoader) {
			return this._lazyLoader.isRowLoaded(rowIndex);
		}
		return true; // 非懒加载模式认为所有行都已加载
	}

	/**
	 * 检查范围是否已加载
	 * @param {number} startRow - 起始行
	 * @param {number} endRow - 结束行
	 * @returns {boolean}
	 */
	isRangeLoaded(startRow, endRow) {
		if (this._lazyLoader) {
			return this._lazyLoader.isRangeLoaded(startRow, endRow);
		}
		return true;
	}

	/**
	 * 获取懒加载统计信息
	 * @returns {Object|null}
	 */
	getLazyLoadStats() {
		if (!this._lazyLoader) return null;
		return this._lazyLoader.getCacheStats();
	}

	/**
	 * 启用懒加载模式
	 * @param {Object} [options] - 配置选项
	 */
	enableLazyLoad(options = {}) {
		this._options = { ...this._options, ...options, lazyLoad: true };
		
		// 如果已有数据，重新初始化
		if (this.initialData && Array.isArray(this.initialData)) {
			this.setInitialData(this.initialData);
		}
	}

	/**
	 * 禁用懒加载模式
	 */
	disableLazyLoad() {
		this._options.lazyLoad = false;
		
		if (this._lazyLoader) {
			this._lazyLoader.destroy();
			this._lazyLoader = null;
		}
		
		if (this._scrollLoader) {
			this._scrollLoader.destroy();
			this._scrollLoader = null;
		}
		
		this._dataAdapter = null;
	}

	/**
	 * 刷新数据
	 * @param {number} [pageIndex] - 指定刷新的页面
	 */
	async refresh(pageIndex) {
		if (this._lazyLoader) {
			await this._lazyLoader.refresh(pageIndex);
			
			// 重新渲染
			this._loadedStartRow = 0;
			this._loadedEndRow = 0;
			await this._renderPageLazy();
		} else {
			this.renderPage();
		}
	}

	addBinding(field, row, col) {
		const existingIdx = this.bindings.findIndex(b => b.col === col && b.row === row);
		if (existingIdx > -1) {
			this.bindings.splice(existingIdx, 1);
		}

		this.bindings.push({
			row,
			col,
			field: field.field,
			name: field.name
		});

		this.renderPage();
	}

 /**
  * 移除列
  * @param {number} colIndex - 列索引
  */
 removeColumn(colIndex) {
  // 记录已删除的列（在列移动之前记录原始索引）
  // 注意：由于 workbook.deleteColumn 已经执行，列索引已经调整
  // 所以这里不需要清除 workbook 数据，只需要管理绑定
  
  // 移除该列的绑定
  this.bindings = this.bindings.filter(b => b.col !== colIndex);

  // 调整后续列的索引
  this.bindings.forEach(b => {
   if (b.col > colIndex) {
    b.col--;
   }
  });
  
  // 更新已删除列的记录（调整索引）
  const newDeletedColumns = new Set();
  this._deletedColumns.forEach(deletedCol => {
   if (deletedCol > colIndex) {
    newDeletedColumns.add(deletedCol - 1);
   } else if (deletedCol < colIndex) {
    newDeletedColumns.add(deletedCol);
   }
   // deletedCol === colIndex 的情况不需要保留（该列已被移除）
  });
  this._deletedColumns = newDeletedColumns;
 }

	/**
	 * 重置数据状态（用于重新加载数据）
	 */
	reset() {
		this._dataInitialized = false;
		this._deletedColumns.clear();
		this.bindings = [];
	}
	
	/**
	 * 销毁数据控制器
	 */
	destroy() {
		this.disableLazyLoad();
		this.workbook = null;
		this.initialData = null;
		this.bindings = [];
		this._dataInitialized = false;
		this._deletedColumns.clear();
	}
}
