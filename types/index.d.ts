/**
 * vue-canvas-sheet 类型定义
 *
 * 覆盖三个入口：
 *  - 'vue-canvas-sheet'        默认导出 TableDesigner，并再导出 Workbook / SvgIcon / 内置插件
 *  - 'vue-canvas-sheet/core'   Workbook / Store / EventEmitter / PluginRegistry / SharedValueStore
 *  - 'vue-canvas-sheet/render' OffscreenRenderer / ProgressiveRenderer / TextLayout 工具
 *
 * 文档参考：
 *  - 包导出总览：docs/API_OVERVIEW.md
 *  - Workbook API：docs/WORKBOOK_API.md
 *  - 插件开发：docs/PLUGIN_DEVELOPMENT.md
 */

import type { Component } from 'vue';

// ============================================================
// 基础数据结构
// ============================================================

export interface CellRef {
  r: number;
  c: number;
}

export interface Range {
  s: CellRef;
  e: CellRef;
}

export interface CellStyle {
  fontWeight?: string;
  fontStyle?: string;
  fontSize?: number;
  color?: string;
  bg?: string;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  border?: any;
  fmt?: string;
  decimals?: number;
  wrap?: boolean;
}

export interface Cell {
  /** 单元格值 */
  v?: any;
  /** 公式（以 = 开头） */
  f?: string;
  /** 样式 */
  s?: CellStyle;
  /** 格式化后的显示文本 */
  m?: string;
  /** 是否需要重算 */
  dirty?: boolean;
}

export interface WorkbookOptions {
  enablePersistence?: boolean;
  sheetId?: string;
}

// ============================================================
// 事件
// ============================================================

export type EventType =
  | 'cell-change'
  | 'selection-change'
  | 'data-load'
  | 'structure-change'
  | 'style-change'
  | 'merge-change'
  | 'freeze-change'
  | 'history-change'
  | 'formulas-calculated'
  | 'error'
  | 'save-status'
  | 'change';

export const Events: Record<string, EventType>;

/** 取消订阅函数 */
export type Unsubscribe = () => void;

export class EventEmitter {
  constructor();
  on(event: string, callback: Function): Unsubscribe;
  off(event: string, callback: Function): void;
  once(event: string, callback: Function): Unsubscribe;
  emit(event: string, payload?: any): void;
  emitThrottled(event: string, delay?: number): void;
  emitDedup(event: string, payload?: any): void;
  emitBatch(events: Array<{ event: string; payload?: any }>): void;
  clear(event?: string): void;
  listenerCount(event: string): number;
}

// ============================================================
// 插件系统
// ============================================================

export type HookType =
  | 'before-init' | 'after-init'
  | 'before-mount' | 'after-mount'
  | 'before-unmount' | 'after-unmount'
  | EventType;

export const HookTypes: Record<string, HookType>;

export interface PluginInterface {
  name: string;
  version?: string;
  description?: string;
  dependencies?: string[];
  hooks?: Record<string, Function>;
  onInit?: (workbook: Workbook, registry: PluginRegistry) => void;
  onMounted?: (workbook: Workbook, registry: PluginRegistry) => void;
  onUnmount?: () => void;
  onError?: (error: Error, workbook: Workbook) => void;
  lazyLoad?: () => Promise<void>;
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  mounted: boolean;
  dependencies: string[];
}

export class PluginRegistry {
  constructor(workbook: Workbook);
  init(): void;
  register(plugin: PluginInterface, options?: { autoMount?: boolean }): PluginRegistry;
  /** @deprecated 使用 register() 替代 */
  add(plugin: PluginInterface): void;
  unregister(name: string): boolean;
  mountAll(): void;
  get(name: string): PluginInterface | undefined;
  has(name: string): boolean;
  isMounted(name: string): boolean;
  on(hookType: string, handler: Function): Unsubscribe;
  off(hookType: string, handler: Function): void;
  trigger(hookType: string, data: any): any;
  setSharedState(key: string, value: any): void;
  getSharedState<T = any>(key: string, defaultValue?: T): T;
  deleteSharedState(key: string): boolean;
  getPluginInfo(): PluginInfo[];
  optimizeHooks(): void;
  getPerformanceReport(): any;
  destroy(): void;
}

