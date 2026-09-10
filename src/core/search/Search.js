/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
import { cloneCell } from '../utils/Clipboard.js';
import { parseCellKey } from '../data/CellKey.js';
import { Events } from '../events/EventEmitter.js';

import { SearchOptimizer } from './SearchOptimizer.js';

// 当 pending 单点变更累积到 entries 数量的此比例时，全量重建可能比逐个 patch 更快
const REBUILD_THRESHOLD_RATIO = 0.3;
const REBUILD_THRESHOLD_MIN = 50;

/**
 * @typedef {Object} SearchEngineDeps
 * @property {() => number} getDataVersion
 * @property {() => Object} getDataMatrix
 * @property {(r: number, c: number) => string} cellKey
 * @property {(r: number, c: number) => Object|null} getCell
 * @property {(updates: Array<{r:number,c:number,val:Object}>) => void} bulkSetCells
 * @property {(r: number, c: number, val: Object) => void} setCell
 */

/**
 * 搜索引擎 - 支持二分搜索和正则表达式
 *
 * 功能：
 * 1. 二分搜索快速定位起始位置
 * 2. 正则表达式支持（用 /pattern/flags 格式）
 * 3. 大小写敏感选项
 * 4. 全词匹配选项
 * 5. 循环搜索
 */
export class SearchEngine {
    /**
     * @param {SearchEngineDeps} deps
     */
    constructor(deps) {
        /** @type {SearchEngineDeps} */
        this.d = deps;
        this.cache = {
            version: -1,
            index: [],         // 按 (r,c) 升序排列的 { r, c, key, v }
            needsRebuild: true // 结构变化或批量加载后下次 _ensureIndex 走全量重建
        };
        /**
         * 单点变更队列。CELL_CHANGE 事件触发时入队，下次 _ensureIndex 时按二分位置 patch 索引。
         * 若累计过多则改走全量重建。
         * @type {Array<{r:number,c:number,newValue:Object|null}>}
         */
        this._pendingChanges = [];
        /** 事件订阅是否已建立。延迟到首次 _ensureIndex 时再 bind，避开 Workbook 构造期 _events 还未创建的顺序问题 */
        this._eventsBound = false;

        // 启用优化器
        this.optimizer = new SearchOptimizer(this);
    }

    /**
     * 订阅 Workbook 事件以维护增量索引。延迟绑定。
     * @private
     */
    _bindEventsIfNeeded() {
        if (this._eventsBound) return;

        this._onCellChange = ({ r, c, newValue }) => {
            // 仅在索引已建立时收集 delta，避免索引未建立前的事件白白堆积
            if (this.cache.needsRebuild) return;
            this._pendingChanges.push({ r, c, newValue });
        };
        this._onStructuralChange = () => {
            // 结构性变化（行列增删 / 数据批量加载）：放弃 delta，下次走全量重建
            this.cache.needsRebuild = true;
            this._pendingChanges.length = 0;
        };

        // 订阅 Workbook 的 EventEmitter，维护增量索引。
        // 这三个事件仅由 Workbook 产生（source 恒为 workbook），故无需 source 过滤。
        this.d.onEvent(Events.CELL_CHANGE, this._onCellChange);
        this.d.onEvent(Events.DATA_LOAD, this._onStructuralChange);
        this.d.onEvent(Events.STRUCTURE_CHANGE, this._onStructuralChange);
        this._eventsBound = true;
    }

    /**
     * 确保索引是最新的。
     * - 标记 needsRebuild 或版本号大幅落后 → 全量重建
     * - 有 pending changes → 二分 patch
     * - 否则直接返回
     * @private
     */
    _ensureIndex() {
        this._bindEventsIfNeeded();
        const wbVersion = this.d.getDataVersion();

        // 版本号未变且无 pending：快路径直接返回
        if (!this.cache.needsRebuild
            && this._pendingChanges.length === 0
            && this.cache.version === wbVersion) {
            return;
        }

        if (this.cache.needsRebuild) {
            this._fullRebuild();
            return;
        }

        // pending 太多时全量重建更快
        const pendingCount = this._pendingChanges.length;
        if (pendingCount > REBUILD_THRESHOLD_MIN
            && pendingCount > this.cache.index.length * REBUILD_THRESHOLD_RATIO) {
            this._fullRebuild();
            return;
        }

        if (pendingCount > 0) {
            this._applyPendingChanges();
        }

        // 兜底：如果 dataVersion 与 cache.version 仍不一致，说明某条变更路径漏发了事件 → 全量重建
        if (this.cache.version !== wbVersion) {
            this._fullRebuild();
        }
    }

