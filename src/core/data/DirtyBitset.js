/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * 脏单元格位图 - 使用 TypedArray 优化大规模脏标记存储与遍历
 * 相比于 Set<number>，Bitset 在高频操作和内存占用上更具优势
 */
// 每行位图按需扩容的最小起始字数。
// 旧实现固定 32 word（1024 列），对小表（绝大多数场景 ≤ 64 列）每行浪费 ~120B；
// 累计到数千脏行时浪费几百 KB。改用 4 word（128 列）起步，按需扩容。
const DEFAULT_ROW_WORDS = 4;

export class DirtyBitset {
  /**
   * @param {Object} [options]
   * @param {number} [options.colHint] 列数提示，按此值预分配行字数避免后续扩容
   */
  constructor(options = {}) {
    /** @type {Map<number, Uint32Array>} 按行存储位图，节省稀疏矩阵下的空间 */
    this._rows = new Map();
    this._size = 0;
    // 行初始字数：colHint/32 上取整，下限 1 word（32 列），无 hint 时用 DEFAULT_ROW_WORDS
    const colHint = Number.isInteger(options.colHint) && options.colHint > 0 ? options.colHint : 0;
    this._initialRowWords = colHint > 0
      ? Math.max(1, Math.ceil(colHint / 32))
      : DEFAULT_ROW_WORDS;
    // 包围盒（AABB）：所有脏单元格的最小外接矩形，用于 hasAnyInRange O(1) 早退
    this._minR = Infinity;
    this._maxR = -Infinity;
    this._minC = Infinity;
    this._maxC = -Infinity;
    // 全局版本号：任何 add 引入新脏位或 clear 都自增，用于上游缓存校验
    this._version = 0;
  }

  /**
   * 当前版本号。新脏位写入或 clear 都会自增。
   * 上游缓存可记录创建时的版本号，下次校验时若版本未变即可跳过完整检查。
   */
  get version() {
    return this._version;
  }

  /**
   * 标记单元格为脏
   * @param {number} r - 行索引
   * @param {number} c - 列索引
   */
  add(r, c) {
    let row = this._rows.get(r);
    const wordIdx = c >>> 5;
    if (!row) {
      // 按 colHint 或默认起始字数分配；若目标列超出起始范围则一次分配到位
      const initWords = Math.max(this._initialRowWords, wordIdx + 1);
      row = new Uint32Array(initWords);
      this._rows.set(r, row);
    } else if (wordIdx >= row.length) {
      const newRow = new Uint32Array(wordIdx + 4);
      newRow.set(row);
      row = newRow;
      this._rows.set(r, row);
    }

    const bit = 1 << (c & 31);
    if (!(row[wordIdx] & bit)) {
      row[wordIdx] |= bit;
      this._size++;
      // 仅在写入新脏位时维护包围盒和版本号
      if (r < this._minR) this._minR = r;
      if (r > this._maxR) this._maxR = r;
      if (c < this._minC) this._minC = c;
      if (c > this._maxC) this._maxC = c;
      this._version++;
      return true;
    }
    return false;
  }

  /**
   * 检查单元格是否为脏
   */
  has(r, c) {
    const row = this._rows.get(r);
    if (!row) return false;
    const wordIdx = c >>> 5;
    if (wordIdx >= row.length) return false;
    return (row[wordIdx] & (1 << (c & 31))) !== 0;
  }

  /**
   * 检查范围内是否有任何脏单元格
   * @param {number} startR - 起始行
   * @param {number} endR - 结束行
   * @param {number} startC - 起始列
   * @param {number} endC - 结束列
   * @returns {boolean}
   */
  hasAnyInRange(startR, endR, startC, endC) {
    if (this._size === 0) return false;

    // AABB 早退：查询范围与当前脏区包围盒不相交直接返回 false
    if (endR < this._minR || startR > this._maxR ||
        endC < this._minC || startC > this._maxC) {
      return false;
    }

    for (let r = startR; r <= endR; r++) {
      const row = this._rows.get(r);
      if (!row) continue;
      
      const startWordIdx = startC >>> 5;
      const endWordIdx = endC >>> 5;
      
      const maxIdx = row.length - 1;
      const actualEndWordIdx = Math.min(endWordIdx, maxIdx);
      
      if (startWordIdx > maxIdx) continue;
      
      for (let i = startWordIdx; i <= actualEndWordIdx; i++) {
        const word = row[i];
        if (word === 0) continue;
        
        let mask = 0xFFFFFFFF;
        if (i === startWordIdx) {
          // 清除起始字中 startC 之前的位
          mask &= (0xFFFFFFFF << (startC & 31));
        }
        if (i === endWordIdx) {
          // 清除结束字中 endC 之后的位
          const endBit = endC & 31;
          mask &= (endBit === 31 ? 0xFFFFFFFF : (1 << (endBit + 1)) - 1);
        }
        
        if (word & mask) return true;
      }
    }
    return false;
  }

  /**
   * 遍历所有脏单元格
   * @param {Function} callback - (r, c) => void
   */
  forEach(callback) {
    for (const [r, row] of this._rows) {
      for (let i = 0; i < row.length; i++) {
        let word = row[i];
        if (word === 0) continue;
        
        for (let b = 0; b < 32; b++) {
          if (word & (1 << b)) {
            callback(r, (i << 5) | b);
          }
        }
      }
    }
  }

  /**
   * 获取脏单元格总数
   */
  get size() {
    return this._size;
  }

  /**
   * 清空位图
   */
  clear() {
    this._rows.clear();
    this._size = 0;
    this._minR = Infinity;
    this._maxR = -Infinity;
    this._minC = Infinity;
    this._maxC = -Infinity;
    this._version++;
  }
}
