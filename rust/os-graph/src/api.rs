//! JSON-in / JSON-out entry points. These are what the `wasm` feature exports, and they
//! are plain Rust so they are testable natively. Errors come back as `{"error": "..."}`.

use crate::builder::{build_system_graph, BuildOptions, SystemGraph};
use crate::models::{lenient_f64, lenient_vec, CGData};
use crate::orbit::{hub_layout, layout_raw, HubNode, OrbitLayout, OrbitOptions, MAX_RADIUS};
use crate::snapshot::OsSnapshot;
use crate::viz::{build_os_view, code_summary, OsVizInput};
use serde::de::DeserializeOwned;
use serde::Deserialize;

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

/// The part of a `SystemGraph` the layout reads. Everything else (`truncated`, edge
/// `weight` beyond its number, ring `label` / `at` / `link`, core `category` / `degree`) is
/// ignored, and an element that does not fit is dropped, as the TS layout does for
/// missing or non-string fields.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrbitInput {
    #[serde(default, deserialize_with = "lenient_vec")]
    core: Vec<OrbitCoreNode>,
    #[serde(default, deserialize_with = "lenient_vec")]
    edges: Vec<OrbitEdge>,
    #[serde(default, deserialize_with = "lenient_vec")]
    ring: Vec<OrbitRingItem>,
}

#[derive(Deserialize)]
struct OrbitCoreNode {
    id: String,
    /// Missing or non-number: community 0 (the TS `nonNegInt(x, 0)`).
    #[serde(default, deserialize_with = "lenient_f64")]
    community: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrbitEdge {
    source: String,
    target: String,
    /// Missing or non-number: the edge is dropped (the TS `Number.isFinite` check).
    #[serde(default, deserialize_with = "lenient_f64")]
    weight: Option<f64>,
}

#[derive(Deserialize)]
struct OrbitRingItem {
    id: String,
}

fn orbit_inner(system_graph_json: &str, opts_json: &str) -> Result<String, String> {
    let graph: OrbitInput = parse_nullable(system_graph_json, "systemGraph")?
        .ok_or_else(|| "systemGraph: must not be null".to_string())?;
    let opts = parse_nullable::<OrbitOptions>(opts_json, "orbitOptions")?.unwrap_or_default();
    let core: Vec<(&str, Option<f64>)> = graph
        .core
        .iter()
        .map(|n| (n.id.as_str(), n.community))
        .collect();
    let edges: Vec<(&str, &str, f64)> = graph
        .edges
        .iter()
        .map(|e| {
            // NaN stands for "missing": layout_raw treats any non-finite weight as 0.
            let weight = e.weight.unwrap_or(f64::NAN);
            (e.source.as_str(), e.target.as_str(), weight)
        })
        .collect();
    let ring: Vec<&str> = graph.ring.iter().map(|r| r.id.as_str()).collect();
    let layout: OrbitLayout = layout_raw(&core, &edges, &ring, &opts);
    serde_json::to_string(&layout).map_err(|e| e.to_string())
}

/// Build the system graph from a `/kb/os/state` snapshot (or `null`), a canonical graph
/// (or `null`) and build options (or `null`). Returns the `SystemGraph` JSON.
pub fn build_system_graph_json(snapshot_json: &str, project_json: &str, opts_json: &str) -> String {
    build_inner(snapshot_json, project_json, opts_json).unwrap_or_else(|e| error_json(&e))
}

/// Lay out a `SystemGraph` JSON. Returns the `OrbitLayout` JSON, with `core` and `ring`
/// as arrays of `[id, {x, y, z}]`.
///
/// Inputs are read leniently (see [`OrbitInput`]). Coordinates are finite for every input:
/// the radii are clamped to [`crate::orbit::MAX_RADIUS`] and the step count to
/// [`crate::orbit::MAX_ITERATIONS`]. Should a non-finite coordinate ever occur, serde writes
/// it as `null`.
pub fn orbit_layout_json(system_graph_json: &str, opts_json: &str) -> String {
    orbit_inner(system_graph_json, opts_json).unwrap_or_else(|e| error_json(&e))
}

/// Lenient read of a [`crate::viz::VizGraph`]: only the node id and group, and the edge
/// ends and weight, feed the layout. Everything else is ignored.
#[derive(Deserialize)]
struct VizLayoutInput {
    #[serde(default, deserialize_with = "lenient_vec")]
    nodes: Vec<VizLayoutNode>,
    #[serde(default, deserialize_with = "lenient_vec")]
    edges: Vec<VizLayoutEdge>,
}

#[derive(Deserialize)]
struct VizLayoutNode {
    id: String,
    /// The layout community. Missing or non-number: community 0.
    #[serde(default, deserialize_with = "lenient_f64")]
    group: Option<f64>,
    /// `"hub"` marks a cluster centre (see [`crate::orbit::hub_layout`]); anything else is a member.
    #[serde(default)]
    kind: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VizLayoutEdge {
    source: String,
    target: String,
    /// Missing or non-number: the edge is dropped (as in [`OrbitEdge`]).
    #[serde(default, deserialize_with = "lenient_f64")]
    weight: Option<f64>,
}

fn viz_layout_inner(viz_json: &str, opts_json: &str) -> Result<String, String> {
    let graph: VizLayoutInput =
        parse_nullable(viz_json, "viz")?.ok_or_else(|| "viz: must not be null".to_string())?;
    let opts = parse_nullable::<OrbitOptions>(opts_json, "orbitOptions")?.unwrap_or_default();
    let core: Vec<(&str, Option<f64>)> = graph
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), n.group))
        .collect();
    let edges: Vec<(&str, &str, f64)> = graph
        .edges
        .iter()
        .map(|e| {
            (
                e.source.as_str(),
                e.target.as_str(),
                e.weight.unwrap_or(f64::NAN),
            )
        })
        .collect();
    // A graph with hub nodes (the OS, or a part's drill-down) gets the hub layout; any other
    // graph keeps the force-free orbit layout over its communities.
    let hubs: Vec<HubNode> = graph
        .nodes
        .iter()
        .map(|n| HubNode {
            id: n.id.as_str(),
            is_hub: n.kind.as_ref().and_then(serde_json::Value::as_str) == Some("hub"),
            group: n.group,
        })
        .collect();
    let layout: OrbitLayout = if hubs.iter().any(|h| h.is_hub) {
        let core_radius = opts.core_radius.filter(|r| r.is_finite() && *r > 0.0).unwrap_or(100.0);
        hub_layout(&hubs, core_radius.min(MAX_RADIUS))
    } else {
        layout_raw(&core, &edges, &[], &opts)
    };
    serde_json::to_string(&layout).map_err(|e| e.to_string())
}

