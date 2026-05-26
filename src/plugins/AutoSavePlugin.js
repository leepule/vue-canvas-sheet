/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { Events } from '../core/events/EventEmitter.js';

const SAVE_STATUS_EVENT = Events.SAVE_STATUS || 'save-status';

/**
 * 自动保存插件
 *
 * 默认使用 Workbook 的 IndexedDB diff 持久化路径。localStorage 仅作为显式 backend
 * 或 IndexedDB 不可用时的小表 fallback，避免每次编辑都同步 stringify 全量工作簿。
 */
export class AutoSavePlugin {
  name = 'AutoSave';
  version = '2.1.0';
  description = '自动保存工作簿数据到 IndexedDB diff 存储';
  dependencies = [];

  /**
   * @param {Object} options
   * @param {'indexedDB'|'localStorage'} [options.backend='indexedDB'] - 保存后端
   * @param {number} [options.interval=5000] - 定时保存间隔，0 表示禁用
   * @param {string} [options.key='table_autosave_data'] - localStorage key 或 sheetId fallback
   * @param {string} [options.sheetId] - IndexedDB sheetId
   * @param {boolean} [options.eventDriven=true] - 是否按事件触发保存
   * @param {number} [options.debounce=1000] - 事件触发防抖
   * @param {Array<string>} [options.events] - 监听事件
   * @param {boolean} [options.allowLocalStorageFallback=true] - IndexedDB 失败时是否降级
   */
  constructor(options = {}) {
    this.backend = options.backend || 'indexedDB';
    this.interval = options.interval ?? 5000;
    this.key = options.key || 'table_autosave_data';
    this.sheetId = options.sheetId || this.key;
    this.eventDriven = options.eventDriven !== false;
    this.debounce = options.debounce ?? 1000;
    this.events = options.events || ['cell-change', 'data-load', 'structure-change'];
    this.allowLocalStorageFallback = options.allowLocalStorageFallback !== false;
    this.storageOptions = options.storageOptions || {};

    this._unsubs = [];
    this._debounceTimer = null;
    this._mounted = false;
    this._workbook = null;
    this._registry = null;
    this._status = 'idle';
    this._lastSavedAt = null;
    this._lastError = null;
    this._lastBackend = null;
    this._lastSize = 0;
    this._savePromise = null;
  }

  onInit(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;
    registry.setSharedState('autosave:key', this.key);
    registry.setSharedState('autosave:backend', this.backend);
  }

  onMounted(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;

    if (this.backend === 'indexedDB') {
      this._ensureIndexedDBPersistence(workbook);
    }

    if (this.eventDriven && workbook.on) {
      this.events.forEach(eventType => {
        const unsub = workbook.on(eventType, () => {
          this._scheduleSave(workbook);
        });
        this._unsubs.push(unsub);
      });
    }

    if (this.interval > 0) {
      this.timer = setInterval(() => {
        this._save(workbook);
      }, this.interval);
    }

    this._mounted = true;
  }

  _ensureIndexedDBPersistence(workbook) {
    if (workbook && typeof workbook.enablePersistenceStorage === 'function') {
      workbook.enablePersistenceStorage({
        sheetId: this.sheetId,
        storageOptions: this.storageOptions
      });
    }
  }

