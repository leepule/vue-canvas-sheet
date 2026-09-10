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
const CSV_FORMULA_PREFIX = /^[\s\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F]*[=+\-@]/u;

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

function sanitizeCsvFormula(cellValue, csvOptions) {
  const stringValue = typeof cellValue === 'string' ? cellValue : String(cellValue);
  if (csvOptions.allowFormulas === true || typeof cellValue !== 'string') return stringValue;
  return CSV_FORMULA_PREFIX.test(stringValue) ? `'${stringValue}` : stringValue;
}

function csvEscape(cellValue, delimiter, csvOptions) {
  if (cellValue === null || cellValue === undefined) return '';
  const safeText = sanitizeCsvFormula(cellValue, csvOptions);
  if (safeText.includes(delimiter) || safeText.includes('"') || safeText.includes('\n') || safeText.includes('\r')) {
    return `"${safeText.replace(/"/g, '""')}"`;
  }
  return safeText;
}

function createExportWorker() {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/export.worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('[ExportPlugin] Failed to create export worker:', err?.message || err);
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

      // 预计算空行字符串（避免每行重复分配）
      const emptyRow = colCount > 1 ? delimiter.repeat(colCount - 1) : '';

      // 按行分组稀疏条目，避免创建 rowCount × colCount 的密集数组
      const rowMap = new Map();
      for (let i = 0; i < entries.length; i++) {
        const { r, c, cell } = entries[i];
        if (!cell || r < bounds.minRow || c < bounds.minCol || r > bounds.maxRow || c > bounds.maxCol) continue;
        const cellValue = cell.v;
        if (cellValue === null || cellValue === undefined || cellValue === '') continue;

        const rowIdx = r - bounds.minRow;
        const colIdx = c - bounds.minCol;
        let cells = rowMap.get(rowIdx);
        if (!cells) {
          cells = new Map();
          rowMap.set(rowIdx, cells);
        }
        cells.set(colIdx, csvEscape(cellValue, delimiter, options));
      }

      // 分块拼接到 Blob parts 数组：每 CHUNK_ROWS 行 join 成一段 push 进 parts，
      // 避免把整个文件 join 成单个可能数百 MB 的巨串（再被 Blob 复制一份，峰值翻倍），
      // 同时省掉 new Array(rowCount) 的上限分配。Blob 在内部拼接各段，不经过中间大字符串。
      const CHUNK_ROWS = 2000;
      const parts = [];
      if (includeBom) parts.push('﻿');

      let chunk = [];
      let firstChunk = true;
      const flushChunk = () => {
        if (chunk.length === 0) return;
        const joined = chunk.join(lineEnding);
        // 块间用 lineEnding 衔接（首块直接附在 BOM 之后，无前导换行），等价于整体 lines.join
        parts.push(firstChunk ? joined : lineEnding + joined);
        firstChunk = false;
        chunk.length = 0;
      };

      // 逐行构建 CSV：空行直接复用预计算字符串，有数据的行按稀疏方式拼接
      for (let ri = 0; ri < rowCount; ri++) {
        const cells = rowMap.get(ri);
        if (!cells || cells.size === 0) {
          chunk.push(emptyRow);
        } else {
          // 按列号排序后逐段拼接，避免分配 colCount 大小的数组
          const sortedCols = Array.from(cells.keys()).sort((a, b) => a - b);
          let line = '';
          let prev = -1;
          for (const ci of sortedCols) {
            // 填充前面的空列
            if (ci > prev + 1) line += delimiter.repeat(ci - prev - 1);
            if (prev >= 0) line += delimiter;
            line += cells.get(ci);
            prev = ci;
          }
          // 填充尾部空列
          if (prev < colCount - 1) line += delimiter.repeat(colCount - 1 - prev);
          chunk.push(line);
        }
        if (chunk.length >= CHUNK_ROWS) flushChunk();
      }
      flushChunk();

      const blob = new Blob(parts, { type: 'text/csv;charset=utf-8;' });
      downloadBlob(blob, fileName);

      const result = {
        type: 'csv',
        fileName,
        bytes: blob.size, // 实际 UTF-8 字节数（较旧的 string.length 即 UTF-16 码元数更准确）
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