/// Lay out a [`crate::viz::VizGraph`] (the OS graph or any hub graph) in 3D. Node `group`
/// is the community. Returns the same `OrbitLayout` shape as [`orbit_layout_json`].
pub fn viz_layout_json(viz_json: &str, opts_json: &str) -> String {
    viz_layout_inner(viz_json, opts_json).unwrap_or_else(|e| error_json(&e))
}

fn os_view_inner(input_json: &str) -> Result<String, String> {
    let input = parse_nullable::<OsVizInput>(input_json, "osInput")?.unwrap_or_default();
    serde_json::to_string(&build_os_view(&input)).map_err(|e| e.to_string())
}

/// The OS view from the page's inputs: `{"snapshot", "skills", "routines", "code"}` (each
/// optional; `null` is an empty input). Returns `{"os": VizGraph, "hubs": {key: VizGraph}}`
/// for every hub except `code`, whose detail is the SystemGraph.
pub fn build_os_view_json(input_json: &str) -> String {
    os_view_inner(input_json).unwrap_or_else(|e| error_json(&e))
}

fn code_summary_inner(system_graph_json: &str, top: u32) -> Result<String, String> {
    let graph: SystemGraph = parse_nullable(system_graph_json, "systemGraph")?
        .ok_or_else(|| "systemGraph: must not be null".to_string())?;
    serde_json::to_string(&code_summary(&graph, top as usize)).map_err(|e| e.to_string())
}

