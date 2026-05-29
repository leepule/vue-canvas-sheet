/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { cellKey, normalizeCellKey, parseCellKey } from '../data/CellKey.js';

/**
 * Transferable 序列化器
 * 
 * 用于 Worker 通信的高效序列化/反序列化
 * 使用 TypedArray 和 Transferable Objects 实现零拷贝传输
 */

/**
 * 数据类型标识
 */
const DataType = {
  NULL: 0,
  UNDEFINED: 1,
  BOOLEAN: 2,
  NUMBER: 3,
  STRING: 4,
  OBJECT: 5,
  ARRAY: 6,
  CELL_DATA: 7,
  FORMULA_BATCH: 8,
  RENDER_DATA: 9
};

/**
 * 序列化配置
 */
const CONFIG = {
  // 初始缓冲区大小（字节）
  INITIAL_BUFFER_SIZE: 64 * 1024, // 64KB
  // 字符串编码器
  textEncoder: new TextEncoder(),
  textDecoder: new TextDecoder()
};

const RENDER_ALIGN = { left: 0, center: 1, right: 2 };
const RENDER_ALIGN_BY_ID = ['left', 'center', 'right'];
const RENDER_VALIGN = { top: 0, middle: 1, bottom: 2 };
const RENDER_VALIGN_BY_ID = ['top', 'middle', 'bottom'];
const RENDER_BORDER_STYLE = { solid: 0, dashed: 1, dotted: 2 };
const RENDER_BORDER_STYLE_BY_ID = ['solid', 'dashed', 'dotted'];
const RENDER_FONT_WEIGHT = { normal: 0, bold: 1 };
const RENDER_FONT_STYLE = { normal: 0, italic: 1 };

function writeNullableRect(writer, rect) {
  writer.writeUint8(rect ? 1 : 0);
  if (!rect) return;
  writer.writeFloat64(rect.x || 0);
  writer.writeFloat64(rect.y || 0);
  writer.writeFloat64(rect.w || 0);
  writer.writeFloat64(rect.h || 0);
}

function readNullableRect(reader) {
  if (reader.readUint8() === 0) return null;
  return {
    x: reader.readFloat64(),
    y: reader.readFloat64(),
    w: reader.readFloat64(),
    h: reader.readFloat64()
  };
}

function writeSelectionRange(writer, selection) {
  const hasSelection = !!(selection && selection.s && selection.e);
  writer.writeUint8(hasSelection ? 1 : 0);
  if (!hasSelection) return;
  writer.writeInt32(selection.s.r ?? -1);
  writer.writeInt32(selection.s.c ?? -1);
  writer.writeInt32(selection.e.r ?? -1);
  writer.writeInt32(selection.e.c ?? -1);
}

function readSelectionRange(reader) {
  if (reader.readUint8() === 0) return null;
  return {
    s: {
      r: reader.readInt32(),
      c: reader.readInt32()
    },
    e: {
      r: reader.readInt32(),
      c: reader.readInt32()
    }
  };
}

function writeRenderTheme(writer, theme = {}) {
  writer.writeString(theme.textColor || '#606266');
  writer.writeString(theme.borderColor || '#dcdfe6');
  writer.writeString(theme.headerBg || '#f4f5f8');
  writer.writeString(theme.headerHoverBg || '#ecf5ff');
  writer.writeString(theme.selectionBorder || '#217346');
  writer.writeString(theme.selectionBg || 'rgba(33, 115, 70, 0.1)');
  writer.writeString(theme.frozenLineColor || '#ccc');
  writer.writeString(theme.fontFamily || 'Arial');
  writer.writeString(theme.fontSize || '13px');
  writer.writeString(theme.headerFontSize || '12px');
}

function readRenderTheme(reader) {
  return {
    textColor: reader.readString(),
    borderColor: reader.readString(),
    headerBg: reader.readString(),
    headerHoverBg: reader.readString(),
    selectionBorder: reader.readString(),
    selectionBg: reader.readString(),
    frozenLineColor: reader.readString(),
    fontFamily: reader.readString(),
    fontSize: reader.readString(),
    headerFontSize: reader.readString()
  };
}

