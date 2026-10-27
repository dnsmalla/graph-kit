//! JSON-in / JSON-out entry points. These are what the `wasm` feature exports, and they
//! are plain Rust so they are testable natively. Errors come back as `{"error": "..."}`.

use crate::builder::{build_system_graph, BuildOptions, SystemGraph};
use crate::models::CGData;
use crate::orbit::{orbit_layout, OrbitOptions};
use crate::snapshot::OsSnapshot;
use serde::de::DeserializeOwned;

fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

/// `null` -> `None`; otherwise the value must deserialize as `T`.
fn parse_nullable<T: DeserializeOwned>(text: &str, what: &str) -> Result<Option<T>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("{what}: {e}"))?;
    if value.is_null() {
        return Ok(None);
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(|e| format!("{what}: {e}"))
}

fn build_inner(snapshot_json: &str, project_json: &str, opts_json: &str) -> Result<String, String> {
    let snapshot = parse_nullable::<OsSnapshot>(snapshot_json, "snapshot")?;
    let project = parse_nullable::<CGData>(project_json, "project")?;
    let opts = parse_nullable::<BuildOptions>(opts_json, "buildOptions")?.unwrap_or_default();
    let graph = build_system_graph(snapshot.as_ref(), project.as_ref(), &opts);
    serde_json::to_string(&graph).map_err(|e| e.to_string())
}

fn orbit_inner(system_graph_json: &str, opts_json: &str) -> Result<String, String> {
    let graph: SystemGraph = parse_nullable(system_graph_json, "systemGraph")?
        .ok_or_else(|| "systemGraph: must not be null".to_string())?;
    let opts = parse_nullable::<OrbitOptions>(opts_json, "orbitOptions")?.unwrap_or_default();
    serde_json::to_string(&orbit_layout(&graph, &opts)).map_err(|e| e.to_string())
}

/// Build the system graph from a `/kb/os/state` snapshot (or `null`), a canonical graph
/// (or `null`) and build options (or `null`). Returns the `SystemGraph` JSON.
pub fn build_system_graph_json(snapshot_json: &str, project_json: &str, opts_json: &str) -> String {
    build_inner(snapshot_json, project_json, opts_json).unwrap_or_else(|e| error_json(&e))
}

/// Lay out a `SystemGraph` JSON. Returns the `OrbitLayout` JSON, with `core` and `ring`
/// as arrays of `[id, {x, y, z}]`.
pub fn orbit_layout_json(system_graph_json: &str, opts_json: &str) -> String {
    orbit_inner(system_graph_json, opts_json).unwrap_or_else(|e| error_json(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_inputs_build_an_empty_graph() {
        let out = build_system_graph_json("null", "null", "null");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["core"], serde_json::json!([]));
        assert_eq!(v["truncated"]["totalNodes"], 0);
    }

    #[test]
    fn malformed_input_returns_an_error_object() {
        let out = build_system_graph_json("{not json", "null", "null");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v["error"].as_str().unwrap().starts_with("snapshot:"));
        let out = orbit_layout_json("null", "null");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v["error"].as_str().unwrap().contains("must not be null"));
    }

    #[test]
    fn build_then_orbit_round_trips_through_json() {
        let project = r#"{"nodes":[{"id":"a.ts","title":"a.ts","kind":"file","metadata":{}},
            {"id":"b.ts","title":"b.ts","kind":"file","metadata":{}}],
            "edges":[{"fromId":"a.ts","toId":"b.ts","kind":"imports","confidence":"EXTRACTED"}]}"#;
        let graph = build_system_graph_json("null", project, r#"{"maxRingItems":0}"#);
        let layout = orbit_layout_json(&graph, "{}");
        let v: serde_json::Value = serde_json::from_str(&layout).unwrap();
        assert_eq!(v["core"].as_array().unwrap().len(), 2);
        assert_eq!(v["core"][0][0], "a.ts");
    }
}
