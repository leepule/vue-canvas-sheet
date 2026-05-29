/**
 * 持久化管理器
 * 管理 IndexedDB 存储的读写与增量同步
 */
import { cellKey } from './data/CellKey.js';
import { IndexedDBStorage } from './utils/IndexedDBStorage.js';

export class PersistenceManager {
  constructor(deps) {
    this.d = deps;
  }

  async persist(sheetId = 'default') {
    const storage = this.d.getStorage();
    if (!storage) return;

    const config = {
      rowCount: this.d.getRowCount(),
      colCount: this.d.getColCount(),
      colWidths: this.d.getColWidths(),
      rowHeights: this.d.getRowHeights(),
      merges: this.d.getMerges(),
      mergeMap: this.d.getMergeMap(),
      defaultColWidth: this.d.getDefaultColWidth(),
      defaultRowHeight: this.d.getDefaultRowHeight()
    };

    const data = {};
    this.d.getDataMatrix().forEach((r, c, cell) => {
      data[cellKey(r, c)] = cell;
    });
    await storage.importSheet(sheetId, { data, config });
    console.log(`Workbook [${sheetId}] persisted to IndexedDB.`);
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
    return this.d.getStorage();
  }

  async loadFromStorage(sheetId = 'default') {
    const storage = this.d.getStorage();
    if (!storage) return false;

    const sheetData = await storage.exportSheet(sheetId);
    if (!sheetData || !sheetData.config) return false;

    const { config, data } = sheetData;

    this.d.setRowCount(config.rowCount);
    this.d.setColCount(config.colCount);
    this.d.setColWidths(config.colWidths || {});
    this.d.setRowHeights(config.rowHeights || {});
    this.d.setMerges(config.merges || []);
    this.d.setMergeMap(config.mergeMap || {});
    this.d.setDefaultColWidth(config.defaultColWidth || 80);
    this.d.setDefaultRowHeight(config.defaultRowHeight || 25);

    this.d.getDataMatrix().clear();
    if (data) {
      for (const [key, cellData] of Object.entries(data)) {
        const { r, c } = this.d.parseKey(key);
        this.d.setCell(r, c, cellData);
      }
    }

    this.d.markOffsetsDirty();
    this.d.notify();
    console.log(`Workbook [${sheetId}] loaded from IndexedDB.`);
    return true;
  }

  _schedulePersistence() {
    const storage = this.d.getStorage();
    if (!storage) return;
    let timer = this.d.getPersistTimer();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => this.flushPersistence(), 1000);
    this.d.setPersistTimer(timer);
  }

  async flushPersistence() {
    const storage = this.d.getStorage();
    const dirtyCells = this.d.getDirtyCells();
    if (!storage || dirtyCells.size === 0) return;

    const diffs = new Map(dirtyCells);
    dirtyCells.clear();

    try {
      await storage.saveDiffs(this.d.getSheetId(), diffs);
    } catch (e) {
      console.error('[Persistence] Sync failed:', e);
      diffs.forEach((v, k) => {
        if (!dirtyCells.has(k)) dirtyCells.set(k, v);
      });
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
    if (dirtyCells && dirtyCells.size > 0) {
      const dirtyCount = dirtyCells.size;
      await this.flushPersistence();
      return { mode: 'diff', sheetId: this.d.getSheetId(), dirtyCount };
    }

    await this.persist(this.d.getSheetId());
    return { mode: 'snapshot', sheetId: this.d.getSheetId(), dirtyCount: 0 };
  }

  destroy() {
    let timer = this.d.getPersistTimer();
    if (timer) {
      clearTimeout(timer);
      this.d.setPersistTimer(null);
    }
  }
}