function writeTextStyle(writer, style = {}) {
  // bold：兼容 bold/fontWeight 两种写法
  const isBold = !!(style.bold || style.fw === 'bold' || style.fontWeight === 'bold');
  // italic：兼容 italic/fontStyle 两种写法
  const isItalic = !!(style.italic || style.fs === 'italic' || style.fontStyle === 'italic');
  // 删除线
  const isLineThrough = !!(style.td === 'line-through' || style.textDecoration === 'line-through');
  // 自动换行
  const isWrap = !!style.wrap;

  writer.writeUint8(isBold ? 1 : 0);
  writer.writeUint8(isItalic ? 1 : 0);
  writer.writeUint8(isLineThrough ? 1 : 0);
  writer.writeUint8(isWrap ? 1 : 0);

  // fontSize（0 表示使用默认）
  writer.writeFloat64(style.fontSize ? Number(style.fontSize) : 0);

  // color（空字符串表示用默认）
  writer.writeString(style.color || '');
  // bg
  writer.writeString(style.bg || style.bgcolor || '');
  // align
  writer.writeUint8(RENDER_ALIGN[style.align] ?? RENDER_ALIGN.left);
  // valign
  writer.writeUint8(RENDER_VALIGN[style.valign] ?? RENDER_VALIGN.middle);

  // fmt / decimals
  writer.writeString(style.fmt || '');
  writer.writeFloat64(style.decimals !== undefined ? Number(style.decimals) : -1);
}

function readTextStyle(reader) {
  const bold      = reader.readUint8() === 1;
  const italic    = reader.readUint8() === 1;
  const lineThrough = reader.readUint8() === 1;
  const wrap      = reader.readUint8() === 1;
  const fontSizeRaw = reader.readFloat64();
  const color     = reader.readString();
  const bg        = reader.readString();
  const alignId   = reader.readUint8();
  const valignId  = reader.readUint8();
  const fmt       = reader.readString();
  const decimalsRaw = reader.readFloat64();

  const style = {};
  if (bold)        { style.bold = true; }
  if (italic)      { style.italic = true; }
  if (lineThrough) { style.td = 'line-through'; }
  if (wrap)        { style.wrap = true; }
  if (fontSizeRaw > 0) { style.fontSize = fontSizeRaw; }
  if (color)       { style.color = color; }
  if (bg)          { style.bg = bg; }
  style.align  = RENDER_ALIGN_BY_ID[alignId] || 'left';
  style.valign = RENDER_VALIGN_BY_ID[valignId] || 'middle';
  if (fmt)         { style.fmt = fmt; }
  if (decimalsRaw >= 0) { style.decimals = decimalsRaw; }
  return style;
}

/**
 * 缓冲区写入器
 */
export class BufferWriter {
  constructor(initialSize = CONFIG.INITIAL_BUFFER_SIZE) {
    this.buffer = new ArrayBuffer(initialSize);
    this.view = new DataView(this.buffer);
    this.uint8View = new Uint8Array(this.buffer);
    this.offset = 0;
  }

  /**
   * 确保有足够空间
   */
  ensureCapacity(bytes) {
    const required = this.offset + bytes;
    if (required > this.buffer.byteLength) {
      // 扩展为所需大小的 2 倍或最小值
      const newSize = Math.max(required * 2, CONFIG.INITIAL_BUFFER_SIZE);
      const newBuffer = new ArrayBuffer(newSize);
      new Uint8Array(newBuffer).set(this.uint8View);
      this.buffer = newBuffer;
      this.view = new DataView(this.buffer);
      this.uint8View = new Uint8Array(this.buffer);
    }
  }

  /**
   * 写入 uint8
   */
  writeUint8(value) {
    this.ensureCapacity(1);
    this.view.setUint8(this.offset++, value);
  }

  /**
   * 写入 int32
   */
  writeInt32(value) {
    this.ensureCapacity(4);
    this.view.setInt32(this.offset, value, true); // little-endian
    this.offset += 4;
  }

