//! wasm-bindgen exports (feature `wasm`). Thin wrappers over [`crate::api`].

use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
pub fn build_system_graph_json(snapshot_json: &str, project_json: &str, opts_json: &str) -> String {
    crate::api::build_system_graph_json(snapshot_json, project_json, opts_json)
}

#[wasm_bindgen]
pub fn orbit_layout_json(system_graph_json: &str, opts_json: &str) -> String {
    crate::api::orbit_layout_json(system_graph_json, opts_json)
}