/** 创建基础插件对象 */
export function createPlugin(name: string, definition?: Partial<PluginInterface> & Record<string, any>): PluginInterface;

// ============================================================
// Store 状态管理
// ============================================================

export interface StoreOptions {
  freezeMode?: 'none' | 'shallow' | 'deep';
  useCompactKey?: boolean;
}

export class Store<S = any> {
  constructor(initialState?: S, options?: StoreOptions);
  getState(): S;
  setState(updater: Partial<S> | ((state: S) => Partial<S>)): void;
  beginBatch(): void;
  endBatch(): void;
  subscribe(listener: (state: S) => void): Unsubscribe;
  select<T>(selector: (state: S) => T, listener: (value: T) => void): Unsubscribe;
  clear(): void;
}

export class StoreManager {
  constructor(stores?: Record<string, Store>);
  getStore(name: string): Store | undefined;
  addStore(name: string, store: Store): void;
  subscribe(listener: Function): Unsubscribe;
  beginBatch(): void;
  endBatch(): void;
  clear(): void;
  destroy(): void;
}

// ============================================================
// SharedValueStore（SharedArrayBuffer 数值存储）
// ============================================================

export class SharedValueStore {
  constructor(maxRows?: number, maxCols?: number);
  set(r: number, c: number, val: number): void;
  get(r: number, c: number): number;
  getValue(r: number, c: number): number;
  getBuffer(): ArrayBuffer | SharedArrayBuffer;
  clear(): void;
  serialize(): any;
  updateFromSerialized(data: any): void;
}

// ============================================================
// Workbook 核心引擎
// 完整方法说明见 docs/WORKBOOK_API.md
// ============================================================

export class Workbook {
  constructor(options?: WorkbookOptions);

  // ---- 属性 ----
  plugins: PluginRegistry;
  history: any;
  searchEngine: any;
  search: any;
  clipboard: any;
  errorHandler: any;
  data: Record<string, Cell>;
  rowCount: number;
  colCount: number;
  readOnly: boolean;
  colWidths: Record<number, number>;
  rowHeights: Record<number, number>;
  defaultColWidth: number;
  defaultRowHeight: number;
  merges: Range[];
  mergeMap: Record<string, Range>;
  selection: Range;
  activeCell: CellRef;
  copyRange: Range | null;
  freeze: CellRef;
  dataVersion: number;
  fieldMap: Record<string, any>;
  headerDepth: number;
  dependencyMap: Map<any, any>;
  reverseDependencyMap: Map<any, any>;
  readonly totalWidth: number;
  readonly totalHeight: number;

  // ---- 数据读写 ----
  setData(data: any[] | Record<string, Cell>): void;
  setColumns(columns: any[]): void;
  getCell(r: number, c: number): Cell | null;
  getStyle(r: number, c: number): CellStyle;
  setCell(r: number, c: number, val: Partial<Cell> | null, optOldValue?: Cell | null): void;
  bulkSetCells(updates: Array<{ r: number; c: number; val: Partial<Cell> }>): void;
  getCellValue(r: number, c: number, stack?: any[]): any;
  iterateRange(range: Range, callback: (r: number, c: number, cell: Cell | null) => void): void;
  collectRange<T>(range: Range, callback: (r: number, c: number, cell: Cell | null) => T): T[];

  // ---- 样式与格式 ----
  setStyle(range: Range, style: CellStyle): void;
  setBorder(range: Range, type: string, color: string, style?: string): void;
  setFormat(range: Range, fmt: string): void;
  setDecimals(range: Range, delta: number): void;
  clearContent(range: Range): void;

