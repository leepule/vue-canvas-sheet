/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

import { buildFullJSONFromCompact } from './utils/exportSnapshot.js';

const DEFAULT_IMPORT_BATCH_SIZE = 1000;

function nextFrame() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function detectFileKind(file) {
  const name = (file?.name || '').toLowerCase();
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.tsv')) return 'tsv';
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return 'excel';
  return 'excel';
}

let _xlsxPromise = null;
function loadXLSX() {
  if (!_xlsxPromise) {
    _xlsxPromise = import('xlsx-js-style').then(m => m.default || m);
  }
  return _xlsxPromise;
}

function readFile(file, as) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (evt) => resolve(evt.target.result);
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.onabort = () => reject(new Error('File read aborted'));
    if (as === 'arrayBuffer') reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}

export function buildImportUpdates(matrix) {
  const updates = [];
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const val = row[c];
      if (val !== null && val !== undefined && val !== '') {
        updates.push({ r, c, val: { v: val } });
      }
    }
  }
  return updates;
}

function matrixDimensions(matrix) {
  const rowCount = Math.max(20, matrix.length + 5);
  let widest = 0;
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r];
    if (row && row.length > widest) widest = row.length;
  }
  return { rowCount, colCount: Math.max(10, widest + 5) };
}

export async function applyMatrixInBatches(workbook, matrix, options = {}) {
  const batchSize = options.batchSize || DEFAULT_IMPORT_BATCH_SIZE;
  const { rowCount, colCount } = matrixDimensions(matrix);
  const updates = buildImportUpdates(matrix);

  workbook.rowCount = rowCount;
  workbook.colCount = colCount;
  if (typeof workbook.clearCells === 'function') {
    workbook.clearCells({
      s: { r: 0, c: 0 },
      e: { r: Math.max(0, rowCount - 1), c: Math.max(0, colCount - 1) }
    });
  } else if (workbook._dataMatrix) {
    workbook._dataMatrix.clear();
  }

  for (let i = 0; i < updates.length; i += batchSize) {
    workbook.bulkSetCells(updates.slice(i, i + batchSize));
    if (options.onProgress) {
      options.onProgress({
        phase: 'import',
        done: Math.min(i + batchSize, updates.length),
        total: updates.length
      });
    }
    await nextFrame();
  }

  return { rows: rowCount, cols: colCount, cells: updates.length };
}

export class ImportPlugin {
  name = 'Import';
  version = '1.1.0';
  description = '数据导入插件，支持 Excel、JSON、CSV 格式导入';
  dependencies = [];

  constructor(options = {}) {
    this.batchSize = options.batchSize || DEFAULT_IMPORT_BATCH_SIZE;
    this.onProgress = options.onProgress || null;
    this.onComplete = options.onComplete || null;
    this.onError = options.onError || null;
    this._workbook = null;
    this._registry = null;
  }

  onInit(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;

    registry.setSharedState('import:file', (file, options) => this.importFile(file, options));
    registry.setSharedState('import:json', (jsonData) => this.importJSON(jsonData));
  }

  onMounted(workbook, registry) {
    this._workbook = workbook;
    this._registry = registry;
  }

  onUnmount() {
    if (this._registry) {
      this._registry.deleteSharedState('import:file');
      this._registry.deleteSharedState('import:json');
    }
    this._workbook = null;
    this._registry = null;
  }

  async importFile(file, options = {}) {
    if (!this._workbook) throw new Error('Workbook not initialized');
    if (!file) throw new Error('No file provided');

    const importOptions = {
      batchSize: options.batchSize || this.batchSize,
      onProgress: options.onProgress || this.onProgress
    };

    const kind = options.kind || detectFileKind(file);

    try {
      let result;
      if (kind === 'json') {
        const text = await readFile(file, 'text');
        const parsed = JSON.parse(text);
        const json = buildFullJSONFromCompact(parsed);
        this._workbook.fromJSON(json);
        result = { fileName: file.name, fileSize: file.size, type: 'json' };
      } else if (kind === 'csv' || kind === 'tsv') {
        const text = await readFile(file, 'text');
        const matrix = await this._parseDelimited(text, kind === 'tsv' ? '\t' : (options.delimiter || ','));
        const summary = await applyMatrixInBatches(this._workbook, matrix, importOptions);
        result = { fileName: file.name, fileSize: file.size, type: kind, ...summary };
      } else {
        const buffer = await readFile(file, 'arrayBuffer');
        const XLSX = await loadXLSX();
        const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(ws, { header: 1 });
        const summary = await applyMatrixInBatches(this._workbook, matrix, importOptions);
        result = { fileName: file.name, fileSize: file.size, type: 'excel', ...summary };
      }

      if (this.onComplete) this.onComplete(result);
      return result;
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      if (this.onError) this.onError(wrapped);
      throw wrapped;
    }
  }

  async _parseDelimited(text, delimiter) {
    try {
      const XLSX = await loadXLSX();
      const wb = XLSX.read(text, { type: 'string', FS: delimiter });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json(ws, { header: 1 });
    } catch {
      return parseDelimitedFallback(text, delimiter);
    }
  }

  importJSON(jsonData) {
    if (!this._workbook) throw new Error('Workbook not initialized');
    if (!jsonData) throw new Error('No JSON data provided');

    try {
      const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      const data = buildFullJSONFromCompact(parsed);
      this._workbook.fromJSON(data);

      const result = {
        type: 'json',
        cellCount: Object.keys(data.data || {}).length
      };
      if (this.onComplete) this.onComplete(result);
      return result;
    } catch (err) {
      const error = new Error(`Invalid JSON data: ${err.message}`);
      if (this.onError) this.onError(error);
      throw error;
    }
  }

  createFileInput(options = {}) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = options.accept || '.xlsx,.xls,.json,.csv,.tsv';

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await this.importFile(file, options);
      } catch (err) {
        if (this.onError) this.onError(err);
      } finally {
        e.target.value = '';
      }
    };

    return input;
  }

  triggerImport(options = {}) {
    const input = this.createFileInput(options);
    input.click();
  }
}

export function createImportPlugin(options = {}) {
  return new ImportPlugin(options);
}

function parseDelimitedFallback(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
