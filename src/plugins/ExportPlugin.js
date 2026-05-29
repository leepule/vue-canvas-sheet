/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

import {
  buildSparseExportSnapshot,
  buildCompactJSON
} from './utils/exportSnapshot.js';
import { buildWorksheetFromSparseSnapshot } from './utils/xlsxAdapter.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

let _xlsxPromise = null;
function loadXLSX() {
  if (!_xlsxPromise) {
    _xlsxPromise = import('xlsx-js-style')
      .then(m => m.default || m)
      .catch(err => { _xlsxPromise = null; throw err; });
  }
  return _xlsxPromise;
}

function csvEscape(value, delimiter) {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  if (str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function createExportWorker() {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/export.worker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function runExportWorker(snapshot, fileName, onProgress, activeWorkers) {
  const worker = createExportWorker();
  if (!worker) return null;

  if (activeWorkers) activeWorkers.add(worker);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (activeWorkers) activeWorkers.delete(worker);
    };

    worker.onmessage = (e) => {
      const message = e.data || {};
      if (message.type === 'progress') {
        if (onProgress) onProgress(message);
        return;
      }

      if (message.success) {
        downloadBlob(
          new Blob([message.buffer], { type: XLSX_MIME }),
          message.fileName || fileName
        );
        cleanup();
        worker.terminate();
        resolve({
          duration: message.duration,
          bytes: message.byteLength || message.buffer?.byteLength || 0,
          worker: true,
          snapshot
        });
      } else {
        cleanup();
        worker.terminate();
        reject(new Error(message.error || 'Export worker failed'));
      }
    };

    worker.onerror = (error) => {
      cleanup();
      worker.terminate();
      reject(error instanceof Error ? error : new Error(error?.message || 'Export worker failed'));
    };

    worker.postMessage({ snapshot, fileName });
  });
}

async function exportExcelOnMainThread(snapshot, fileName, onProgress) {
  if (onProgress) onProgress({ type: 'progress', phase: 'xlsx-build', progress: 0.25 });
  const XLSX = await loadXLSX();
  const ws = buildWorksheetFromSparseSnapshot(XLSX, snapshot);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  if (onProgress) onProgress({ type: 'progress', phase: 'xlsx-write', progress: 0.75 });
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(new Blob([wbout], { type: XLSX_MIME }), fileName);
  return {
    bytes: wbout.byteLength || wbout.length || 0,
    worker: false,
    snapshot
  };
}

export class ExportPlugin {
  name = 'Export';
  version = '1.1.0';
  description = '数据导出插件，支持 Excel、JSON、CSV 格式导出';
  dependencies = [];

  constructor(options = {}) {
    this.defaultFileName = options.defaultFileName || 'workbook';
    this.useWorker = options.useWorker !== false;
    this.onProgress = options.onProgress || null;
    this.onComplete = options.onComplete || null;
    this.onError = options.onError || null;
    this._workbook = null;
    this._registry = null;
    this._activeWorkers = new Set();
  }

  onInit(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;

    registry.setSharedState('export:excel', (options) => this.exportExcel(options));
    registry.setSharedState('export:json', (options) => this.exportJSON(options));
    registry.setSharedState('export:csv', (options) => this.exportCSV(options));
  }

  onMounted(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;
  }

  onUnmount() {
    if (this._registry) {
      this._registry.deleteSharedState('export:excel');
      this._registry.deleteSharedState('export:json');
      this._registry.deleteSharedState('export:csv');
    }
    // 终止所有正在运行的导出 Worker
    for (const worker of this._activeWorkers) {
      worker.terminate();
    }
    this._activeWorkers.clear();
    this._workbook = null;
    this._registry = null;
  }

  async exportExcel(options = {}) {
    if (!this._workbook) throw new Error('Workbook not initialized');

    const fileName = options.fileName || `${this.defaultFileName}.xlsx`;
    const progressCb = options.onProgress || this.onProgress;
    const wantWorker = options.useWorker !== undefined ? options.useWorker : this.useWorker;
    const snapshot = buildSparseExportSnapshot(this._workbook);

    try {
      let result;
      if (wantWorker) {
        const workerResult = runExportWorker(snapshot, fileName, progressCb, this._activeWorkers);
        if (workerResult) {
          try {
            result = await workerResult;
          } catch (workerErr) {
            // Worker setup succeeded but execution failed (transfer error, xlsx
            // throw, etc). Fall back to the main thread so the user still gets
            // their file; surface the cause on the console for debugging.
            // workerErr may be an ErrorEvent (from Worker.onerror) rather than
            // an Error — extract the real error when available.
            const cause = (workerErr instanceof ErrorEvent && workerErr.error)
              ? workerErr.error
              : workerErr;
            console.warn('[ExportPlugin] worker export failed, falling back to main thread:', cause);
          }
        }
      }

      if (!result) {
        result = await exportExcelOnMainThread(snapshot, fileName, progressCb);
      }

      if (this.onComplete) this.onComplete({ type: 'excel', fileName, ...result });
      return result;
    } catch (err) {
      if (this.onError) this.onError(err);
      throw err;
    }
  }

  exportJSON(options = {}) {
    if (!this._workbook) throw new Error('Workbook not initialized');

    try {
      const fileName = options.fileName || `${this.defaultFileName}.json`;
      const compact = options.compact !== false;
      const payload = compact ? buildCompactJSON(this._workbook) : this._workbook.toJSON();
      const spacing = options.pretty === false ? 0 : 2;
      const data = JSON.stringify(payload, null, spacing);
      downloadBlob(new Blob([data], { type: 'application/json' }), fileName);

      const result = {
        type: 'json',
        fileName,
        bytes: data.length,
        compact,
        cellCount: compact ? payload.cells.length : Object.keys(payload.data || {}).length
      };
      if (this.onComplete) this.onComplete(result);
      return result;
    } catch (err) {
      if (this.onError) this.onError(err);
      throw err;
    }
  }

  exportCSV(options = {}) {
    if (!this._workbook) throw new Error('Workbook not initialized');

    try {
      const fileName = options.fileName || `${this.defaultFileName}.csv`;
      const delimiter = options.delimiter || ',';
      const lineEnding = options.lineEnding || '\n';
      const includeBom = options.bom === true;

      const snapshot = buildSparseExportSnapshot(this._workbook);
      const { entries, bounds, rowCount, colCount } = snapshot;

      const rows = new Array(rowCount);
      for (let i = 0; i < rowCount; i++) rows[i] = new Array(colCount).fill('');

      for (let i = 0; i < entries.length; i++) {
        const { r, c, cell } = entries[i];
        if (!cell || r < bounds.minRow || c < bounds.minCol || r > bounds.maxRow || c > bounds.maxCol) continue;
        const value = cell.v;
        if (value === null || value === undefined || value === '') continue;
        rows[r - bounds.minRow][c - bounds.minCol] = csvEscape(value, delimiter);
      }

      const csvContent = (includeBom ? '﻿' : '') +
        rows.map(row => row.join(delimiter)).join(lineEnding);

      downloadBlob(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }), fileName);

      const result = {
        type: 'csv',
        fileName,
        bytes: csvContent.length,
        rows: rowCount,
        cols: colCount
      };
      if (this.onComplete) this.onComplete(result);
      return result;
    } catch (err) {
      if (this.onError) this.onError(err);
      throw err;
    }
  }
}

export function createExportPlugin(options = {}) {
  return new ExportPlugin(options);
}