    /**
     * 全量重建索引。
     * @private
     */
    _fullRebuild() {
        const d = this.d;
        const entries = [];
        const matrix = d.getDataMatrix();

        if (matrix && typeof matrix.forEach === 'function') {
            matrix.forEach((r, c, cell) => {
                const key = d.cellKey(r, c);
                entries.push({ r, c, key, v: cell ? cell.v : undefined });
            });
        }

        entries.sort((a, b) => {
            if (a.r !== b.r) return a.r - b.r;
            return a.c - b.c;
        });

        this.cache.index = entries;
        this.cache.version = d.getDataVersion();
        this.cache.needsRebuild = false;
        this._pendingChanges.length = 0;
    }

    /**
     * 应用 pending changes 到索引（二分插入/更新/删除）。
     * @private
     */
    _applyPendingChanges() {
        const d = this.d;
        const idx = this.cache.index;
        const pending = this._pendingChanges;

        for (let i = 0; i < pending.length; i++) {
            const { r, c, newValue } = pending[i];
            const pos = this._lowerBound(r, c);
            const exists = pos < idx.length && idx[pos].r === r && idx[pos].c === c;
            const isRemoval = newValue === null || newValue === undefined;

            if (isRemoval) {
                if (exists) idx.splice(pos, 1);
            } else if (exists) {
                idx[pos].v = newValue.v;
            } else {
                idx.splice(pos, 0, { r, c, key: d.cellKey(r, c), v: newValue.v });
            }
        }

        this._pendingChanges.length = 0;
        this.cache.version = d.getDataVersion();
    }

