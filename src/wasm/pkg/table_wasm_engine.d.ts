/* tslint:disable */
/* eslint-disable */

export class FormulaEngine {
    free(): void;
    [Symbol.dispose](): void;
    evaluate(formula: string): any;
    evaluate_group(rows: Uint32Array, cols: Uint32Array, formula: string, ids: Array<any>): any;
    get_grid_cols(): number;
    get_grid_rows(): number;
    init_shared_memory(sab: SharedArrayBuffer, rows: number, cols: number): void;
    constructor();
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_formulaengine_free: (a: number, b: number) => void;
    readonly formulaengine_evaluate: (a: number, b: number, c: number) => any;
    readonly formulaengine_evaluate_group: (a: number, b: any, c: any, d: number, e: number, f: any) => any;
    readonly formulaengine_get_grid_cols: (a: number) => number;
    readonly formulaengine_get_grid_rows: (a: number) => number;
    readonly formulaengine_init_shared_memory: (a: number, b: any, c: number, d: number) => void;
    readonly formulaengine_new: () => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
