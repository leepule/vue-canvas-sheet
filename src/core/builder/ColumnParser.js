/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */

const HEADER_CELL_STYLE = { fontWeight: 'bold', align: 'center', bg: '#f8f8f9' };

function createHeaderCellValue(value) {
  return {
    v: value,
    s: { ...HEADER_CELL_STYLE }
  };
}

export function calcColumnDepth(columns) {
  if (!Array.isArray(columns) || columns.length === 0) return 0;

  let max = 1;
  for (const column of columns) {
    if (Array.isArray(column.children) && column.children.length > 0) {
      max = Math.max(max, 1 + calcColumnDepth(column.children));
    }
  }
  return max;
}

export function parseColumns(columns) {
  const headerDepth = calcColumnDepth(columns);
  const result = {
    headerDepth,
    totalCols: 0,
    colWidths: {},
    fieldMap: {},
    headerCells: [],
    merges: []
  };

  if (headerDepth === 0) return result;

  result.totalCols = traverseColumns(columns, {
    level: 0,
    startCol: 0,
    headerDepth,
    result
  });
  return result;
}

function traverseColumns(columns, context) {
  const { level, headerDepth, result } = context;
  let currentCol = context.startCol;

  for (const column of columns) {
    const children = Array.isArray(column.children) ? column.children : [];
    const isLeaf = children.length === 0;

    if (isLeaf) {
      if (column.field) result.fieldMap[column.field] = currentCol;
      if (column.width) result.colWidths[currentCol] = column.width;

      const rowSpan = headerDepth - level;
      result.headerCells.push({
        r: level,
        c: currentCol,
        val: createHeaderCellValue(column.title || column.field)
      });

      if (rowSpan > 1) {
        result.merges.push({
          s: { r: level, c: currentCol },
          e: { r: level + rowSpan - 1, c: currentCol }
        });
      }
      currentCol++;
      continue;
    }

    const childrenStartCol = currentCol;
    const nextCol = traverseColumns(children, {
      level: level + 1,
      startCol: currentCol,
      headerDepth,
      result
    });
    const colSpan = nextCol - childrenStartCol;

    result.headerCells.push({
      r: level,
      c: childrenStartCol,
      val: createHeaderCellValue(column.title)
    });

    if (colSpan > 1) {
      result.merges.push({
        s: { r: level, c: childrenStartCol },
        e: { r: level, c: childrenStartCol + colSpan - 1 }
      });
    }
    currentCol = nextCol;
  }

  return currentCol;
}
