/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 *
 * XLSX-specific helpers shared by ExportPlugin (main-thread fallback) and
 * the export worker. XLSX is passed in by the caller so this module stays
 * import-free and can be loaded in any context.
 */

const BORDER_SIDES = ['top', 'bottom', 'left', 'right'];
const BORDER_STYLE_MAP = { 'solid': 'thin', 'dashed': 'dashed', 'dotted': 'dotted' };

function hex2rgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  return hex.charAt(0) === '#' ? hex.slice(1) : hex;
}

export function applyCellStyle(ws, addr, internal) {
  if (!ws[addr] || !internal) return;
  if (!ws[addr].s) ws[addr].s = {};
  const s = ws[addr].s;

  if (internal.fmt) {
    const dec = internal.decimals !== undefined ? internal.decimals : 2;
    if (internal.fmt === 'percent') {
      ws[addr].z = '0.' + '0'.repeat(dec) + '%';
    } else if (internal.fmt === 'comma') {
      ws[addr].z = '#,##0.' + '0'.repeat(dec);
    }
  }

  const bg = hex2rgb(internal.bg || internal.bgcolor);
  if (bg) {
    s.fill = { fgColor: { rgb: bg } };
  }

  const color = hex2rgb(internal.color);
  const isBold = internal.bold || internal.fontWeight === 'bold';
  if (color || isBold || internal.italic) {
    s.font = s.font || {};
    if (color) s.font.color = { rgb: color };
    if (isBold) s.font.bold = true;
    if (internal.italic) s.font.italic = true;
  }

  if (internal.align) {
    s.alignment = { ...s.alignment, horizontal: internal.align };
  }
  if (internal.valign) {
    const v = internal.valign === 'middle' ? 'center' : internal.valign;
    s.alignment = { ...s.alignment, vertical: v };
  }

  if (internal.border) {
    s.border = {};
    for (let i = 0; i < BORDER_SIDES.length; i++) {
      const side = BORDER_SIDES[i];
      const b = internal.border[side];
      if (!b) continue;
      const borderColor = hex2rgb(b.color || '#000000');
      s.border[side] = {
        style: BORDER_STYLE_MAP[b.style] || 'thin',
        color: borderColor ? { rgb: borderColor } : undefined
      };
    }
  }
}

export function buildWorksheetFromSparseSnapshot(XLSX, snapshot, { includeStyles = true } = {}) {
  const ws = {};
  const { bounds, entries, rowCount, colCount } = snapshot;

  if (rowCount > 0 && colCount > 0) {
    ws['!ref'] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: rowCount - 1, c: colCount - 1 }
    });
  }

  for (let i = 0; i < entries.length; i++) {
    const { r, c, cell } = entries[i];
    if (!cell) continue;
    if (r < bounds.minRow || c < bounds.minCol || r > bounds.maxRow || c > bounds.maxCol) continue;
    const addr = XLSX.utils.encode_cell({ r: r - bounds.minRow, c: c - bounds.minCol });
    ws[addr] = { v: cell.v ?? '' };
    if (cell.f) {
      ws[addr].f = String(cell.f).startsWith('=') ? cell.f.slice(1) : cell.f;
      if (cell.v !== undefined && cell.v !== null) {
        ws[addr].t = typeof cell.v === 'number' ? 'n' : (typeof cell.v === 'boolean' ? 'b' : 's');
      } else {
        ws[addr].t = 'n';
      }
    }
    if (includeStyles && cell.s) applyCellStyle(ws, addr, cell.s);
  }

  if (snapshot.merges && snapshot.merges.length > 0) {
    ws['!merges'] = snapshot.merges;
  }
  if (snapshot.colWidths && snapshot.colWidths.length > 0) {
    ws['!cols'] = snapshot.colWidths.map(w => ({ wch: w ? w / 7.5 : undefined }));
  }

  return ws;
}
