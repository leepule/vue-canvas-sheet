import type { DefineComponent } from 'vue';
import type {
  PluginInterface,
  PluginRegistry,
  Range,
  Workbook
} from './core';

export { Workbook } from './core';
export type {
  Cell,
  CellRef,
  CellStyle,
  PersistenceStorage,
  PluginInterface,
  Range,
  Unsubscribe,
  WorkbookOptions
} from './core';

export interface AutoSaveOptions {
  backend?: 'indexedDB' | 'localStorage';
  interval?: number;
  key?: string;
  sheetId?: string;
  eventDriven?: boolean;
  debounce?: number;
  events?: string[];
  allowLocalStorageFallback?: boolean;
  storageOptions?: unknown;
}

export class AutoSavePlugin implements PluginInterface {
  name: string;
  constructor(options?: AutoSaveOptions);
  saveNow(workbook?: Workbook): Promise<unknown>;
  getStats(): unknown;
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

export function createSelectionHistoryPlugin(
  options?: SelectionHistoryOptions
): SelectionHistoryPlugin;

export interface ExportOptions {
  defaultFileName?: string;
  useWorker?: boolean;
  onProgress?: (progress: unknown) => void;
  onComplete?: (exportedFile: unknown) => void;
  onError?: (error: Error) => void;
}

export interface ExportCSVOptions {
  fileName?: string;
  delimiter?: string;
  lineEnding?: string;
  bom?: boolean;
  /** 仅对可信数据保留公式前缀；默认 false。 */
  allowFormulas?: boolean;
}

export class ExportPlugin implements PluginInterface {
  name: string;
  constructor(options?: ExportOptions);
  exportExcel(options?: unknown): Promise<unknown>;
  exportJSON(options?: unknown): unknown;
  exportCSV(options?: ExportCSVOptions): unknown;
}

export function createExportPlugin(options?: ExportOptions): ExportPlugin;

export interface ImportOptions {
  batchSize?: number;
  onProgress?: (progress: unknown) => void;
  onComplete?: (importedCells: unknown) => void;
  onError?: (error: Error) => void;
}

export class ImportPlugin implements PluginInterface {
  name: string;
  constructor(options?: ImportOptions);
  importFile(file: File, options?: unknown): Promise<unknown>;
  importJSON(jsonData: unknown): unknown;
  createFileInput(options?: unknown): HTMLInputElement;
  triggerImport(options?: unknown): void;
}

export function createImportPlugin(options?: ImportOptions): ImportPlugin;

export interface CollaborativeCursorOptions {
  expireTime?: number;
}

export class CollaborativeCursorPlugin implements PluginInterface {
  name: string;
  constructor(options?: CollaborativeCursorOptions);
  setRemoteCursor(userId: string, range: Range, userInfo?: unknown): void;
  removeRemoteCursor(userId: string): void;
  getActiveCursors(): unknown[];
}

export function createCollaborativeCursorPlugin(
  options?: CollaborativeCursorOptions
): CollaborativeCursorPlugin;

export interface RealtimeCollaborationOptions {
  serverUrl?: string;
  roomId?: string;
  userId?: string;
  userName?: string;
  userColor?: string;
  autoConnect?: boolean;
  debug?: boolean;
  verbose?: boolean;
}

export class RealtimeCollaborationPlugin implements PluginInterface {
  name: string;
  constructor(options?: RealtimeCollaborationOptions);
  connect(url?: string): void;
  disconnect(): void;
  getConnectionStatus(): unknown;
  isCellEditLocked(r: number, c: number): boolean;
  isCellLocked(r: number, c: number): boolean;
  getCellLockInfo(r: number, c: number): unknown;
  lockLocalCell(r: number, c: number): void;
  unlockLocalCell(r: number, c: number): void;
  sendChatMessage(text: string): void;
  broadcastEditing(r: number, c: number, value: unknown): void;
  getEditingDraft(r: number, c: number): unknown;
}

export function createRealtimeCollaborationPlugin(
  options?: RealtimeCollaborationOptions
): RealtimeCollaborationPlugin;

export interface LazyLoadConfig {
  enabled: boolean;
  pageSize?: number;
  maxCachedPages?: number;
  preloadPages?: number;
}

export interface TableDesignerProps {
  loading?: boolean;
  initialData?: object | unknown[] | null;
  reloadKey?: string | number | boolean | null;
  columns?: unknown[];
  readOnly?: boolean;
  plugins?: PluginInterface[];
  toolbar?: string[];
  lazyLoad?: LazyLoadConfig;
  enablePersistence?: boolean;
  enableWasm?: boolean | 'auto';
  debug?: boolean;
  verbose?: boolean;
  sheetId?: string;
}

export const TableDesigner: DefineComponent<TableDesignerProps>;
export const SvgIcon: DefineComponent<{ name: string }>;
export default TableDesigner;
