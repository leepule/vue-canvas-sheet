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
  border?: unknown;
  fmt?: string;
  decimals?: number;
  wrap?: boolean;
}

export interface Cell {
  v?: unknown;
  f?: string;
  s?: CellStyle;
  m?: string;
  dirty?: boolean;
}

export interface WorkbookOptions {
  enablePersistence?: boolean;
  enableWasm?: boolean | 'auto';
  sheetId?: string;
}

export type Unsubscribe = () => void;

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

export interface StoreOptions {
  freezeMode?: 'none' | 'shallow' | 'deep';
  useCompactKey?: boolean;
}

export interface PersistenceStorage {
  init(): Promise<IDBDatabase>;
  close(): void;
  saveDiffs(sheetId: string, diffs: Map<string, Cell | null>): Promise<void>;
  saveMetadata(key: string, value: unknown): Promise<void>;
}

export interface FormulaRangeDependency {
  startR: number;
  startC: number;
  endR: number;
  endC: number;
}

export interface FormulaDependencies {
  cells: Set<string>;
  ranges: FormulaRangeDependency[];
  readonly size: number;
}

export interface FormulaEvaluator {
  recalcDirty(): void;
  triggerRecalc(r: number, c: number): void;
  evaluateFormula(formula: string, r: number, c: number, stack?: string[]): unknown;
  getDependencies(formula: string): FormulaDependencies;
}

export class EventEmitter {
  on(event: string, callback: Function): Unsubscribe;
  off(event: string, callback: Function): void;
  once(event: string, callback: Function): Unsubscribe;
  emit(event: string, payload?: unknown): void;
  emitThrottled(event: string, delay?: number): void;
  emitDedup(event: string, payload?: unknown): void;
  emitBatch(events: Array<{ event: string; payload?: unknown }>): void;
  clear(event?: string): void;
  listenerCount(event: string): number;
}

export const HookTypes: Record<string, string>;

export class PluginRegistry {
  constructor(workbook: Workbook);
  init(): void;
  register(plugin: PluginInterface, options?: { autoMount?: boolean }): PluginRegistry;
  add(plugin: PluginInterface): void;
  unregister(name: string): boolean;
  mountAll(): void;
  get(name: string): PluginInterface | undefined;
  has(name: string): boolean;
  isMounted(name: string): boolean;
  on(hookType: string, handler: Function): Unsubscribe;
  off(hookType: string, handler: Function): void;
  trigger(hookType: string, payload?: unknown): unknown;
  setSharedState(key: string, value: unknown): void;
  getSharedState<T = unknown>(key: string, defaultValue?: T): T;
  deleteSharedState(key: string): boolean;
  getPluginInfo(): PluginInfo[];
  optimizeHooks(): void;
  getPerformanceReport(): unknown;
  destroy(): void;
}

export function createPlugin(
  name: string,
  definition?: Partial<PluginInterface> & Record<string, unknown>
): PluginInterface;

export class Store<S = unknown> {
  constructor(initialState?: S, options?: StoreOptions);
  getState(): S;
  setState(updater: Partial<S> | ((state: S) => Partial<S>)): void;
  beginBatch(): void;
  endBatch(): void;
  subscribe(listener: (state: S) => void): Unsubscribe;
  select<T>(selector: (state: S) => T, listener: (selected: T) => void): Unsubscribe;
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

export class SharedValueStore {
  static readonly EMPTY_VALUE: number;
  static readonly NON_NUMERIC_VALUE: number;
  constructor(maxRows?: number, maxCols?: number);
  set(r: number, c: number, value: unknown): void;
  get(r: number, c: number): number;
  getValue(r: number, c: number): number;
  getBuffer(): SharedArrayBuffer | null;
  clear(): void;
  serialize(): unknown;
  updateFromSerialized(serialized: unknown): void;
  isEmpty(value: number): boolean;
  isNonNumeric(value: number): boolean;
}

export class SelectionManager {
  constructor(dependencies: Record<string, unknown>);
  readonly selection: Range | null;
  readonly activeCell: CellRef;
  setSelection(startR: number, startC: number, endR: number, endC: number): void;
  setSelection(range: Range): void;
  setCopyRange(range: Range): void;
  clearCopyRange(): void;
  destroy(): void;
}

export class Workbook {
  constructor(options?: WorkbookOptions);

  plugins: PluginRegistry;
  history: unknown;
  searchEngine: unknown;
  search: unknown;
  readonly layoutEngine: unknown;
  readonly mergeManager: unknown;
  readonly styleManager: unknown;
  readonly sheetStructure: unknown;
  readonly persistence: unknown;
  readonly formulaEngine: unknown;
  readonly formulaEvaluator: FormulaEvaluator;
  readonly selectionManager: SelectionManager;
  clipboard: unknown;
  errorHandler: unknown;
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
  selection: Range | null;
  activeCell: CellRef;
  copyRange: Range | null;
  freeze: CellRef;
  dataVersion: number;
  fieldMap: Record<string, unknown>;
  headerDepth: number;
  dependencyMap: Map<unknown, unknown>;
  reverseDependencyMap: Map<unknown, unknown>;
  readonly totalWidth: number;
  readonly totalHeight: number;

  getDataMatrix(): unknown;
  getDirtyCells(): Map<string, Cell | null> | null;
  indexToColStr(colIndex: number): string;
  parseKey(key: number | string): CellRef;
  emitEvent(event: string, payload?: unknown): void;
  markLayoutDirty(): void;
  setRenderScheduler(scheduler: Function): void;
  requestRender(): void;