  // ---- 合并单元格 ----
  mergeCells(range: Range): void;
  unmergeCells(range: Range): void;
  addMerge(range: Range): void;
  removeMerge(range: Range): void;
  getMerge(r: number, c: number): Range | null;
  getIntersectingMerges(range: Range): Range[];
  allowsMerge(range: Range): boolean;
  allowsUnmerge(range: Range): boolean;

  // ---- 行列结构 ----
  insertRow(rowIndex: number): void;
  deleteRow(rowIndex: number): void;
  insertColumn(colIndex: number): void;
  deleteColumn(colIndex: number): void;
  moveColumn(fromC: number, toC: number): void;
  fillAuto(sourceRange: Range, targetRange: Range): void;
  getColWidth(c: number): number;
  setColWidth(c: number, w: number): void;
  getRowHeight(r: number): number;
  setRowHeight(r: number, h: number): void;
  setFreeze(r: number, c: number): void;

  // ---- 选区与剪贴板 ----
  setSelection(startR: number, startC: number, endR: number, endC: number): void;
  setCopyRange(range: Range): void;
  clearCopyRange(): void;
  copy(range: Range): void;
  paste(range: Range): void;
  clearCells(range: Range): void;

  // ---- 公式与计算 ----
  recalcAll(options?: { useWorker?: boolean }): Promise<void> | void;
  recalcDirty(): void;
  triggerRecalc(r: number, c: number, stack?: any[]): void;
  evaluateFormula(formula: string, r: number, c: number, stack?: any[]): any;
  getDependencies(formula: string): string[];
  rebuildDependencyMap(): void;
  getCalculationStats(): any | null;
  resetCalculationStats(): void;

  // ---- 历史记录 ----
  undo(): void;
  redo(): void;
  applyCommand(cmd: any, isUndo: boolean): void;

  // ---- 序列化 ----
  toJSON(): {
    rowCount: number;
    colCount: number;
    rowHeights: Record<number, number>;
    colWidths: Record<number, number>;
    data: Record<string, Cell>;
    merges: Range[];
    freeze: CellRef;
  };
  fromJSON(json: any): void;

  // ---- 查找替换 ----
  find(query: any, startFrom?: CellRef): any;
  replaceAll(query: any, replaceText: string): number;

  // ---- 事件与订阅 ----
  on(event: EventType | string, callback: Function): Unsubscribe;
  off(event: EventType | string, callback: Function): void;
  once(event: EventType | string, callback: Function): Unsubscribe;
  subscribe(fn: Function): Unsubscribe;
  notify(data?: any): void;

  // ---- 插件 ----
  usePlugin(plugin: PluginInterface, options?: { autoMount?: boolean }): Workbook;
  unusePlugin(name: string): boolean;
  getPlugin(name: string): PluginInterface | undefined;

  // ---- Web Worker ----
  enableWorker(options?: { timeout?: number }): Workbook;
  disableWorker(): void;
  isWorkerEnabled(): boolean;
  getWorkerStats(): any | null;

  // ---- WASM ----
  initWasm(): Promise<void>;

  // ---- 性能监控 ----
  enablePerformanceMonitoring(options?: { thresholds?: Record<string, number> }): void;
  disablePerformanceMonitoring(): void;
  getPerformanceReport(): any;
  getPerformanceMonitor(): any;
  exportPerformanceJSON(): string;
  exportPerformanceCSV(): string;
  printPerformanceSummary(): void;
  getSystemReport(): any;

  // ---- Store 状态管理 ----
  subscribeData(listener: Function): Unsubscribe;
  subscribeSelection(listener: Function): Unsubscribe;
  subscribeUI(listener: Function): Unsubscribe;
  select(storeName: 'data' | 'selection' | 'ui', selector: Function, listener: Function): Unsubscribe;
  beginBatchUpdate(): void;
  endBatchUpdate(): void;
  getStoreManager(): StoreManager;
  getStore(name: string): Store | undefined;

