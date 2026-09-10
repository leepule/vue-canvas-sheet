/**
 * 持久化管理器 — 管理 IndexedDB 存储的读写、增量同步与定时自动保存。
 *
 * @typedef {Object} PersistenceConfig
 * @property {number} rowCount
 * @property {number} colCount
 * @property {Object} colWidths
 * @property {Object} rowHeights
 * @property {Array} merges
 * @property {Map} mergeMap
 * @property {number} defaultColWidth
 * @property {number} defaultRowHeight
 * @property {{r:number,c:number}} freeze
 *
 * @typedef {Object} PersistenceManagerDeps
 * @property {() => IndexedDBStorage|null}   getStorage            — 获取 IndexedDB 实例
 * @property {(s: IndexedDBStorage) => void} setStorage            — 设置 IndexedDB 实例
 * @property {() => Map<string, Object>}     getDirtyCells         — 获取脏单元格映射
 * @property {(m: Map) => void}              setDirtyCells         — 设置脏单元格映射
 * @property {() => string}                  getSheetId            — 当前表格 ID
 * @property {(id: string) => void}          setSheetId            — 设置表格 ID
 * @property {() => boolean}                 getEnablePersistence  — 是否启用持久化
 * @property {(v: boolean) => void}          setEnablePersistence  — 设置持久化开关
 * @property {() => PersistenceConfig}       snapshotConfig        — 快照行列/尺寸/合并等布局配置（替代 8 个独立 getter）
 * @property {(cfg: PersistenceConfig) => void} applyConfig       — 批量应用布局配置（替代 8 个独立 setter）
 * @property {() => SparseMatrix}            getDataMatrix         — 数据矩阵引用
 * @property {(k: string) => {r:number,c:number}} parseKey       — 键解析器
 * @property {(r: number, c: number, v: any) => void} setCell    — 设置单元格
 * @property {(r: number, c: number, v: any) => void} syncSharedValue — 同步单元格值到 WASM 共享内存
 * @property {() => void}                    rebuildDependencyMap  — 重建公式依赖图
 * @property {() => void}                    markOffsetsDirty      — 标记布局偏移失效
 * @property {() => number|null}             getPersistTimer       — 获取持久化定时器 ID
 * @property {(t: number) => void}           setPersistTimer       — 设置持久化定时器 ID
 * @property {(...args: any[]) => void}      notify                — UI 通知
 */

import { cellKey } from './data/CellKey.js';
import { IndexedDBStorage } from './utils/IndexedDBStorage.js';
export class PersistenceManager {
  /**
   * @param {PersistenceManagerDeps} deps — 具名依赖注入，详见 PersistenceManagerDeps typedef
   */
  constructor(deps) {
    /** @type {PersistenceManagerDeps} */
    this.d = deps;
    this._configRevision = deps.getStorage() ? 1 : 0;
    this._persistedConfigRevision = 0;
    this._flushPromise = null;
    this._destroyed = false;
  }

  async persist(sheetId = 'default') {
    const storage = this.d.getStorage();
    if (!storage) return;

    const config = this.d.snapshotConfig ? this.d.snapshotConfig() : {};

    const data = {};
    this.d.getDataMatrix().forEach((r, c, cell) => {
      data[cellKey(r, c)] = cell;
    });
    await storage.importSheet(sheetId, { data, config });
  }

  enablePersistenceStorage(options = {}) {
    const storage = this.d.getStorage();
    if (!storage) {
      this.d.setStorage(new IndexedDBStorage(options.storageOptions || {}));
    }
    if (!this.d.getDirtyCells()) {
      this.d.setDirtyCells(new Map());
    }
    if (options.sheetId) {
      this.d.setSheetId(options.sheetId);
    }
    this.d.setEnablePersistence(true);
    this.markConfigDirty();
    return this.d.getStorage();
  }

