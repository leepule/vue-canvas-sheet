/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * Shared cell-key helpers.
 *
 * Public protocols use string keys so row/column coordinates are not limited by
 * JavaScript's 32-bit bitwise operators.
 */

export function cellKey(r, c) {
  return `${Number(r)}-${Number(c)}`;
}

export function cellKeyNumeric(r, c) {
  return (r << 16) | c;
}

export function decodeNumeric(k) {
  return { r: k >>> 16, c: k & 0xFFFF };
}

export function parseCellKey(key) {
  if (key && typeof key === 'object' && Number.isFinite(key.r) && Number.isFinite(key.c)) {
    return { r: key.r, c: key.c };
  }

  const str = String(key);

  if (/^-?\d+$/.test(str)) {
    // Backward compatibility for old compact keys: (r << 16) | c.
    const compact = Number.parseInt(str, 10);
    return {
      r: compact >>> 16,
      c: compact & 0xFFFF
    };
  }

  const dashIdx = str.indexOf('-');
  if (dashIdx > 0) {
    const r = Number.parseInt(str.slice(0, dashIdx), 10);
    const c = Number.parseInt(str.slice(dashIdx + 1), 10);
    return Number.isFinite(r) && Number.isFinite(c) ? { r, c } : { r: -1, c: -1 };
  }

  return { r: -1, c: -1 };
}

export function isValidCellKey(key) {
  const { r, c } = parseCellKey(key);
  return r >= 0 && c >= 0;
}

export function normalizeCellKey(key) {
  const { r, c } = parseCellKey(key);
  return r >= 0 && c >= 0 ? cellKey(r, c) : String(key);
}
