/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { parseCellKey } from '../data/CellKey.js';
import { HeadPointerQueue } from './Queues.js';

/**
 * IndexedDB 存储层
 * 用于本地持久化存储表格数据，支持大数据集的离线存储和分页加载
 */

/**
 * 数据库配置
 */
const DB_CONFIG = {
	name: 'VueCanvasSheetDB',
	version: 1,
	stores: {
		cells: 'cells',           // 单元格数据
		metadata: 'metadata',     // 元数据（配置、版本等）
		snapshots: 'snapshots'    // 快照（用于撤销/重做）
	}
};

/**
 * IndexedDB 存储类
 * 提供表格数据的本地持久化存储
 */
export class IndexedDBStorage {
	/**
	 * 创建 IndexedDB 存储实例
	 * @param {Object} options - 配置选项
	 * @param {string} [options.dbName] - 数据库名称
	 * @param {number} [options.dbVersion] - 数据库版本
	 */
	constructor(options = {}) {
		this._dbName = options.dbName || DB_CONFIG.name;
		this._dbVersion = options.dbVersion || DB_CONFIG.version;
		/** @type {IDBDatabase|null} */
		this._db = null;
		this._isOpening = false;
		this._pendingOps = new HeadPointerQueue();
	}

	/**
	 * 初始化数据库连接
	 * @returns {Promise<IDBDatabase>}
	 */
	async init() {
		if (this._db) return this._db;
		if (!isIndexedDBSupported()) {
			throw new Error('IndexedDB is not supported in this environment.');
		}
		if (this._isOpening) {
			return new Promise((resolve, reject) => {
				this._pendingOps.push({ resolve, reject });
			});
		}

		this._isOpening = true;

		return new Promise((resolve, reject) => {
			const idb = typeof indexedDB !== 'undefined' ? indexedDB : window.indexedDB;
			const request = idb.open(this._dbName, this._dbVersion);

			request.onerror = () => {
				this._isOpening = false;
				this._flushPendingOps(null, request.error);
				reject(request.error);
			};

			request.onsuccess = () => {
				this._db = request.result;
				this._isOpening = false;
				this._flushPendingOps(this._db, null);
				resolve(this._db);
			};

			request.onupgradeneeded = (event) => {
				const db = event.target.result;
				this._createStores(db);
			};
		});
	}

	/**
	 * 创建对象存储
	 * @param {IDBDatabase} db - 数据库实例
	 * @private
	 */
	_createStores(db) {
		// 单元格存储
		if (!db.objectStoreNames.contains(DB_CONFIG.stores.cells)) {
			const cellStore = db.createObjectStore(DB_CONFIG.stores.cells, {
				keyPath: 'id'
			});
			// 创建索引，支持按工作表、行列查询
			cellStore.createIndex('sheetId', 'sheetId', { unique: false });
			cellStore.createIndex('row', 'row', { unique: false });
			cellStore.createIndex('col', 'col', { unique: false });
			cellStore.createIndex('sheetRow', ['sheetId', 'row'], { unique: false });
		}

		// 元数据存储
		if (!db.objectStoreNames.contains(DB_CONFIG.stores.metadata)) {
			db.createObjectStore(DB_CONFIG.stores.metadata, {
				keyPath: 'key'
			});
		}

		// 快照存储
		if (!db.objectStoreNames.contains(DB_CONFIG.stores.snapshots)) {
			const snapshotStore = db.createObjectStore(DB_CONFIG.stores.snapshots, {
				keyPath: 'id'
			});
			snapshotStore.createIndex('sheetId', 'sheetId', { unique: false });
			snapshotStore.createIndex('timestamp', 'timestamp', { unique: false });
		}
	}

	/**
	 * 处理等待中的操作
	 * @param {IDBDatabase|null} db - 数据库实例
	 * @param {Error|null} error - 错误
	 * @private
	 */
	_flushPendingOps(db, error) {
		while (this._pendingOps.length > 0) {
			const op = this._pendingOps.shift();
			if (error) {
				op.reject(error);
			} else {
				op.resolve(db);
			}
		}
	}