  /**
   * 写入 uint32
   */
  writeUint32(value) {
    this.ensureCapacity(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  /**
   * 写入 float64
   */
  writeFloat64(value) {
    this.ensureCapacity(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  /**
   * 写入字符串
   */
  writeString(str) {
    const encoded = CONFIG.textEncoder.encode(str);
    this.ensureCapacity(4 + encoded.length);
    this.writeUint32(encoded.length);
    this.uint8View.set(encoded, this.offset);
    this.offset += encoded.length;
  }

  /**
   * 写入原始字节
   */
  writeBytes(bytes) {
    this.ensureCapacity(bytes.length);
    this.uint8View.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  /**
   * 获取结果缓冲区
   */
  getBuffer() {
    return this.buffer.slice(0, this.offset);
  }

  /**
   * 获取可转移的缓冲区
   */
  getTransferable() {
    // 返回精确大小的缓冲区
    return this.buffer.slice(0, this.offset);
  }
}

/**
 * 缓冲区读取器
 */
export class BufferReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.uint8View = new Uint8Array(buffer);
    this.offset = 0;
  }

  /**
   * 读取 uint8
   */
  readUint8() {
    return this.view.getUint8(this.offset++);
  }

  /**
   * 读取 int32
   */
  readInt32() {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /**
   * 读取 uint32
   */
  readUint32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /**
   * 读取 float64
   */
  readFloat64() {
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  /**
   * 读取字符串
   */
  readString() {
    const length = this.readUint32();
    const bytes = this.uint8View.slice(this.offset, this.offset + length);
    this.offset += length;
    return CONFIG.textDecoder.decode(bytes);
  }

  /**
   * 读取原始字节
   */
  readBytes(length) {
    const bytes = this.uint8View.slice(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  /**
   * 剩余字节数
   */
  get remaining() {
    return this.buffer.byteLength - this.offset;
  }
}

/**
 * 写入单元格键。
 */
function writeCellId(writer, cellId) {
  writer.writeString(normalizeCellKey(cellId));
}

/**
 * 读取单元格键。
 */
function readCellId(reader) {
  return reader.readString();
}

/**
 * 序列化单元格数据
 */
function serializeCellData(writer, key, cell) {
  writeCellId(writer, key);

  // 写入值类型
  if (cell.v === null) {
    writer.writeUint8(DataType.NULL);
  } else if (cell.v === undefined) {
    writer.writeUint8(DataType.UNDEFINED);
  } else if (typeof cell.v === 'boolean') {
    writer.writeUint8(DataType.BOOLEAN);
    writer.writeUint8(cell.v ? 1 : 0);
  } else if (typeof cell.v === 'number') {
    writer.writeUint8(DataType.NUMBER);
    writer.writeFloat64(cell.v);
  } else {
    writer.writeUint8(DataType.STRING);
    writer.writeString(String(cell.v));
  }

  // 写入公式（如果有）
  if (cell.f) {
    writer.writeUint8(1); // has formula
    writer.writeString(cell.f);
  } else {
    writer.writeUint8(0); // no formula
  }

  // 写入脏标记
  writer.writeUint8(cell.dirty ? 1 : 0);
}

/**
 * 反序列化单元格数据
 */
export function deserializeCellData(reader) {
  const key = readCellId(reader);
  const valueType = reader.readUint8();

  let v;
  switch (valueType) {
    case DataType.NULL:
      v = null;
      break;
    case DataType.UNDEFINED:
      v = undefined;
      break;
    case DataType.BOOLEAN:
      v = reader.readUint8() === 1;
      break;
    case DataType.NUMBER:
      v = reader.readFloat64();
      break;
    case DataType.STRING:
      v = reader.readString();
      break;
    default:
      v = undefined;
  }

  const hasFormula = reader.readUint8() === 1;
  const f = hasFormula ? reader.readString() : undefined;
  const dirty = reader.readUint8() === 1;

  return {
    key,
    cell: {
      v,
      f,
      dirty
    }
  };
}

/**
 * 序列化公式批量计算请求
 * @param {Array<{cellId: string, formula: string}>} formulas - 公式列表
 * @param {Object} data - 单元格数据
 * @returns {{buffer: ArrayBuffer, transferables: Transferable[]}}
 */
export function serializeFormulaBatch(formulas, data) {
  const writer = new BufferWriter();

  // 写入魔数标识
  writer.writeUint32(0x464F524D); // "FORM"

  // 写入公式数量
  writer.writeUint32(formulas.length);

  // 写入公式列表
  for (const { cellId, formula } of formulas) {
    writeCellId(writer, cellId);
    writer.writeString(formula);
  }

  // 写入数据条目数量
  const dataKeys = Object.keys(data);
  writer.writeUint32(dataKeys.length);

  // 写入数据
  for (const keyStr of dataKeys) {
    const cell = data[keyStr];
    if (!cell) continue;

    const { r, c } = parseCellKey(keyStr);
    if (r < 0 || c < 0) continue;
    serializeCellData(writer, cellKey(r, c), cell);
  }

  const buffer = writer.getTransferable();
  return {
    buffer,
    transferables: [buffer]
  };
}

/**
 * 反序列化公式批量计算请求
 */
export function deserializeFormulaBatch(buffer) {
  const reader = new BufferReader(buffer);

  // 验证魔数
  const magic = reader.readUint32();
  if (magic !== 0x464F524D) {
    throw new Error('Invalid formula batch data');
  }

  // 读取公式数量
  const formulaCount = reader.readUint32();
  const formulas = [];

  // 读取公式列表
  for (let i = 0; i < formulaCount; i++) {
    const cellId = readCellId(reader);
    const formula = reader.readString();
    formulas.push({ cellId, formula });
  }

  // 读取数据条目数量
  const dataCount = reader.readUint32();
  const data = {};

  // 读取数据
  for (let i = 0; i < dataCount; i++) {
    const { key, cell } = deserializeCellData(reader);
    const { r, c } = parseCellKey(key);
    if (r < 0 || c < 0) continue;
    data[cellKey(r, c)] = cell;
  }

  return { formulas, data };
}

/**
 * 序列化公式计算结果
 * @param {Object} results - 计算结果 {cellId: value}
 * @returns {{buffer: ArrayBuffer, transferables: Transferable[]}}
 */
export function serializeFormulaResults(results) {
  const writer = new BufferWriter();

  // 写入魔数标识
  writer.writeUint32(0x52455354); // "REST"

  // 写入结果数量
  const keys = Object.keys(results);
  writer.writeUint32(keys.length);

  // 写入结果
  for (const cellId of keys) {
    writeCellId(writer, cellId);

    // 写入结果值
    const value = results[cellId];
    if (value === null) {
      writer.writeUint8(DataType.NULL);
    } else if (value === undefined) {
      writer.writeUint8(DataType.UNDEFINED);
    } else if (typeof value === 'boolean') {
      writer.writeUint8(DataType.BOOLEAN);
      writer.writeUint8(value ? 1 : 0);
    } else if (typeof value === 'number') {
      writer.writeUint8(DataType.NUMBER);
      writer.writeFloat64(value);
    } else if (typeof value === 'string') {
      writer.writeUint8(DataType.STRING);
      writer.writeString(value);
    } else {
      writer.writeUint8(DataType.STRING);
      writer.writeString(String(value));
    }
  }

  const buffer = writer.getTransferable();
  return {
    buffer,
    transferables: [buffer]
  };
}

/**
 * 反序列化公式计算结果
 */
export function deserializeFormulaResults(buffer) {
  const reader = new BufferReader(buffer);

  // 验证魔数
  const magic = reader.readUint32();
  if (magic !== 0x52455354) {
    throw new Error('Invalid formula results data');
  }

  // 读取结果数量
  const count = reader.readUint32();
  const results = {};

  // 读取结果
  for (let i = 0; i < count; i++) {
    const cellId = readCellId(reader);

    const valueType = reader.readUint8();
    let value;
    switch (valueType) {
      case DataType.NULL:
        value = null;
        break;
      case DataType.UNDEFINED:
        value = undefined;
        break;
      case DataType.BOOLEAN:
        value = reader.readUint8() === 1;
        break;
      case DataType.NUMBER:
        value = reader.readFloat64();
        break;
      case DataType.STRING:
        value = reader.readString();
        break;
      default:
        value = undefined;
    }

    results[cellId] = value;
  }

  return results;
}

/**
 * 检测是否支持 Transferable Objects
 */
export function isTransferableSupported() {
  try {
    const buffer = new ArrayBuffer(1);
    postMessage({ test: true }, [buffer]);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 序列化渲染数据
 */
export function serializeRenderData(data) {
    const writer = new BufferWriter();
    writer.writeUint32(0x524E4452); // "RNDR"

    writer.writeFloat64(data.width || 0);
    writer.writeFloat64(data.height || 0);
    writeRenderTheme(writer, data.theme || {});

    const cells = data.cellDataList || [];
    writer.writeUint32(cells.length);

    // 写入样式映射表 (ID -> Style)
    const styleMap = data.styleMap || {};
    const styleIds = Object.keys(styleMap);
    writer.writeUint32(styleIds.length);
    for (const id of styleIds) {
      writer.writeUint32(parseInt(id, 10));
      writeTextStyle(writer, styleMap[id]);
    }

    for (const cell of cells) {
      writer.writeInt32(cell.r);
      writer.writeInt32(cell.c);
      writer.writeFloat64(cell.x);
      writer.writeFloat64(cell.y);
      writer.writeFloat64(cell.w);
      writer.writeFloat64(cell.h);
      writer.writeString(cell.bg || "");

      if (cell.text) {
        writer.writeUint8(1);
        writer.writeString(cell.text.content || "");
        // 写入样式 ID 而不是全量属性字符串
        writer.writeUint32(cell.text.styleId !== undefined ? cell.text.styleId : 0xFFFFFFFF);
      } else {
        writer.writeUint8(0);
      }

      // 区域 clipRect：主体/冻结区域物理裁剪，丢失会导致主体文字越界画入冻结区
      if (cell.clip) {
        writer.writeUint8(1);
        writer.writeFloat64(cell.clip.x);
        writer.writeFloat64(cell.clip.y);
        writer.writeFloat64(cell.clip.w);
        writer.writeFloat64(cell.clip.h);
      } else {
        writer.writeUint8(0);
      }
    }

    const bgColors = Object.keys(data.bgGroups || {});
    writer.writeUint32(bgColors.length);
    for (const color of bgColors) {
      writer.writeString(color);
      const rects = data.bgGroups[color];
      writer.writeUint32(rects.length);
      for (const val of rects) writer.writeFloat64(val);
    }

    const gridLines = data.gridLines || [];
    writer.writeUint32(gridLines.length);
    for (const val of gridLines) writer.writeFloat64(val);

    const borderBatch = data.borderBatch || {};
    const borderKeys = Object.keys(borderBatch);
    writer.writeUint32(borderKeys.length);
    for (const key of borderKeys) {
      const [color, style = 'solid'] = key.split('|');
      writer.writeString(color);
      writer.writeUint8(RENDER_BORDER_STYLE[style] ?? RENDER_BORDER_STYLE.solid);
      const coords = borderBatch[key];
      writer.writeUint32(coords.length);
      for (const val of coords) writer.writeFloat64(val);
    }
    
    writeNullableRect(writer, data.renderRect || null);
    
    const colHeaders = data.colHeaders || [];
    writer.writeUint32(colHeaders.length);
    for (const h of colHeaders) {
      writer.writeInt32(h.c);
      writer.writeFloat64(h.x);
      writer.writeFloat64(h.w);
      writer.writeFloat64(h.h);
      writeSelectionRange(writer, h.selection || null);
    }
    
    const rowHeaders = data.rowHeaders || [];
    writer.writeUint32(rowHeaders.length);
    for (const h of rowHeaders) {
      writer.writeInt32(h.r);
      writer.writeFloat64(h.y);
      writer.writeFloat64(h.w);
      writer.writeFloat64(h.h);
      writeSelectionRange(writer, h.selection || null);
    }

    const frozenLines = data.frozenLines || [];
    writer.writeUint32(frozenLines.length);
    for (const line of frozenLines) {
      writer.writeFloat64(line.x1);
      writer.writeFloat64(line.y1);
      writer.writeFloat64(line.x2);
      writer.writeFloat64(line.y2);
    }

    // 冻结区域不透明底色矩形：缺失会导致 Worker 跳过冻结区底色填充，
    // 滚动中主体单元格会从冻结区透出
    const frozenRegions = data.frozenRegions || [];
    writer.writeUint32(frozenRegions.length);
    for (const region of frozenRegions) {
      writer.writeFloat64(region.x);
      writer.writeFloat64(region.y);
      writer.writeFloat64(region.w);
      writer.writeFloat64(region.h);
    }

    const buffer = writer.getTransferable();
    return { buffer, transferables: [buffer] };
}

/**
 * 反序列化渲染数据
 */
export function deserializeRenderData(buffer) {
    const reader = new BufferReader(buffer);
    const magic = reader.readUint32();
    if (magic !== 0x524E4452) throw new Error("Invalid render data magic");

    const width = reader.readFloat64();
    const height = reader.readFloat64();
    const theme = readRenderTheme(reader);

    const cellCount = reader.readUint32();

    // 读取样式映射表
    const styleMapCount = reader.readUint32();
    const styleMap = new Map();
    for (let i = 0; i < styleMapCount; i++) {
        const id = reader.readUint32();
        const style = readTextStyle(reader);
        styleMap.set(id, style);
    }

    const cellDataList = new Array(cellCount);
    for (let i = 0; i < cellCount; i++) {
        const r = reader.readInt32();
        const c = reader.readInt32();
        const x = reader.readFloat64();
        const y = reader.readFloat64();
        const w = reader.readFloat64();
        const h = reader.readFloat64();
        const bg = reader.readString();
        let text = null;
        if (reader.readUint8() === 1) {
            const content = reader.readString();
            // 根据样式 ID 还原样式对象
            const styleId = reader.readUint32();
            const style = styleId === 0xFFFFFFFF ? {} : (styleMap.get(styleId) || {});

            text = {
                content,
                style,
                // 下面这些属性可以从 style 中提取，或者由 Worker 渲染逻辑动态生成
                font: null,
                color: style.color || '#000000',
                align: style.align || 'left',
                valign: style.valign || 'middle',
                fSize: style.fontSize ? style.fontSize + 'px' : '13px',
                isWrap: !!style.wrap,
                padding: 4
            };
        }

        let clip = null;
        if (reader.readUint8() === 1) {
            clip = {
                x: reader.readFloat64(),
                y: reader.readFloat64(),
                w: reader.readFloat64(),
                h: reader.readFloat64()
            };
        }

        cellDataList[i] = { r, c, x, y, w, h, bg, text, clip };
    }

    const bgColorCount = reader.readUint32();
    const bgGroups = {};
    for (let i = 0; i < bgColorCount; i++) {
        const color = reader.readString();
        const rectCount = reader.readUint32();
        const rects = new Array(rectCount);
        for (let j = 0; j < rectCount; j++) rects[j] = reader.readFloat64();
        bgGroups[color] = rects;
    }

    const gridLinesCount = reader.readUint32();
    const gridLines = new Array(gridLinesCount);
    for (let i = 0; i < gridLinesCount; i++) gridLines[i] = reader.readFloat64();

    const borderBatchCount = reader.readUint32();
    const borderBatch = {};
    for (let i = 0; i < borderBatchCount; i++) {
        const color = reader.readString();
        const style = RENDER_BORDER_STYLE_BY_ID[reader.readUint8()] || 'solid';
        const key = `${color}|${style}`;
        const coordCount = reader.readUint32();
        const coords = new Array(coordCount);
        for (let j = 0; j < coordCount; j++) coords[j] = reader.readFloat64();
        borderBatch[key] = coords;
    }

    const renderRect = readNullableRect(reader);
    
    const colHeaderCount = reader.readUint32();
    const colHeaders = new Array(colHeaderCount);
    for (let i = 0; i < colHeaderCount; i++) {
      colHeaders[i] = {
        c: reader.readInt32(),
        x: reader.readFloat64(),
        w: reader.readFloat64(),
        h: reader.readFloat64(),
        selection: readSelectionRange(reader)
      };
    }
    
    const rowHeaderCount = reader.readUint32();
    const rowHeaders = new Array(rowHeaderCount);
    for (let i = 0; i < rowHeaderCount; i++) {
      rowHeaders[i] = {
        r: reader.readInt32(),
        y: reader.readFloat64(),
        w: reader.readFloat64(),
        h: reader.readFloat64(),
        selection: readSelectionRange(reader)
      };
    }

    const frozenLineCount = reader.remaining > 0 ? reader.readUint32() : 0;
    const frozenLines = new Array(frozenLineCount);
    for (let i = 0; i < frozenLineCount; i++) {
      frozenLines[i] = {
        x1: reader.readFloat64(),
        y1: reader.readFloat64(),
        x2: reader.readFloat64(),
        y2: reader.readFloat64()
      };
    }

    const frozenRegionCount = reader.remaining > 0 ? reader.readUint32() : 0;
    const frozenRegions = new Array(frozenRegionCount);
    for (let i = 0; i < frozenRegionCount; i++) {
      frozenRegions[i] = {
        x: reader.readFloat64(),
        y: reader.readFloat64(),
        w: reader.readFloat64(),
        h: reader.readFloat64()
      };
    }

    return {
      width, height, theme,
      cellDataList, bgGroups, gridLines, borderBatch,
      renderRect, colHeaders, rowHeaders, frozenLines, frozenRegions
    };
}

export default {
  serializeFormulaBatch,
  deserializeFormulaBatch,
  serializeFormulaResults,
  deserializeFormulaResults,
  isTransferableSupported,
  BufferWriter,
  BufferReader,
  serializeRenderData,
  deserializeRenderData
};