  async loadFromStorage(sheetId = 'default') {
    const storage = this.d.getStorage();
    if (!storage) return false;

    const sheetData = await storage.exportSheet(sheetId);
    if (!sheetData || !sheetData.config) return false;

    const { config, data } = sheetData;

    // 批量应用布局配置（替代 8 个独立 setter，减少 deps 回调数）
    if (this.d.applyConfig) {
      this.d.applyConfig(config);
    }
    this._persistedConfigRevision = this._configRevision;

    const dataMatrix = this.d.getDataMatrix();
    dataMatrix.clear();
    if (data) {
      for (const [key, cellData] of Object.entries(data)) {
        const { r, c } = this.d.parseKey(key);
        // 直接写入原始单元格对象（含 v 与 f）。
        // 不能走 setCell：它按 v 是否为 "=" 开头的字符串来判定公式，
        // 而持久化的公式单元格 v 是已算出的数值，会导致 f（公式）被误删。
        dataMatrix.set(r, c, cellData);
        if (cellData && cellData.v !== undefined && typeof this.d.syncSharedValue === 'function') {
          this.d.syncSharedValue(r, c, cellData.v);
        }
      }
    }

    // 重建公式依赖图：保存的单元格已含计算结果值 v，但依赖关系不会被持久化。
    // 若不重建，前置单元格变更将无法触发依赖单元格的级联重算（表格僵死）。
    // 与 fromJSON 路径保持一致，仅重建依赖图、不强制全量重算，以维持「秒开」体验。
    if (typeof this.d.rebuildDependencyMap === 'function') {
      this.d.rebuildDependencyMap();
    }

    this.d.markOffsetsDirty();
    this.d.notify();
    return true;
  }

  _schedulePersistence() {
    if (this._destroyed) return;
    const storage = this.d.getStorage();
    if (!storage) return;
    let timer = this.d.getPersistTimer();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      this.d.setPersistTimer(null);
      this.flushPersistence().catch(error => {
        console.error('[Persistence] Debounced save failed:', error);
      });
    }, 1000);
    this.d.setPersistTimer(timer);
  }

  markConfigDirty() {
    if (this._destroyed || !this.d.getStorage()) return;
    this._configRevision++;
    this._schedulePersistence();
  }

  flushPersistence() {
    if (this._flushPromise) return this._flushPromise;
    this._flushPromise = this._flushPendingChanges()
      .finally(() => { this._flushPromise = null; });
    return this._flushPromise;
  }

  async _flushPendingChanges() {
    const storage = this.d.getStorage();
    const dirtyCells = this.d.getDirtyCells();
    if (!storage) return;

    const diffs = new Map(dirtyCells || []);
    if (dirtyCells) dirtyCells.clear();
    const configRevision = this._configRevision;
    const configChanged = configRevision > this._persistedConfigRevision;
    if (diffs.size === 0 && !configChanged) return;

    try {
      if (diffs.size > 0) {
        await storage.saveDiffs(this.d.getSheetId(), diffs);
      }
      if (configChanged) {
        await storage.saveMetadata(`config-${this.d.getSheetId()}`, this.d.snapshotConfig());
        this._persistedConfigRevision = configRevision;
      }
    } catch (error) {
      if (dirtyCells) {
        diffs.forEach((value, key) => {
          if (!dirtyCells.has(key)) dirtyCells.set(key, value);
        });
      }
      throw error;
    }
  }

  async savePendingChanges(sheetId = this.d.getSheetId()) {
    const storage = this.d.getStorage();
    if (!storage) {
      this.enablePersistenceStorage({ sheetId });
    } else if (sheetId) {
      this.d.setSheetId(sheetId);
    }

    let timer = this.d.getPersistTimer();
    if (timer) {
      clearTimeout(timer);
      this.d.setPersistTimer(null);
    }

    const dirtyCells = this.d.getDirtyCells();
    const dirtyCount = dirtyCells ? dirtyCells.size : 0;
    const configChanged = this._configRevision > this._persistedConfigRevision;
    if (dirtyCount > 0 || configChanged) {
      await this.flushPersistence();
      return {
        mode: dirtyCount > 0 ? 'diff' : 'config',
        sheetId: this.d.getSheetId(),
        dirtyCount
      };
    }

    await this.persist(this.d.getSheetId());
    return { mode: 'snapshot', sheetId: this.d.getSheetId(), dirtyCount: 0 };
  }

  async close() {
    this._clearTimer();
    do {
      await this.flushPersistence();
    } while (this._hasPendingChanges());
  }

  hasPendingChanges() {
    return this._hasPendingChanges() || Boolean(this._flushPromise);
  }

  _hasPendingChanges() {
    const dirtyCells = this.d.getDirtyCells();
    return (dirtyCells && dirtyCells.size > 0) ||
      this._configRevision > this._persistedConfigRevision;
  }

  _clearTimer() {
    const timer = this.d.getPersistTimer();
    if (!timer) return;
    clearTimeout(timer);
    this.d.setPersistTimer(null);
  }

  destroy() {
    this._destroyed = true;
    this._clearTimer();
  }
}