	/**
	 * 获取事务和对象存储
	 * @param {string} storeName - 存储名称
	 * @param {IDBTransactionMode} mode - 事务模式
	 * @returns {{ transaction: IDBTransaction, store: IDBObjectStore }}
	 * @private
	 */
	_getStore(storeName, mode = 'readonly') {
		if (!this._db) {
			throw new Error('Database not initialized. Call init() first.');
		}
		const transaction = this._db.transaction(storeName, mode);
		const store = transaction.objectStore(storeName);
		return { transaction, store };
	}

	// ==================== 单元格操作 ====================


	/**
	 * 批量保存单元格数据
	 * @param {string} sheetId - 工作表ID
	 * @param {Array<{row: number, col: number, data: Object}>} cells - 单元格数组
	 * @returns {Promise<void>}
	 */
	async saveCells(sheetId, cells) {
		if (!cells || cells.length === 0) return;
		await this.init();
		return new Promise((resolve, reject) => {
			const { transaction, store } = this._getStore(DB_CONFIG.stores.cells, 'readwrite');
			const timestamp = Date.now();

			cells.forEach(cell => {
				const id = `${sheetId}-${cell.row}-${cell.col}`;
				store.put({
					id,
					sheetId,
					row: cell.row,
					col: cell.col,
					data: cell.data,
					updatedAt: timestamp
				});
			});

			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
	}

	/**
	 * 增量同步 (Delta Sync)
	 * 仅保存发生变化的单元格数据
	 * @param {string} sheetId 
	 * @param {Map<string, Object>} diffs - Map<"r-c", cellData>
	 */
	async saveDiffs(sheetId, diffs) {
		if (!diffs || diffs.size === 0) return;
		await this.init();
		const cellArray = [];
		const deletions = [];
		diffs.forEach((data, key) => {
			// 使用统一的 parseCellKey 工具，兼容字符串格式 "r-c" 与旧 compact 整数格式，
			// 避免 split('-') 对旧格式 / 边缘格式悄悄丢弃数据。
			const { r, c } = parseCellKey(key);
			if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || c < 0) return;
			if (data === null || data === undefined) {
				deletions.push({ row: r, col: c });
			} else {
				cellArray.push({ row: r, col: c, data });
			}
		});
		if (cellArray.length === 0 && deletions.length === 0) return;

		return new Promise((resolve, reject) => {
			const { transaction, store } = this._getStore(DB_CONFIG.stores.cells, 'readwrite');
			const timestamp = Date.now();

			cellArray.forEach(cell => {
				const id = `${sheetId}-${cell.row}-${cell.col}`;
				store.put({
					id,
					sheetId,
					row: cell.row,
					col: cell.col,
					data: cell.data,
					updatedAt: timestamp
				});
			});

			deletions.forEach(cell => {
				store.delete(`${sheetId}-${cell.row}-${cell.col}`);
			});

			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
	}

	/**
	 * 获取单元格数据
	 * @param {string} sheetId - 工作表ID
	 * @param {number} row - 行号
	 * @param {number} col - 列号
	 * @returns {Promise<Object|null>}
	 */
	async getCell(sheetId, row, col) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.cells, 'readonly');
			const id = `${sheetId}-${row}-${col}`;
			const request = store.get(id);
			request.onsuccess = () => {
				resolve(request.result ? request.result.data : null);
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * 获取行范围内的单元格
	 * @param {string} sheetId - 工作表ID
	 * @param {number} startRow - 起始行
	 * @param {number} endRow - 结束行
	 * @returns {Promise<Array<{row: number, col: number, data: Object}>>}
	 */
	async getCellsByRowRange(sheetId, startRow, endRow) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.cells, 'readonly');
			const index = store.index('sheetRow');
			const range = IDBKeyRange.bound(
				[sheetId, startRow],
				[sheetId, endRow]
			);
			const request = index.openCursor(range);
			const results = [];

			request.onsuccess = (event) => {
				const cursor = event.target.result;
				if (cursor) {
					results.push({
						row: cursor.value.row,
						col: cursor.value.col,
						data: cursor.value.data
					});
					cursor.continue();
				} else {
					resolve(results);
				}
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * 获取工作表的所有单元格
	 * @param {string} sheetId - 工作表ID
	 * @returns {Promise<Array<{row: number, col: number, data: Object}>>}
	 */
	async getAllCells(sheetId) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.cells, 'readonly');
			const index = store.index('sheetId');
			const request = index.getAll(IDBKeyRange.only(sheetId));
			request.onsuccess = () => {
				resolve(request.result.map(item => ({
					row: item.row,
					col: item.col,
					data: item.data
				})));
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * 删除单元格
	 * @param {string} sheetId - 工作表ID
	 * @param {number} row - 行号
	 * @param {number} col - 列号
	 * @returns {Promise<void>}
	 */
	async deleteCell(sheetId, row, col) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.cells, 'readwrite');
			const id = `${sheetId}-${row}-${col}`;
			const request = store.delete(id);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * 清空工作表的所有单元格
	 * @param {string} sheetId - 工作表ID
	 * @returns {Promise<void>}
	 */
	async clearSheet(sheetId) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { transaction, store } = this._getStore(DB_CONFIG.stores.cells, 'readwrite');
			const index = store.index('sheetId');
			const request = index.openCursor(IDBKeyRange.only(sheetId));

			request.onsuccess = (event) => {
				const cursor = event.target.result;
				if (cursor) {
					cursor.delete();
					cursor.continue();
				}
			};

			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
	}

	// ==================== 元数据操作 ====================

	/**
	 * 保存元数据
	 * @param {string} key - 键名
	 * @param {*} value - 值
	 * @returns {Promise<void>}
	 */
	async saveMetadata(key, value) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.metadata, 'readwrite');
			const request = store.put({
				key,
				value,
				updatedAt: Date.now()
			});
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * 获取元数据
	 * @param {string} key - 键名
	 * @returns {Promise<*>}
	 */
	async getMetadata(key) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.metadata, 'readonly');
			const request = store.get(key);
			request.onsuccess = () => {
				resolve(request.result ? request.result.value : null);
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * 删除元数据
	 * @param {string} key - 键名
	 * @returns {Promise<void>}
	 */
	async deleteMetadata(key) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.metadata, 'readwrite');
			const request = store.delete(key);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	// ==================== 快照操作 ====================

	/**
	 * 保存快照
	 * @param {string} sheetId - 工作表ID
	 * @param {string} snapshotId - 快照ID
	 * @param {Object} data - 快照数据
	 * @returns {Promise<void>}
	 */
	async saveSnapshot(sheetId, snapshotId, data) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.snapshots, 'readwrite');
			const request = store.put({
				id: `${sheetId}-${snapshotId}`,
				sheetId,
				snapshotId,
				data,
				timestamp: Date.now()
			});
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * 获取快照
	 * @param {string} sheetId - 工作表ID
	 * @param {string} snapshotId - 快照ID
	 * @returns {Promise<Object|null>}
	 */
	async getSnapshot(sheetId, snapshotId) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.snapshots, 'readonly');
			const id = `${sheetId}-${snapshotId}`;
			const request = store.get(id);
			request.onsuccess = () => {
				resolve(request.result ? request.result.data : null);
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * 获取工作表的最近快照列表
	 * @param {string} sheetId - 工作表ID
	 * @param {number} [limit=10] - 最大数量
	 * @returns {Promise<Array<{snapshotId: string, timestamp: number}>>}
	 */
	async getRecentSnapshots(sheetId, limit = 10) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.snapshots, 'readonly');
			const index = store.index('sheetId');
			const request = index.openCursor(IDBKeyRange.only(sheetId), 'prev');
			const results = [];

			request.onsuccess = (event) => {
				const cursor = event.target.result;
				if (cursor && results.length < limit) {
					results.push({
						snapshotId: cursor.value.snapshotId,
						timestamp: cursor.value.timestamp
					});
					cursor.continue();
				} else {
					resolve(results);
				}
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * 删除快照
	 * @param {string} sheetId - 工作表ID
	 * @param {string} snapshotId - 快照ID
	 * @returns {Promise<void>}
	 */
	async deleteSnapshot(sheetId, snapshotId) {
		await this.init();
		return new Promise((resolve, reject) => {
			const { store } = this._getStore(DB_CONFIG.stores.snapshots, 'readwrite');
			const id = `${sheetId}-${snapshotId}`;
			const request = store.delete(id);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	// ==================== 工作表完整操作 ====================

	/**
	 * 导出工作表完整数据
	 * @param {string} sheetId - 工作表ID
	 * @returns {Promise<Object>}
	 */
	async exportSheet(sheetId) {
		const cells = await this.getAllCells(sheetId);
		const config = await this.getMetadata(`config-${sheetId}`);
		
		// 转换为 Workbook 兼容格式
		const data = {};
		cells.forEach(cell => {
			const key = `${cell.row}-${cell.col}`;
			data[key] = cell.data;
		});

		return {
			data,
			config,
			exportedAt: Date.now()
		};
	}

	/**
	 * 导入工作表完整数据
	 * @param {string} sheetId - 工作表ID
	 * @param {Object} sheetData - 工作表数据
	 * @returns {Promise<void>}
	 */
	async importSheet(sheetId, sheetData) {
		await this.init();
		
		// 清空现有数据
		await this.clearSheet(sheetId);

		// 导入单元格数据
		if (sheetData.data) {
			const cells = [];
			for (const [key, cellData] of Object.entries(sheetData.data)) {
				const { r: row, c: col } = parseCellKey(key);
				if (row < 0 || col < 0) continue;
				cells.push({ row, col, data: cellData });
			}
			await this.saveCells(sheetId, cells);
		}

		// 保存配置
		if (sheetData.config) {
			await this.saveMetadata(`config-${sheetId}`, sheetData.config);
		}
	}

	// ==================== 数据库管理 ====================

	/**
	 * 获取数据库统计信息
	 * @returns {Promise<Object>}
	 */
	async getStats() {
		await this.init();
		
		const getStoreCount = (storeName) => {
			return new Promise((resolve, reject) => {
				const { store } = this._getStore(storeName, 'readonly');
				const request = store.count();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		};

		const [cellsCount, metadataCount, snapshotsCount] = await Promise.all([
			getStoreCount(DB_CONFIG.stores.cells),
			getStoreCount(DB_CONFIG.stores.metadata),
			getStoreCount(DB_CONFIG.stores.snapshots)
		]);

		return {
			cellsCount,
			metadataCount,
			snapshotsCount,
			dbName: this._dbName,
			dbVersion: this._dbVersion
		};
	}

	/**
	 * 清空所有数据
	 * @returns {Promise<void>}
	 */
	async clearAll() {
		await this.init();
		
		const clearStore = (storeName) => {
			return new Promise((resolve, reject) => {
				const { transaction, store } = this._getStore(storeName, 'readwrite');
				const request = store.clear();
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
			});
		};

		await Promise.all([
			clearStore(DB_CONFIG.stores.cells),
			clearStore(DB_CONFIG.stores.metadata),
			clearStore(DB_CONFIG.stores.snapshots)
		]);
	}

	/**
	 * 关闭数据库连接
	 */
	close() {
		if (this._db) {
			this._db.close();
			this._db = null;
		}
	}

	/**
	 * 删除整个数据库
	 * @returns {Promise<void>}
	 */
	async deleteDatabase() {
		this.close();
		return new Promise((resolve, reject) => {
			const request = indexedDB.deleteDatabase(this._dbName);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * 销毁实例
	 */
	destroy() {
		this.close();
		this._pendingOps.clear();
	}
}

/**
 * 创建 IndexedDB 存储实例
 * @param {Object} options - 配置选项
 * @returns {IndexedDBStorage}
 */
export function createIndexedDBStorage(options = {}) {
	return new IndexedDBStorage(options);
}

/**
 * 检查 IndexedDB 是否可用
 * @returns {boolean}
 */
export function isIndexedDBSupported() {
	try {
		const idb = typeof indexedDB !== 'undefined' ? indexedDB : (typeof window !== 'undefined' ? window.indexedDB : null);
		return idb !== null && idb !== undefined;
	} catch {
		return false;
	}
}

// 导出默认实例
export default IndexedDBStorage;