  _scheduleSave(workbook) {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._save(workbook);
      this._debounceTimer = null;
    }, this.debounce);
  }

  _emitStatus(workbook, status, extra = {}) {
    this._status = status;
    const payload = {
      status,
      backend: this._lastBackend || this.backend,
      key: this.key,
      sheetId: this.sheetId,
      lastSavedAt: this._lastSavedAt,
      error: this._lastError,
      ...extra
    };

    if (workbook && typeof workbook._emit === 'function') {
      workbook._emit(SAVE_STATUS_EVENT, payload);
    }
    if (this._registry) {
      this._registry.setSharedState('autosave:status', payload);
    }
  }

  async _save(workbook) {
    if (!workbook) return null;
    if (this._savePromise) return this._savePromise;

    this._savePromise = this._saveInternal(workbook)
      .finally(() => {
        this._savePromise = null;
      });
    return this._savePromise;
  }

  async _saveInternal(workbook) {
    this._lastError = null;
    this._emitStatus(workbook, 'saving');

    try {
      let result;
      if (this.backend === 'localStorage') {
        result = this._saveToLocalStorage(workbook);
      } else {
        result = await this._saveToIndexedDB(workbook);
      }

      this._lastSavedAt = Date.now();
      this._lastBackend = result.backend;
      this._lastSize = result.size || 0;
      this._emitStatus(workbook, 'saved', result);
      return result;
    } catch (error) {
      this._lastError = error;

      if (this.backend === 'indexedDB' && this.allowLocalStorageFallback) {
        try {
          const result = this._saveToLocalStorage(workbook);
          this._lastSavedAt = Date.now();
          this._lastBackend = 'localStorage';
          this._lastSize = result.size || 0;
          this._emitStatus(workbook, 'saved', { ...result, fallback: true });
          return result;
        } catch (fallbackError) {
          this._lastError = fallbackError;
          const status = this._isQuotaError(fallbackError) ? 'quotaExceeded' : 'failed';
          this._emitStatus(workbook, status, { error: fallbackError });
          return null;
        }
      }

      const status = this._isQuotaError(error) ? 'quotaExceeded' : 'failed';
      this._emitStatus(workbook, status, { error });
      return null;
    }
  }

  async _saveToIndexedDB(workbook) {
    this._ensureIndexedDBPersistence(workbook);
    if (typeof workbook.savePendingChanges !== 'function') {
      throw new Error('Workbook does not expose savePendingChanges().');
    }

    const result = await workbook.savePendingChanges(this.sheetId);
    return {
      backend: 'indexedDB',
      mode: result?.mode || 'diff',
      sheetId: this.sheetId,
      size: workbook._dirtyCells ? workbook._dirtyCells.size : 0
    };
  }

  _saveToLocalStorage(workbook) {
    const data = {
      ...workbook.toJSON(),
      _timestamp: Date.now()
    };
    const jsonStr = JSON.stringify(data);
    localStorage.setItem(this.key, jsonStr);
    return {
      backend: 'localStorage',
      key: this.key,
      size: jsonStr.length
    };
  }

  _isQuotaError(error) {
    return error && (
      error.name === 'QuotaExceededError' ||
      error.code === 22 ||
      /quota/i.test(error.message || '')
    );
  }

  onUnmount() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._unsubs.length > 0) {
      this._unsubs.forEach(unsub => unsub());
      this._unsubs = [];
    }
    
    if (this._registry) {
      this._registry.deleteSharedState('autosave:key');
      this._registry.deleteSharedState('autosave:backend');
      this._registry.deleteSharedState('autosave:status');
    }
    
    this._mounted = false;
  }

  onError(error, workbook) {
    this._lastError = error;
    this._emitStatus(workbook || this._workbook, 'failed', { error });
  }

  saveNow(workbook) {
    return this._save(workbook || this._workbook);
  }

  getStats() {
    let localSize = 0;
    let localLastModified = null;
    let parseError = null;

    try {
      const data = localStorage.getItem(this.key);
      localSize = data ? data.length : 0;
      if (data) {
        try {
          localLastModified = JSON.parse(data)._timestamp || null;
        } catch (error) {
          parseError = error;
        }
      }
    } catch (error) {
      parseError = error;
    }

    return {
      key: this.key,
      sheetId: this.sheetId,
      backend: this.backend,
      lastBackend: this._lastBackend,
      status: this._status,
      size: this._lastSize || localSize,
      localStorageSize: localSize,
      lastModified: this._lastSavedAt || localLastModified,
      parseError: parseError ? parseError.message : null,
      lastError: this._lastError ? this._lastError.message : null
    };
  }
}

export function createAutoSavePlugin(options = {}) {
  return new AutoSavePlugin(options);
}
