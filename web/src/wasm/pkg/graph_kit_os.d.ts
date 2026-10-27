/* tslint:disable */
/* eslint-disable */

export function __wbg_reset_state(): void;

export function build_os_view_json(input_json: string): string;

export function build_system_graph_json(snapshot_json: string, project_json: string, opts_json: string): string;

export function code_summary_json(system_graph_json: string, top: number): string;

export function orbit_layout_json(system_graph_json: string, opts_json: string): string;

/**
 * Runs when the module is instantiated. It exists so wasm-bindgen emits `__wbindgen_start`,
 * which the generated `__wbg_reset_state` (see web/src/wasm/index.ts) calls after a trap.
 */
export function start(): void;

export function viz_layout_json(viz_json: string, opts_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly build_os_view_json: (a: number, b: number, c: number) => void;
    readonly build_system_graph_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly code_summary_json: (a: number, b: number, c: number, d: number) => void;
    readonly orbit_layout_json: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly start: () => void;
    readonly viz_layout_json: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
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
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
