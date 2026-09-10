function parseClipboardValue(rawValue) {
  const numericValue = parseFloat(rawValue);
  if (!Number.isNaN(numericValue) && Number.isFinite(Number(rawValue)) && String(rawValue).trim() !== '') {
    return numericValue;
  }
  return rawValue;
}

function collectClipboardCells({ workbook, clipboardRows, startRow, startColumn }) {
  const clipboardCells = [];
  clipboardRows.forEach((rowText, rowOffset) => {
    if (rowOffset === clipboardRows.length - 1 && rowText === '') return;
    rowText.split('\t').forEach((rawValue, columnOffset) => {
      const row = startRow + rowOffset;
      const column = startColumn + columnOffset;
      if (row < workbook.rowCount && column < workbook.colCount) {
        clipboardCells.push({ row, column, cellValue: parseClipboardValue(rawValue) });
      }
    });
  });
  return clipboardCells;
}

function clipboardBounds(workbook, clipboardRows, startRow, startColumn) {
  let columnCount = 0;
  clipboardRows.forEach((rowText, rowIndex) => {
    if (rowIndex === clipboardRows.length - 1 && rowText === '') return;
    columnCount = Math.max(columnCount, rowText.split('\t').length);
  });
  return {
    endRow: Math.min(workbook.rowCount - 1, startRow + clipboardRows.length - 1),
    endColumn: Math.min(workbook.colCount - 1, startColumn + columnCount - 1)
  };
}

function applyCollaborativePaste(workbook, clipboardCells) {
  workbook.history.startBatch();
  clipboardCells.forEach(({ row, column, cellValue }) => {
    workbook.setCell(row, column, { v: cellValue });
  });
  workbook.history.endBatch();
}

function applyBatchPaste(workbook, clipboardCells) {
  const updates = clipboardCells.map(({ row, column, cellValue }) => ({
    r: row,
    c: column,
    val: { v: cellValue }
  }));
  if (updates.length > 0) workbook.bulkSetCells(updates);
}

function selectedText(workbook) {
  const selection = workbook.selection;
  const rows = [];
  for (let row = selection.s.r; row <= selection.e.r; row++) {
    const columns = [];
    for (let column = selection.s.c; column <= selection.e.c; column++) {
      const cell = workbook.getCell(row, column);
      columns.push(cell?.v ?? '');
    }
    rows.push(columns.join('\t'));
  }
  return rows.join('\n');
}

export default function useCanvasClipboard({ getWorkbook, isReadOnly, isRangeLocked }) {
  async function handleCopy() {
    const workbook = getWorkbook();
    try {
      await navigator.clipboard.writeText(selectedText(workbook));
      workbook.setCopyRange(workbook.selection);
    } catch (error) {
      console.error('Failed to copy', error);
    }
  }

  async function handlePaste() {
    if (isReadOnly()) return;
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText) return;

      const workbook = getWorkbook();
      const clipboardRows = clipboardText.split(/\r?\n/);
      const startRow = workbook.activeCell.r;
      const startColumn = workbook.activeCell.c;
      const bounds = clipboardBounds(workbook, clipboardRows, startRow, startColumn);
      if (isRangeLocked(startRow, startColumn, bounds.endRow, bounds.endColumn)) {
        alert('操作被拦截：粘贴的目标区域包含他人正在编辑的锁定单元格，无法粘贴。');
        return;
      }

      const clipboardCells = collectClipboardCells({ workbook, clipboardRows, startRow, startColumn });
      const isCollaborative = !!workbook.plugins.getSharedState('collaboration:isCellLocked');
      if (isCollaborative) applyCollaborativePaste(workbook, clipboardCells);
      else applyBatchPaste(workbook, clipboardCells);
      workbook.clearCopyRange();
    } catch (error) {
      console.error('Failed to paste:', error);
    }
  }

  return { handleCopy, handlePaste };
}