  setData(cells: unknown[] | Record<string, Cell>): void;
  setColumns(columns: unknown[]): void;
  getCell(r: number, c: number): Cell | null;
  getStyle(r: number, c: number): CellStyle;
  setCell(
    r: number,
    c: number,
    value: Partial<Cell> | null,
    oldValue?: Cell | null,
    options?: { skipEvent?: boolean; skipHistory?: boolean }
  ): void;
  bulkSetCells(updates: Array<{ r: number; c: number; val: Partial<Cell> }>): void;
  getCellValue(r: number, c: number, stack?: string[]): unknown;
  iterateRange(range: Range, callback: (r: number, c: number, cell: Cell | null) => void): void;
  collectRange<T>(range: Range, callback: (r: number, c: number, cell: Cell | null) => T): T[];

  setStyle(range: Range, style: CellStyle): void;
  setBorder(range: Range, type: string, color: string, style?: string): void;
  setFormat(range: Range, format: string): void;
  setDecimals(range: Range, delta: number): void;
  clearContent(range: Range): void;
  mergeCells(range: Range): void;
  unmergeCells(range: Range): void;
  addMerge(range: Range): void;
  removeMerge(range: Range): void;
  getMerge(r: number, c: number): Range | null;
  getIntersectingMerges(range: Range): Range[];
  allowsMerge(range: Range): boolean;
  allowsUnmerge(range: Range): boolean;

  insertRow(rowIndex: number): void;
  deleteRow(rowIndex: number): void;
  insertColumn(colIndex: number): void;
  deleteColumn(colIndex: number): void;
  moveColumn(fromColumn: number, toColumn: number): void;
  fillAuto(sourceRange: Range, targetRange: Range): void;
  getColWidth(column: number): number;
  setColWidth(column: number, width: number): void;
  getRowHeight(row: number): number;
  setRowHeight(row: number, height: number): void;
  setFreeze(rows: number, columns: number): void;

  setSelection(startR: number, startC: number, endR: number, endC: number): void;
  setCopyRange(range: Range): void;
  clearCopyRange(): void;
  copy(range: Range): void;
  paste(range: Range): void;
  clearCells(range: Range): void;

  recalcAll(options?: { useWorker?: boolean }): Promise<void> | void;
  rebuildDependencyMap(): void;
  getCalculationStats(): unknown;
  resetCalculationStats(): void;
  undo(): void;
  redo(): void;
  applyCommand(command: unknown, isUndo: boolean): void;

  toJSON(): {
    rowCount: number;
    colCount: number;
    rowHeights: Record<number, number>;
    colWidths: Record<number, number>;
    data: Record<string, Cell>;
    merges: Range[];
    freeze: CellRef;
  };
  fromJSON(serialized: unknown): void;
  find(query: unknown, startFrom?: CellRef): unknown;
  replaceAll(query: unknown, replacement: string): number;

  on(event: string, callback: Function): Unsubscribe;
  off(event: string, callback: Function): void;
  once(event: string, callback: Function): Unsubscribe;
  notify(payload?: unknown): void;
  usePlugin(plugin: PluginInterface, options?: { autoMount?: boolean }): Workbook;
  unusePlugin(name: string): boolean;
  getPlugin(name: string): PluginInterface | undefined;

  enableWorker(options?: { timeout?: number }): Workbook;
  disableWorker(): void;
  isWorkerEnabled(): boolean;
  getWorkerStats(): unknown;
  initWasm(): Promise<void>;

  enablePerformanceMonitoring(options?: { thresholds?: Record<string, number> }): void;
  disablePerformanceMonitoring(): void;
  getPerformanceReport(): unknown;
  getPerformanceMonitor(): unknown;
  exportPerformanceJSON(): string;
  exportPerformanceCSV(): string;
  printPerformanceSummary(): void;
  getSystemReport(): unknown;

  subscribeData(listener: Function): Unsubscribe;
  subscribeSelection(listener: Function): Unsubscribe;
  subscribeUI(listener: Function): Unsubscribe;
  select(storeName: 'data' | 'selection' | 'ui', selector: Function, listener: Function): Unsubscribe;
  beginBatchUpdate(): void;
  endBatchUpdate(): void;
  getStoreManager(): StoreManager;
  getStore(name: string): Store | undefined;

  warmupPool(cellCount?: number): void;
  getPoolStats(): unknown;
  getPoolManager(): unknown;

  enablePersistenceStorage(options?: { sheetId?: string; storageOptions?: unknown }): PersistenceStorage;
  persist(sheetId?: string): Promise<void>;
  loadFromStorage(sheetId?: string): Promise<boolean>;
  savePendingChanges(sheetId?: string): Promise<unknown>;
  flushPersistence(): Promise<void>;

  getRowPos(row: number): number;
  getColPos(column: number): number;
  getRowIndexAt(y: number): number;
  getColIndexAt(x: number): number;
  getFrozenSize(): { w: number; h: number };
  getLayoutVersion(): number;
  getAddress(r: number, c: number): string;

  getErrorHistory(limit?: number): unknown[];
  clearErrorHistory(): void;
  safeExecute<T>(operation: () => T | Promise<T>, defaultValue: T, context?: unknown): Promise<T>;
  close(): Promise<void>;
  destroy(): void;
}
