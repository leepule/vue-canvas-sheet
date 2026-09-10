/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 *
 * Pure data-shaping helpers shared by ExportPlugin / ImportPlugin and the
 * export worker. Nothing in here depends on xlsx-js-style or the DOM.
 */

export function getSparseBounds(workbook) {
  if (workbook && typeof workbook.getDataMatrix === 'function') {
    const dm = workbook.getDataMatrix();
    if (dm && typeof dm.getBounds === 'function') {
      return dm.getBounds();
    }
  }
  const data = workbook?.toJSON?.().data || {};
  let minRow = Infinity, maxRow = -1, minCol = Infinity, maxCol = -1;
  for (const key of Object.keys(data)) {
    const [r, c] = key.split('-').map(Number);
    if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
    if (r < minRow) minRow = r;
    if (r > maxRow) maxRow = r;
    if (c < minCol) minCol = c;
    if (c > maxCol) maxCol = c;
  }
  return maxRow < 0
    ? { minRow: 0, maxRow: -1, minCol: 0, maxCol: -1 }
    : { minRow, maxRow, minCol, maxCol };
}

export function getWorkbookEntries(workbook) {
  if (workbook && typeof workbook.getDataMatrix === 'function') {
    const dm = workbook.getDataMatrix();
    if (dm && typeof dm.entries === 'function') {
      return Array.from(dm.entries());
    }
  }
  const data = workbook?.toJSON?.().data || {};
  const out = [];
  for (const key of Object.keys(data)) {
    const [r, c] = key.split('-').map(Number);
    if (Number.isFinite(r) && Number.isFinite(c)) {
      out.push({ r, c, cell: data[key] });
    }
  }
  return out;
}

export function normalizeMergesForBounds(merges = [], bounds) {
  if (!bounds || bounds.maxRow < bounds.minRow || bounds.maxCol < bounds.minCol) return [];
  const out = [];
  for (let i = 0; i < merges.length; i++) {
    const m = merges[i];
    if (m.e.r < bounds.minRow || m.s.r > bounds.maxRow || m.e.c < bounds.minCol || m.s.c > bounds.maxCol) continue;
    out.push({
      s: { r: m.s.r - bounds.minRow, c: m.s.c - bounds.minCol },
      e: { r: m.e.r - bounds.minRow, c: m.e.c - bounds.minCol }
    });
  }
  return out;
}

export function buildSparseExportSnapshot(workbook) {
  const bounds = getSparseBounds(workbook);
  const entries = getWorkbookEntries(workbook);
  const rowCount = bounds.maxRow >= bounds.minRow ? bounds.maxRow - bounds.minRow + 1 : 0;
  const colCount = bounds.maxCol >= bounds.minCol ? bounds.maxCol - bounds.minCol + 1 : 0;
  const colWidths = [];

  for (let c = 0; c < colCount; c++) {
    const colIndex = bounds.minCol + c;
    colWidths.push(workbook.getColWidth ? workbook.getColWidth(colIndex) : undefined);
  }

  return {
    bounds,
    rowCount,
    colCount,
    entries,
    merges: normalizeMergesForBounds(workbook.merges || [], bounds),
    colWidths,
    sourceRowCount: workbook.rowCount,
    sourceColCount: workbook.colCount
  };
}

export function buildCompactJSON(workbook) {
  const snapshot = buildSparseExportSnapshot(workbook);
  return {
    rowCount: workbook.rowCount,
    colCount: workbook.colCount,
    rowHeights: { ...workbook.rowHeights },
    colWidths: { ...workbook.colWidths },
    merges: [...workbook.merges],
    freeze: { ...workbook.freeze },
    bounds: snapshot.bounds,
    cells: snapshot.entries.map(({ r, c, cell }) => ({ r, c, ...cell }))
  };
}

export function buildFullJSONFromCompact(compact) {
  if (!compact || !Array.isArray(compact.cells)) return compact;
  const data = {};
  for (const { r, c, ...cell } of compact.cells) {
    data[`${r}-${c}`] = cell;
  }
  return {
    rowCount: compact.rowCount,
    colCount: compact.colCount,
    rowHeights: compact.rowHeights || {},
    colWidths: compact.colWidths || {},
    merges: compact.merges || [],
    freeze: compact.freeze || { r: 0, c: 0 },
    data
  };
}
