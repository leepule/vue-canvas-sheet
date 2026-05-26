/**
 * vue-canvas-sheet 类型定义
 */

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
  v?: any;
  f?: string;
  s?: CellStyle;
  m?: string;
}

export interface WorkbookOptions {
  enablePersistence?: boolean;
  sheetId?: string;
}

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
}

export class PluginRegistry {
  constructor(workbook: Workbook);
  register(plugin: PluginInterface, options?: { autoMount?: boolean }): PluginRegistry;
  unregister(name: string): boolean;
  get(name: string): PluginInterface | undefined;
  has(name: string): boolean;
  isMounted(name: string): boolean;
  on(hookType: string, handler: Function): Function;
  trigger(hookType: string, data: any): any;
}

export class Workbook {
  plugins: PluginRegistry;
  constructor(options?: WorkbookOptions);
  getSystemReport(): any;

  // 数据操作
  setData(data: any[] | Record<string, Cell>): void;
  setColumns(columns: any[]): void;
  getCell(r: number, c: number): Cell | null;
  setCell(r: number, c: number, val: any): void;
  getCellValue(r: number, c: number): any;
  clearContent(range: Range): void;

  // 样式与格式
  setStyle(range: Range, style: CellStyle): void;
  setBorder(range: Range, type: string, color: string, style?: string): void;
  setFormat(range: Range, fmt: string): void;

  // 尺寸与视图
  getColWidth(c: number): number;
  setColWidth(c: number, w: number): void;
  getRowHeight(r: number): number;
  setRowHeight(r: number, h: number): void;
  setFreeze(r: number, c: number): void;
  getFrozenSize(): { w: number; h: number };

  // 选区管理
  setSelection(startR: number, startC: number, endR: number, endC: number): void;
  getMerge(r: number, c: number): Range | null;
  addMerge(range: Range): void;
  removeMerge(range: Range): void;

  // 计算引擎
  recalcAll(): void;
  recalcDirty(): void;

  // 历史记录
  undo(): void;
  redo(): void;

  // 导入导出
  toJSON(): string;
  fromJSON(json: string): void;

  // 事件订阅
  on(event: string, callback: Function): Function;
  subscribe(callback: Function): Function;
}
