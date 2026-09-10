export interface OffscreenRendererOptions {
  canvas: HTMLCanvasElement;
  theme: Record<string, unknown>;
  enableWorker?: boolean;
  timeout?: number;
  onFallback?: (error: Error, details?: unknown) => void;
}

export interface RenderStats {
  totalRenders: number;
  workerRenders: number;
  mainThreadRenders: number;
  totalRenderTime: number;
  workerRenderTime: number;
  mainThreadRenderTime: number;
  fallbackCount: number;
  avgRenderTime: number;
  avgWorkerRenderTime: number;
  avgMainThreadRenderTime: number;
  workerRenderRatio: number;
}

export class OffscreenRenderer {
  constructor(options: OffscreenRendererOptions);
  attachCanvas(canvas: HTMLCanvasElement): void;
  initSize(width: number, height: number): Promise<boolean>;
  resize(width: number, height: number): Promise<boolean>;
  render(renderPayload: unknown): Promise<unknown>;
  measureTextBatch(items: unknown[]): Promise<unknown>;
  getStats(): RenderStats;
  resetStats(): void;
  isUsingWorker(): boolean;
  forceFallback(): void;
  destroy(): void;
}

export function createOffscreenRenderer(options: OffscreenRendererOptions): OffscreenRenderer;
export function isOffscreenCanvasSupported(): boolean;

export const Priority: {
  readonly CRITICAL: 0;
  readonly HIGH: 1;
  readonly NORMAL: 2;
  readonly LOW: 3;
};

export const TaskState: {
  readonly PENDING: 'pending';
  readonly RUNNING: 'running';
  readonly PAUSED: 'paused';
  readonly COMPLETED: 'completed';
  readonly CANCELLED: 'cancelled';
};

export interface ProgressiveTask {
  id: string;
  priority: number;
  execute: (timeRemaining: number) => { done: boolean; progress: number };
  onComplete?: () => void;
  onCancel?: () => void;
  estimatedTime?: number;
}

export interface ProgressiveRenderer {
  addTask(task: ProgressiveTask): unknown;
  addTasks(tasks: ProgressiveTask[]): void;
  cancelTask(taskId: string): void;
  cancelAllTasks(minPriority?: number): void;
  clearAll(): void;
  pause(): void;
  resume(): void;
  start(): void;
  stop(): void;
  getStats(): unknown;
  destroy(): void;
}

export function createProgressiveRenderer(options?: Record<string, unknown>): ProgressiveRenderer;

export class LRUCache<K = unknown, V = unknown> {
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
export function measureTextWidth(
  context: CanvasRenderingContext2D,
  text: string,
  font: string,
  options?: Record<string, unknown>
): number;
export function canCacheTextBitmap(text: string, style: Record<string, unknown>): boolean;
export function getTextBitmapSize(
  textWidth: number,
  font: string,
  options?: Record<string, unknown>
): { width: number; height: number };
export function getSingleLineTextLayout(options: Record<string, unknown>): unknown;
export function getLineStartX(anchorX: number, align: string, width: number): number;
export function getBitmapDrawPosition(options: Record<string, unknown>): unknown;
export function getSingleLineDecoration(options: Record<string, unknown>): unknown;
export function wrapTextByWidth(
  text: string,
  availableWidth: number,
  font: string,
  measureText: Function,
  cache?: LRUCache,
  options?: Record<string, unknown>
): string[];
export function getWrappedTextLayout(options: Record<string, unknown>): unknown;
