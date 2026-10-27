//! wasm-bindgen exports (feature `wasm`). Thin wrappers over [`crate::api`].

use std::sync::Once;
use wasm_bindgen::prelude::wasm_bindgen;

static PANIC_HOOK: Once = Once::new();

/// Route Rust panics to the browser console, once, before any work runs.
fn install_panic_hook() {
    PANIC_HOOK.call_once(console_error_panic_hook::set_once);
}

/// Runs when the module is instantiated. It exists so wasm-bindgen emits `__wbindgen_start`,
/// which the generated `__wbg_reset_state` (see web/src/wasm/index.ts) calls after a trap.
#[wasm_bindgen(start)]
pub fn start() {
    install_panic_hook();
}

#[wasm_bindgen]
pub fn build_system_graph_json(snapshot_json: &str, project_json: &str, opts_json: &str) -> String {
    install_panic_hook();
    crate::api::build_system_graph_json(snapshot_json, project_json, opts_json)
}

#[wasm_bindgen]
pub fn orbit_layout_json(system_graph_json: &str, opts_json: &str) -> String {
    install_panic_hook();
    crate::api::orbit_layout_json(system_graph_json, opts_json)
}

#[wasm_bindgen]
pub fn viz_layout_json(viz_json: &str, opts_json: &str) -> String {
    install_panic_hook();
    crate::api::viz_layout_json(viz_json, opts_json)
}

#[wasm_bindgen]
pub fn build_os_view_json(input_json: &str) -> String {
    install_panic_hook();
    crate::api::build_os_view_json(input_json)
}

#[wasm_bindgen]
pub fn code_summary_json(system_graph_json: &str, top: u32) -> String {
    install_panic_hook();
    crate::api::code_summary_json(system_graph_json, top)
}
