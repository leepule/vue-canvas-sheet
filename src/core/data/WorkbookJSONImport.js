/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

import { parseCellKey } from './CellKey.js';
import { cloneCell, cloneRange } from '../utils/Clipboard.js';

const MAX_ROWS = 1048576;
const MAX_COLS = 16384;
const MAX_INDEXED_MERGE_CELLS = 100000;

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  return value;
}

function importDimension(value, fallback, maximum, label) {
  const dimension = value === undefined ? fallback : value;
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > maximum) {
    throw new RangeError(`${label} 必须是 1 到 ${maximum} 之间的整数`);
  }
  return dimension;
}

function parseImportedCellKey(key, rowCount, colCount) {
  const text = String(key);
  if (!/^\d+-\d+$/.test(text) && !/^\d+$/.test(text)) {
    throw new TypeError(`非法单元格键: ${text}`);
  }
  const { r, c } = parseCellKey(text);
  if (r < 0 || r >= rowCount || c < 0 || c >= colCount) {
    throw new RangeError(`单元格键超出工作簿范围: ${text}`);
  }
  return { r, c };
}

function prepareCells(rawCells, rowCount, colCount) {
  const cells = [];
  for (const [key, rawCell] of Object.entries(rawCells)) {
    const { r, c } = parseImportedCellKey(key, rowCount, colCount);
    const cell = cloneCell(requireRecord(rawCell, `单元格 ${key}`));
    if (cell.f !== undefined && typeof cell.f !== 'string') {
      throw new TypeError(`单元格 ${key} 的公式必须是字符串`);
    }
    if (cell.s !== undefined) requireRecord(cell.s, `单元格 ${key} 的样式`);
    if (typeof cell.v === 'string' && cell.v.startsWith('=')) cell.f = cell.v;
    cells.push({ r, c, cell });
  }
  return cells;
}

function prepareMerge(rawMerge, rowCount, colCount) {
  const mergeRecord = requireRecord(rawMerge, 'merge');
  requireRecord(mergeRecord.s, 'merge.s');
  requireRecord(mergeRecord.e, 'merge.e');
  const merge = cloneRange(mergeRecord);
  const coords = [merge.s.r, merge.s.c, merge.e.r, merge.e.c];
  if (!coords.every(Number.isInteger)) throw new TypeError('merge 坐标必须是整数');
  if (merge.s.r < 0 || merge.s.c < 0 || merge.s.r > merge.e.r || merge.s.c > merge.e.c) {
    throw new RangeError('merge 范围无效');
  }
  if (merge.e.r >= rowCount || merge.e.c >= colCount) {
    throw new RangeError('merge 超出工作簿范围');
  }
  return merge;
}

function mergeCellCount(merge) {
  return (merge.e.r - merge.s.r + 1) * (merge.e.c - merge.s.c + 1);
}

function indexMerge(merge, mergeMap) {
  for (let r = merge.s.r; r <= merge.e.r; r++) {
    for (let c = merge.s.c; c <= merge.e.c; c++) mergeMap[`${r}-${c}`] = merge;
  }
}

function prepareMerges(rawMerges, rowCount, colCount) {
  if (!Array.isArray(rawMerges)) throw new TypeError('merges 必须是数组');
  const merges = [];
  const mergeMap = {};
  let indexedCells = 0;

  for (const rawMerge of rawMerges) {
    const merge = prepareMerge(rawMerge, rowCount, colCount);
    indexedCells += mergeCellCount(merge);
    if (indexedCells > MAX_INDEXED_MERGE_CELLS) {
      throw new RangeError(`merge 索引总面积不能超过 ${MAX_INDEXED_MERGE_CELLS} 个单元格`);
    }
    indexMerge(merge, mergeMap);
    merges.push(merge);
  }
  return { merges, mergeMap };
}

function prepareFreeze(rawFreeze, rowCount, colCount) {
  const freeze = requireRecord(rawFreeze, 'freeze');
  if (!Number.isInteger(freeze.r) || !Number.isInteger(freeze.c)) {
    throw new TypeError('freeze 坐标必须是整数');
  }
  if (freeze.r < 0 || freeze.r > rowCount || freeze.c < 0 || freeze.c > colCount) {
    throw new RangeError('freeze 超出工作簿范围');
  }
  return { r: freeze.r, c: freeze.c };
}

export function prepareWorkbookJSON(json) {
  const source = requireRecord(json, '工作簿 JSON');
  const rowCount = importDimension(source.rowCount, 1000, MAX_ROWS, 'rowCount');
  const colCount = importDimension(source.colCount, 200, MAX_COLS, 'colCount');
  const cells = prepareCells(requireRecord(source.data ?? {}, 'data'), rowCount, colCount);
  const { merges, mergeMap } = prepareMerges(source.merges ?? [], rowCount, colCount);

  return {
    rowCount,
    colCount,
    rowHeights: { ...requireRecord(source.rowHeights ?? {}, 'rowHeights') },
    colWidths: { ...requireRecord(source.colWidths ?? {}, 'colWidths') },
    cells,
    merges,
    mergeMap,
    freeze: prepareFreeze(source.freeze ?? { r: 0, c: 0 }, rowCount, colCount)
  };
}
