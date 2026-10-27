//! wasm-bindgen exports (feature `wasm`). Thin wrappers over [`crate::api`].

use std::sync::Once;
use wasm_bindgen::prelude::wasm_bindgen;

static PANIC_HOOK: Once = Once::new();

/// Route Rust panics to the browser console, once, before any work runs.
fn install_panic_hook() {
    PANIC_HOOK.call_once(console_error_panic_hook::set_once);
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
