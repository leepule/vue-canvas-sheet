export class ThemeHelper {
  static applyTheme(workbook, range, theme) {
    if (!workbook || !range || !theme) return;
    const { s, e } = range;
    const startRow = s.r;
    const endRow = e.r;
    const startCol = s.c;
    const endCol = e.c;
    workbook.history.startBatch();
    let headerEndRow = startRow;
    for (let c = startCol; c <= endCol; c++) {
      const merge = workbook.mergeManager.getMerge(startRow, c);
      if (merge) {
        headerEndRow = Math.max(headerEndRow, merge.e.r);
      }
    }
    if (endCol >= startCol) {
        workbook.styleManager.setStyle({
            s: { r: startRow, c: startCol },
            e: { r: headerEndRow, c: endCol }
        }, theme.header);
    }
    for (let r = headerEndRow + 1; r <= endRow; r++) {
      const isEven = (r - (headerEndRow + 1)) % 2 === 0;
      const rowStyle = isEven ? theme.bodyEven : theme.bodyOdd;
      workbook.styleManager.setStyle({
          s: { r: r, c: startCol },
          e: { r: r, c: endCol }
      }, rowStyle);
    }
    workbook.history.endBatch();
  }
}