/// Summary of a built SystemGraph for the OS view's code part: the totals and the `top`
/// largest communities. Returns the `CodeSummary` JSON.
pub fn code_summary_json(system_graph_json: &str, top: u32) -> String {
    code_summary_inner(system_graph_json, top).unwrap_or_else(|e| error_json(&e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::{MAX_ITERATIONS, MAX_RADIUS};

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

    fn parse_value(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn orbit_reads_odd_community_and_weight_values_like_the_ts() {
        // Missing / non-number community -> 0, negative -> 0, fractional -> floor,
        // weights: missing, null, a string, 0, negative -> edge dropped; > 4 -> 4.
        let raw = r#"{"core":[{"id":"a","community":-3},{"id":"b","community":2.7},
            {"id":"c"},{"id":"d","community":null},{"id":"e","community":"x"},
            {"id":"f","community":1e9}],
            "edges":[{"source":"a","target":"b","weight":9},{"source":"b","target":"c"},
            {"source":"c","target":"d","weight":null},{"source":"d","target":"e","weight":"2"},
            {"source":"e","target":"f","weight":-1},{"source":"f","target":"a","weight":0.5},
            {"target":"a","weight":2}],"ring":[{"id":"r"}]}"#;
        let out = parse_value(&orbit_layout_json(raw, "{}"));
        assert!(out.get("error").is_none(), "{out}");
        assert_eq!(out["core"].as_array().unwrap().len(), 6);
        // Communities after compaction: {0 (a, c, d, e)}, {2 (b)}, {1e9 (f)} -> 3 centers.
        assert_eq!(out["communityCenters"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn orbit_drops_core_and_ring_elements_without_string_ids() {
        let raw = r#"{"core":[{"id":1},{"community":2},{"id":"ok"}],
            "edges":[{"source":"ok"}],"ring":[{"label":"x"},{"id":"r"}]}"#;
        let out = parse_value(&orbit_layout_json(raw, "{}"));
        assert_eq!(out["core"].as_array().unwrap().len(), 1);
        assert_eq!(out["ring"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn orbit_options_accept_non_numbers_as_unset() {
        let raw = r#"{"core":[{"id":"a","community":0}],"edges":[],"ring":[{"id":"r"}]}"#;
        let defaults = orbit_layout_json(raw, "{}");
        let odd = orbit_layout_json(
            raw,
            r#"{"coreRadius":"big","ringRadius":null,"iterations":"lots","seed":[1]}"#,
        );
        assert_eq!(defaults, odd);
    }

    #[test]
    fn huge_iteration_counts_are_clamped_to_the_cap() {
        let graph = build_system_graph_json(
            "null",
            r#"{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],
            "edges":[{"fromId":"a","toId":"b"},{"fromId":"b","toId":"c"}]}"#,
            "null",
        );
        let capped = orbit_layout_json(&graph, &format!(r#"{{"iterations":{}}}"#, MAX_ITERATIONS));
        let huge = orbit_layout_json(&graph, r#"{"iterations":1e300}"#);
        assert_eq!(huge, capped);
        let inf_like = orbit_layout_json(&graph, r#"{"iterations":1e308}"#);
        assert_eq!(inf_like, capped);
    }

    #[test]
    fn huge_radii_are_clamped_so_coordinates_stay_finite() {
        let graph = build_system_graph_json(
            "null",
            r#"{"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"fromId":"a","toId":"b"}]}"#,
            "null",
        );
        let at_cap = orbit_layout_json(
            &graph,
            &format!(r#"{{"coreRadius":{MAX_RADIUS},"ringRadius":{MAX_RADIUS}}}"#),
        );
        let huge = orbit_layout_json(&graph, r#"{"coreRadius":1e308,"ringRadius":1e308}"#);
        assert_eq!(huge, at_cap);
        let v = parse_value(&huge);
        assert!(v["bounds"]["radius"].as_f64().unwrap().is_finite());
        assert!(!huge.contains("null"), "non-finite coordinate in {huge}");
    }

    #[test]
    fn ring_ids_accept_a_string_or_a_number() {
        let snap = r#"{"activity":{"items":[
            {"id":"s-1","kind":"chat","title":"S","createdAt":"t"},
            {"id":4,"kind":"chat","title":"N","createdAt":"t"},
            {"id":1e21,"kind":"chat","title":"Big","createdAt":"t"},
            {"id":2.5,"kind":"chat","title":"Frac","createdAt":"t"}]}}"#;
        let out = parse_value(&build_system_graph_json(snap, "null", "null"));
        let ids: Vec<&str> = out["ring"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            [
                "activity:s-1",
                "activity:4",
                "activity:1e+21",
                "activity:2.5"
            ]
        );
    }

    #[test]
    fn a_boolean_ring_id_is_an_error_not_a_panic() {
        let snap = r#"{"activity":{"items":[{"id":true,"kind":"x","title":"t","createdAt":"t"}]}}"#;
        let out = parse_value(&build_system_graph_json(snap, "null", "null"));
        assert!(out["error"].as_str().unwrap().starts_with("snapshot:"));
    }

    #[test]
    fn metadata_at_ordinary_depth_is_ignored_without_failing() {
        let depth = 100;
        let nested = format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
        let project = format!(
            r#"{{"nodes":[{{"id":"a.ts","metadata":{{"x":{nested},"path":"tests/a.ts"}}}}]}}"#
        );
        let out = parse_value(&build_system_graph_json("null", &project, "null"));
        assert!(out.get("error").is_none(), "{out}");
        assert_eq!(out["core"][0]["category"], "tests");
    }

    #[test]
    fn os_view_json_has_the_os_graph_and_every_hub_but_code() {
        let out = parse_value(&build_os_view_json("null"));
        assert_eq!(out["os"]["level"], "os");
        assert_eq!(out["os"]["nodes"].as_array().unwrap().len(), 10);
        let hubs = out["hubs"].as_object().unwrap();
        assert_eq!(hubs.len(), 9);
        assert!(!hubs.contains_key("code"));
        let bad = parse_value(&build_os_view_json("{not json"));
        assert!(bad["error"].as_str().unwrap().starts_with("osInput:"));
    }

    #[test]
    fn viz_layout_of_the_os_is_the_hub_ring_and_of_other_graphs_the_orbit() {
        let view = parse_value(&build_os_view_json(r#"{"snapshot":{"tokens":{"byModel":[{"provider":"p","model":"m","billable":4}]}}}"#));
        let os = serde_json::to_string(&view["os"]).unwrap();
        let layout = parse_value(&viz_layout_json(&os, "{}"));
        let hub = |key: &str| {
            let p = layout["core"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e[0] == format!("hub:{key}"))
                .unwrap()[1]
                .clone();
            (p["x"].as_f64().unwrap(), p["y"].as_f64().unwrap(), p["z"].as_f64().unwrap())
        };
        let (x, _, z) = hub("models");
        assert!(((x * x + z * z).sqrt() - 100.0).abs() < 1e-6, "hubs sit on the ring of the core radius");
        // A non-hub graph with the same shape keeps the orbit layout (no hub kind, no ring).
        let weird = r#"{"nodes":[{"id":"a","group":0},{"id":"b","group":1}],"edges":[]}"#;
        assert_eq!(parse_value(&viz_layout_json(weird, "{}"))["communityCenters"].as_array().unwrap().len(), 2);
        // A hub-free layout of an OS-shaped graph still works with the core radius option.
        let sized = parse_value(&viz_layout_json(&os, r#"{"coreRadius":50}"#));
        let (sx, _, sz) = {
            let p = sized["core"].as_array().unwrap().iter().find(|e| e[0] == "hub:models").unwrap()[1].clone();
            (p["x"].as_f64().unwrap(), 0.0, p["z"].as_f64().unwrap())
        };
        assert!(((sx * sx + sz * sz).sqrt() - 50.0).abs() < 1e-6);
    }

    #[test]
    fn viz_layout_places_every_node_by_group_and_ignores_bad_edges() {
        let viz = build_os_view_json(
            r#"{"snapshot":{"tokens":{"byModel":[{"provider":"p","model":"m","billable":4}]}}}"#,
        );
        let view = parse_value(&viz);
        let os = serde_json::to_string(&view["os"]).unwrap();
        let layout = parse_value(&viz_layout_json(&os, "{}"));
        assert_eq!(layout["core"].as_array().unwrap().len(), 10 + 1);
        // Hub groups are the hub indices, so ten communities at most.
        assert_eq!(layout["communityCenters"].as_array().unwrap().len(), 10);
        // The same input twice gives the same layout bytes.
        assert_eq!(layout, parse_value(&viz_layout_json(&os, "{}")));
        let weird = r#"{"nodes":[{"id":"a"},{"id":"b","group":"x"},{"label":"no id"}],
            "edges":[{"source":"a","target":"b"},{"source":"a","target":"b","weight":2}]}"#;
        let out = parse_value(&viz_layout_json(weird, "{}"));
        assert_eq!(out["core"].as_array().unwrap().len(), 2);
        assert!(parse_value(&viz_layout_json("null", "{}"))["error"].is_string());
    }

    #[test]
    fn code_summary_json_reads_a_system_graph() {
        let graph = build_system_graph_json(
            "null",
            r#"{"nodes":[{"id":"a.ts","title":"a","kind":"file","metadata":{}}]}"#,
            "null",
        );
        let summary = parse_value(&code_summary_json(&graph, 3));
        assert_eq!(summary["totalNodes"], 1);
        assert_eq!(summary["communities"][0]["topLabels"][0], "a");
        assert!(parse_value(&code_summary_json("null", 3))["error"].is_string());
    }
}