  // ---- 对象池 ----
  warmupPool(cellCount?: number): void;
  getPoolStats(): any;
  getPoolManager(): any;

  // ---- 持久化 ----
  enablePersistenceStorage(options?: { sheetId?: string; storageOptions?: any }): void;
  persist(sheetId?: string): Promise<any>;
  loadFromStorage(sheetId?: string): Promise<any>;
  savePendingChanges(sheetId?: string): Promise<any>;
  flushPersistence(): Promise<any>;

  // ---- 布局与坐标 ----
  getRowPos(r: number): number;
  getColPos(c: number): number;
  getRowIndexAt(y: number): number;
  getColIndexAt(x: number): number;
  getFrozenSize(): { w: number; h: number };
  getLayoutVersion(): number;
  getAddress(r: number, c: number): string;

  // ---- 错误处理 ----
  getErrorHistory(limit?: number): any[];
  clearErrorHistory(): void;
  safeExecute<T>(fn: () => T, defaultValue: T, context?: any): T;

  // ---- 生命周期 ----
  destroy(): void;
}

// ============================================================
// 渲染（'vue-canvas-sheet/render'）
// ============================================================

export interface OffscreenRendererOptions {
  enableWorker?: boolean;
  [key: string]: any;
}

export class OffscreenRenderer {
  constructor(options?: OffscreenRendererOptions);
  destroy(): void;
  [key: string]: any;
}

export function createOffscreenRenderer(options?: OffscreenRendererOptions): OffscreenRenderer;
export function isOffscreenCanvasSupported(): boolean;

export const Priority: {
  CRITICAL: 0;
  HIGH: 1;
  NORMAL: 2;
  LOW: 3;
};

export const TaskState: {
  PENDING: 'pending';
  RUNNING: 'running';
  PAUSED: 'paused';
  COMPLETED: 'completed';
  CANCELLED: 'cancelled';
};

export function createProgressiveRenderer(options?: any): any;

// ---- TextLayout 文本布局工具 ----
export class LRUCache<K = any, V = any> {
  constructor(capacity?: number);
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  clear(): void;
}
export function makeTextCacheKey(font: string, text: string): string;
export function makeTextBitmapCacheKey(font: string, color: string, text: string): string;
export function makeWrappedTextCacheKey(font: string, availableWidth: number, text: string): string;
export function isNumberLikeText(text: string): boolean;
export function parseFontSize(fontOrSize: string | number, fallback?: number): number;
export function measureTextWidth(ctx: CanvasRenderingContext2D, text: string, font: string, options?: any): number;
export function canCacheTextBitmap(text: string, style: any): boolean;
export function getTextBitmapSize(textWidth: number, font: string, options?: any): { width: number; height: number };
export function getSingleLineTextLayout(options: {
  x: number; y: number; w: number; h: number;
  padding?: number;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
}): any;
export function getLineStartX(anchorX: number, align: string, width: number): number;
export function getBitmapDrawPosition(options: any): any;
export function getSingleLineDecoration(options: any): any;
export function wrapTextByWidth(text: string, availableWidth: number, font: string, measureText: Function, cache?: any, options?: any): string[];
export function getWrappedTextLayout(options: any): any;

// ============================================================
// 内置插件（随主入口 'vue-canvas-sheet' 导出）
// ============================================================

export interface AutoSaveOptions {
  backend?: 'indexedDB' | 'localStorage';
  interval?: number;
  key?: string;
  sheetId?: string;
  eventDriven?: boolean;
  debounce?: number;
  events?: string[];
  allowLocalStorageFallback?: boolean;
  storageOptions?: any;
}
export class AutoSavePlugin implements PluginInterface {
  name: string;
  constructor(options?: AutoSaveOptions);
  saveNow(workbook?: Workbook): Promise<any>;
  getStats(): any;
  onInit(workbook: Workbook, registry: PluginRegistry): void;
  onMounted(workbook: Workbook, registry: PluginRegistry): void;
  onUnmount(): void;
}
export function createAutoSavePlugin(options?: AutoSaveOptions): AutoSavePlugin;