    /**
     * 二分查找：返回第一个 (r,c) ≥ 目标 (targetR,targetC) 的索引下标。
     * 与 _binarySearchStart 等价，但抽出来供 _applyPendingChanges 复用。
     * @private
     */
    _lowerBound(targetR, targetC) {
        const idx = this.cache.index;
        let lo = 0;
        let hi = idx.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const e = idx[mid];
            if (e.r < targetR || (e.r === targetR && e.c < targetC)) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    /**
     * 销毁：解除事件订阅，释放索引内存。
     */
    destroy() {
        if (this._eventsBound) {
            if (this._onCellChange) this.d.offEvent(Events.CELL_CHANGE, this._onCellChange);
            if (this._onStructuralChange) {
                this.d.offEvent(Events.DATA_LOAD, this._onStructuralChange);
                this.d.offEvent(Events.STRUCTURE_CHANGE, this._onStructuralChange);
            }
        }
        this._eventsBound = false;
        this._onCellChange = null;
        this._onStructuralChange = null;
        this.cache.index = [];
        this._pendingChanges.length = 0;
    }

    /**
     * 二分搜索找到起始位置
     * @param {number} startR - 起始行
     * @param {number} startC - 起始列
     * @returns {number} 第一个 ≥ startFrom 的索引
     * @private
     */
    _binarySearchStart(startR, startC) {
        return this._lowerBound(startR, startC);
    }

    /**
     * 解析搜索查询
     * @param {string} query - 搜索查询
     * @param {Object} options - 搜索选项
     * @returns {Object} 解析结果 { regex, isRegex, queryStr }
     * @private
     */
    _parseQuery(query, options = {}) {
        const { caseSensitive = false, wholeWord = false } = options;
        
        // 检查是否是正则表达式格式：/pattern/flags
        const regexMatch = query.match(/^\/(.+)\/([gimsuy]*)$/);
        
        if (regexMatch) {
            try {
                const pattern = regexMatch[1];
                const flags = regexMatch[2] || '';
                // 如果指定了大小写敏感选项，覆盖 flags
                const finalFlags = caseSensitive ? flags.replace('i', '') : (flags.includes('i') ? flags : flags + 'i');
                return {
                    regex: new RegExp(pattern, finalFlags),
                    isRegex: true,
                    queryStr: pattern
                };
            } catch (e) {
                // 正则表达式无效，作为普通字符串处理
                console.warn('Invalid regex pattern, treating as plain text:', e.message);
            }
        }

        // 普通字符串搜索
        const queryStr = String(query);
        let regex = null;

        if (wholeWord) {
            // 全词匹配：精确匹配整个字符串
            const escaped = queryStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(`^${escaped}$`, caseSensitive ? '' : 'i');
        } else if (!caseSensitive) {
            // 不区分大小写
            const escaped = queryStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(escaped, 'i');
        }

        return {
            regex,
            isRegex: false,
            queryStr: caseSensitive ? queryStr : queryStr.toLowerCase()
        };
    }

    /**
     * 检查值是否匹配
     * @param {*} value - 单元格值
     * @param {Object} parsedQuery - 解析后的查询对象
     * @param {Object} options - 搜索选项
     * @returns {boolean} 是否匹配
     * @private
     */
    _matchValue(value, parsedQuery, options) {
        if (value === undefined || value === null) return false;
        
        const valStr = String(value);
        const { regex, isRegex, queryStr } = parsedQuery;
        const { caseSensitive = false } = options;

        if (regex) {
            return regex.test(valStr);
        }

        // 简单字符串匹配
        if (caseSensitive) {
            return valStr.includes(queryStr);
        }
        return valStr.toLowerCase().includes(queryStr);
    }

    /**
     * 直接读取单元格，避免通过 workbook.data getter 构造完整数据副本。
     * @param {{r: number, c: number, key?: number|string}} cellRef - 单元格引用
     * @returns {Object|null} 单元格数据
     * @private
     */
    _getCellByRef(cellRef) {
        if (!cellRef) return null;
        return this.d.getCell(cellRef.r, cellRef.c);
    }

    /**
     * 按行列直接读取单元格。
     * @param {number} r - 行索引
     * @param {number} c - 列索引
     * @returns {Object|null} 单元格数据
     * @private
     */
    _getCellAt(r, c) {
        return this.d.getCell(r, c);
    }

    /**
     * 查找下一个匹配的单元格
     * @param {string} query - 搜索查询
     * @param {Object} startFrom - 起始位置 { r, c }
     * @param {Object} options - 搜索选项
     * @param {boolean} options.caseSensitive - 是否区分大小写
     * @param {boolean} options.wholeWord - 是否全词匹配
     * @param {boolean} options.wrapAround - 是否循环搜索
     * @returns {Object|null} 匹配的单元格位置 { r, c }
     */
    find(query, startFrom = { r: 0, c: 0 }, options = {}) {
        if (!query) return null;

        this._ensureIndex();
        const index = this.cache.index;
        
        if (index.length === 0) return null;

        const { wrapAround = true } = options;
        const parsedQuery = this._parseQuery(query, options);
        const { r: startR, c: startC } = startFrom;

        // 使用二分搜索找到起始索引
        let startIndex = this._binarySearchStart(startR, startC);

        // 从 startIndex 开始搜索
        for (let i = startIndex; i < index.length; i++) {
            const cellRef = index[i];
            const val = cellRef.v !== undefined ? cellRef.v : this._getCellByRef(cellRef)?.v;
            if (this._matchValue(val, parsedQuery, options)) {
                return { r: cellRef.r, c: cellRef.c };
            }
        }

        // 循环搜索：从头开始到 startIndex
        if (wrapAround && startIndex > 0) {
            for (let i = 0; i < startIndex; i++) {
                const cellRef = index[i];
                const val = cellRef.v !== undefined ? cellRef.v : this._getCellByRef(cellRef)?.v;

                if (this._matchValue(val, parsedQuery, options)) {
                    return { r: cellRef.r, c: cellRef.c };
                }
            }
        }
        
        
        return null;
    }

    /**
     * 查找所有匹配的单元格
     * @param {string} query - 搜索查询
     * @param {Object} options - 搜索选项
     * @returns {Array} 匹配的单元格位置数组 [{ r, c }, ...]
     */
    findAll(query, options = {}) {
        if (!query) return [];

        this._ensureIndex();
        const index = this.cache.index;
        const results = [];
        const parsedQuery = this._parseQuery(query, options);

        for (let i = 0; i < index.length; i++) {
            const cellRef = index[i];
            const val = cellRef.v !== undefined ? cellRef.v : this._getCellByRef(cellRef)?.v;

            if (this._matchValue(val, parsedQuery, options)) {
                results.push({ r: cellRef.r, c: cellRef.c });
            }
        }

        return results;
    }

    /**
     * 带缓存和增量索引的查找（由优化器提供）
     * @param {string} query - 搜索查询
     * @param {Object} startFrom - 起始位置
     * @param {Object} options - 搜索选项
     */
    findWithCache(query, startFrom = { r: 0, c: 0 }, options = {}) {
        return this.optimizer.findWithCache(query, startFrom, options);
    }

    /**
     * 并行查找所有匹配的单元格（由优化器提供）
     * @param {string} query - 搜索查询
     * @param {Object} options - 搜索选项
     */
    findAllParallel(query, options = {}) {
        return this.optimizer.findAllParallel(query, options);
    }

    /**
     * 查找上一个匹配的单元格
     * @param {string} query - 搜索查询
     * @param {Object} startFrom - 起始位置 { r, c }
     * @param {Object} options - 搜索选项
     * @returns {Object|null} 匹配的单元格位置 { r, c }
     */
    findPrevious(query, startFrom = { r: 0, c: 0 }, options = {}) {
        if (!query) return null;

        this._ensureIndex();
        const index = this.cache.index;
        
        if (index.length === 0) return null;

        const { wrapAround = true } = options;
        const parsedQuery = this._parseQuery(query, options);
        const { r: startR, c: startC } = startFrom;

        // 找到当前位置的索引
        let currentIndex = this._binarySearchStart(startR, startC);
        
        // 如果当前位置就是匹配的，需要从上一个开始
        if (currentIndex > 0) {
            currentIndex--;
        }

        // 向前搜索
        for (let i = currentIndex; i >= 0; i--) {
            const cellRef = index[i];
            const val = cellRef.v !== undefined ? cellRef.v : this._getCellByRef(cellRef)?.v;

            if (this._matchValue(val, parsedQuery, options)) {
                return { r: cellRef.r, c: cellRef.c };
            }
        }

        // 循环搜索：从末尾开始
        if (wrapAround) {
            for (let i = index.length - 1; i > currentIndex; i--) {
                const cellRef = index[i];
                const val = cellRef.v !== undefined ? cellRef.v : this._getCellByRef(cellRef)?.v;

                if (this._matchValue(val, parsedQuery, options)) {
                    return { r: cellRef.r, c: cellRef.c };
                }
            }
        }

        return null;
    }

    /**
     * 替换所有匹配的单元格
     * @param {string} query - 搜索查询
     * @param {string} replaceText - 替换文本
     * @param {Object} options - 搜索选项
     * @returns {number} 替换的数量
     */
    replaceAll(query, replaceText, options = {}) {
        if (!query) return 0;

        const parsedQuery = this._parseQuery(query, options);
        const { regex, queryStr } = parsedQuery;
        // 说明：_parseQuery 已经把 isRegex、wholeWord、!caseSensitive 三种场景统一封装为
        // 同一个 `regex` 对象；仅在「caseSensitive 简单字符串」时 regex 为 null。所以
        // 这里两分支即可覆盖全部情况，旧版本的 `else if (regex)` 与 caseInsensitive
        // 字符串子分支都是不可达的。

        let count = 0;
        const updates = [];

        // 直接遍历稀疏矩阵，避免 workbook.data getter 构造完整 O(N) 副本
        const matrix = this.d.getDataMatrix();
        if (!matrix || typeof matrix.forEach !== 'function') return 0;

        matrix.forEach((r, c, cell) => {
            if (!cell || cell.v === undefined || cell.v === null) return;

            const valStr = String(cell.v);
            let matched = false;
            let newVal = valStr;

            if (regex) {
                regex.lastIndex = 0;
                if (regex.test(valStr)) {
                    matched = true;
                    regex.lastIndex = 0;
                    newVal = valStr.replace(regex, replaceText);
                }
            } else if (valStr.includes(queryStr)) {
                matched = true;
                newVal = valStr.split(queryStr).join(replaceText);
            }

            if (matched) {
                const newCellData = { ...cloneCell(cell), v: newVal };
                updates.push({ r, c, val: newCellData });
                count++;
            }
        });

        if (updates.length > 0) {
            this.d.bulkSetCells(updates);
        }

        return count;
    }

    /**
     * 替换单个匹配的单元格
     * @param {string} query - 搜索查询
     * @param {string} replaceText - 替换文本
     * @param {Object} position - 要替换的位置 { r, c }
     * @param {Object} options - 搜索选项
     * @returns {boolean} 是否成功替换
     */
    replaceAt(query, replaceText, position, options = {}) {
        if (!query || !position) return false;

        const cell = this._getCellAt(position.r, position.c);

        if (!cell || cell.v === undefined || cell.v === null) return false;

        const parsedQuery = this._parseQuery(query, options);
        const { regex, queryStr } = parsedQuery;

        const valStr = String(cell.v);
        let newVal = valStr;

        if (regex) {
            regex.lastIndex = 0;
            newVal = valStr.replace(regex, replaceText);
        } else {
            // 仅 caseSensitive 简单字符串路径会落到这里（见 replaceAll 注释）
            newVal = valStr.split(queryStr).join(replaceText);
        }

        if (newVal !== valStr) {
            const newCellData = { ...cloneCell(cell), v: newVal };
            this.d.setCell(position.r, position.c, newCellData);
            return true;
        }

        return false;
    }

    /**
     * 获取匹配单元格的数量
     * @param {string} query - 搜索查询
     * @param {Object} options - 搜索选项
     * @returns {number} 匹配数量
     */
    countMatches(query, options = {}) {
        return this.findAll(query, options).length;
    }
}
export { parseCellKey };