export interface SelectionHistoryOptions {
  maxSize?: number;
}
export class SelectionHistoryPlugin implements PluginInterface {
  name: string;
  constructor(options?: SelectionHistoryOptions);
  goBack(): boolean;
  goForward(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  clearHistory(): void;
}
export function createSelectionHistoryPlugin(options?: SelectionHistoryOptions): SelectionHistoryPlugin;

export interface ExportOptions {
  defaultFileName?: string;
  useWorker?: boolean;
  onProgress?: (progress: any) => void;
  onComplete?: (result: any) => void;
  onError?: (error: Error) => void;
}
export class ExportPlugin implements PluginInterface {
  name: string;
  constructor(options?: ExportOptions);
  exportExcel(options?: any): Promise<any>;
  exportJSON(options?: any): any;
  exportCSV(options?: any): any;
}
export function createExportPlugin(options?: ExportOptions): ExportPlugin;

export interface ImportOptions {
  batchSize?: number;
  onProgress?: (progress: any) => void;
  onComplete?: (result: any) => void;
  onError?: (error: Error) => void;
}
export class ImportPlugin implements PluginInterface {
  name: string;
  constructor(options?: ImportOptions);
  importFile(file: File, options?: any): Promise<any>;
  importJSON(jsonData: any): any;
  createFileInput(options?: any): HTMLInputElement;
  triggerImport(options?: any): void;
}
export function createImportPlugin(options?: ImportOptions): ImportPlugin;

export interface CollaborativeCursorOptions {
  expireTime?: number;
}
export class CollaborativeCursorPlugin implements PluginInterface {
  name: string;
  constructor(options?: CollaborativeCursorOptions);
  setRemoteCursor(userId: string, range: Range, userInfo?: any): void;
  removeRemoteCursor(userId: string): void;
  getActiveCursors(): any[];
}
export function createCollaborativeCursorPlugin(options?: CollaborativeCursorOptions): CollaborativeCursorPlugin;

export interface RealtimeCollaborationOptions {
  serverUrl?: string;
  roomId?: string;
  userId?: string;
  userName?: string;
  userColor?: string;
  autoConnect?: boolean;
}
export class RealtimeCollaborationPlugin implements PluginInterface {
  name: string;
  constructor(options?: RealtimeCollaborationOptions);
  connect(url?: string): void;
  disconnect(): void;
  getConnectionStatus(): any;
  isCellEditLocked(r: number, c: number): boolean;
  isCellLocked(r: number, c: number): boolean;
  getCellLockInfo(r: number, c: number): any;
  lockLocalCell(r: number, c: number): void;
  unlockLocalCell(r: number, c: number): void;
  sendChatMessage(text: string): void;
  broadcastEditing(r: number, c: number, val: any): void;
  getEditingDraft(r: number, c: number): any;
}
export function createRealtimeCollaborationPlugin(options?: RealtimeCollaborationOptions): RealtimeCollaborationPlugin;

// ============================================================
// Vue 组件（'vue-canvas-sheet' 主入口）
// ============================================================

export interface LazyLoadConfig {
  enabled: boolean;
  pageSize?: number;
  maxCachedPages?: number;
  preloadPages?: number;
}

export interface TableDesignerProps {
  loading?: boolean;
  initialData?: object | any[] | null;
  reloadKey?: string | number | boolean | null;
  columns?: any[];
  readOnly?: boolean;
  plugins?: PluginInterface[];
  toolbar?: string[];
  lazyLoad?: LazyLoadConfig;
  enablePersistence?: boolean;
  sheetId?: string;
}

/** 表格设计器组件（默认导出） */
export const TableDesigner: Component<TableDesignerProps>;

/** 图标组件 */
export const SvgIcon: Component;

export default TableDesigner;
