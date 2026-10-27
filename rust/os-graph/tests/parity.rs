//! Parity against frozen golden cases. Every `tests/golden/*.json` was recorded from the
//! TypeScript implementation that this crate replaced (since removed); the goldens are now
//! fixtures and this crate is canonical. Here the Rust builder must
//! produce a system graph EXACTLY equal to the golden one, and the Rust orbit layout must
//! match the golden coordinates within 1e-9. A case with `input.rawSystemGraph` skips the
//! builder and runs the raw object through the JSON orbit boundary instead.

use graph_kit_os::api::orbit_layout_json;
use graph_kit_os::{
    build_os_view, build_system_graph, orbit_layout, BuildOptions, CGData, OrbitOptions,
    OsSnapshot, OsVizInput, SystemGraph,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const TOLERANCE: f64 = 1e-9;

fn golden_files() -> Vec<PathBuf> {
    json_files_in(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden"))
}

/// The VizGraph goldens live in `tests/golden/viz/` (the web test reads only the top level of
/// `tests/golden/`, and expects the system-graph shape there).
fn viz_golden_files() -> Vec<PathBuf> {
    json_files_in(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/viz"))
}

fn json_files_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|entry| entry.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

/// Compare an orbit `core` / `ring` array (`[[id, {x,y,z}], ...]`) coordinate by coordinate.
fn compare_points(case: &str, label: &str, got: &Value, want: &Value, max_diff: &mut f64) {
    let got = got
        .as_array()
        .unwrap_or_else(|| panic!("{case}: {label} not an array"));
    let want = want
        .as_array()
        .unwrap_or_else(|| panic!("{case}: golden {label} not an array"));
    assert_eq!(got.len(), want.len(), "{case}: {label} length");
    for (g, w) in got.iter().zip(want) {
        let (gid, gp) = (&g[0], &g[1]);
        let (wid, wp) = (&w[0], &w[1]);
        assert_eq!(gid, wid, "{case}: {label} id order");
        compare_vec(case, &format!("{label} {gid}"), gp, wp, max_diff);
    }
}

fn compare_vec(case: &str, label: &str, got: &Value, want: &Value, max_diff: &mut f64) {
    for axis in ["x", "y", "z"] {
        let g = got[axis]
            .as_f64()
            .unwrap_or_else(|| panic!("{case}: {label}.{axis} missing"));
        let w = want[axis]
            .as_f64()
            .unwrap_or_else(|| panic!("{case}: golden {label}.{axis} missing"));
        let diff = (g - w).abs();
        *max_diff = max_diff.max(diff);
        assert!(
            diff <= TOLERANCE,
            "{case}: {label}.{axis} = {g}, golden {w}, diff {diff:e}"
        );
    }
}

#[test]
fn rust_matches_typescript_golden_cases() {
    let files = golden_files();
    assert!(
        files.len() >= 19,
        "expected the golden cases in tests/golden (they are frozen fixtures; restore them from git), found {}",
        files.len()
    );

    let mut max_coord_diff = 0.0f64;
    for file in &files {
        let case = file.file_name().unwrap().to_string_lossy().into_owned();
        let golden: Value = serde_json::from_str(&fs::read_to_string(file).unwrap())
            .unwrap_or_else(|e| panic!("{case}: invalid JSON: {e}"));
        let input = &golden["input"];

        if !input["rawSystemGraph"].is_null() {
            // Odd, hand-written orbit input: through the lenient JSON boundary.
            let orbit_opts_json = input["orbitOptions"].to_string();
            let out = orbit_layout_json(&input["rawSystemGraph"].to_string(), &orbit_opts_json);
            let got_orbit: Value = serde_json::from_str(&out)
                .unwrap_or_else(|e| panic!("{case}: orbit output not JSON: {e}"));
            check_orbit(&case, &got_orbit, &golden["orbit"], &mut max_coord_diff);
            eprintln!("parity {case}: raw orbit ok");
            continue;
        }

        let snapshot: Option<OsSnapshot> = serde_json::from_value(input["snapshot"].clone())
            .unwrap_or_else(|e| panic!("{case}: snapshot: {e}"));
        let project: Option<CGData> = serde_json::from_value(input["project"].clone())
            .unwrap_or_else(|e| panic!("{case}: project: {e}"));
        let build_opts: BuildOptions = serde_json::from_value(input["buildOptions"].clone())
            .unwrap_or_else(|e| panic!("{case}: buildOptions: {e}"));
        let orbit_opts: OrbitOptions = serde_json::from_value(input["orbitOptions"].clone())
            .unwrap_or_else(|e| panic!("{case}: orbitOptions: {e}"));

        let graph = build_system_graph(snapshot.as_ref(), project.as_ref(), &build_opts);
        let got_graph = serde_json::to_value(&graph).unwrap();
        assert_eq!(
            got_graph, golden["systemGraph"],
            "{case}: system graph differs from TS"
        );

        let layout = orbit_layout(&graph, &orbit_opts);
        let got_orbit = serde_json::to_value(&layout).unwrap();
        check_orbit(&case, &got_orbit, &golden["orbit"], &mut max_coord_diff);

        eprintln!(
            "parity {case}: core={} edges={} ring={} ok",
            graph.core.len(),
            graph.edges.len(),
            graph.ring.len()
        );
    }
    eprintln!("max observed orbit coordinate difference vs TS: {max_coord_diff:e}");
}

fn check_orbit(case: &str, got_orbit: &Value, want_orbit: &Value, max_coord_diff: &mut f64) {
    compare_points(
        case,
        "core",
        &got_orbit["core"],
        &want_orbit["core"],
        max_coord_diff,
    );
    compare_points(
        case,
        "ring",
        &got_orbit["ring"],
        &want_orbit["ring"],
        max_coord_diff,
    );
    let got_centers = got_orbit["communityCenters"].as_array().unwrap();
    let want_centers = want_orbit["communityCenters"].as_array().unwrap();
    assert_eq!(
        got_centers.len(),
        want_centers.len(),
        "{case}: communityCenters length"
    );
    for (i, (g, w)) in got_centers.iter().zip(want_centers).enumerate() {
        compare_vec(
            case,
            &format!("communityCenters[{i}]"),
            g,
            w,
            max_coord_diff,
        );
    }
    let (gr, wr) = (
        got_orbit["bounds"]["radius"].as_f64().unwrap(),
        want_orbit["bounds"]["radius"].as_f64().unwrap(),
    );
    *max_coord_diff = max_coord_diff.max((gr - wr).abs());
    assert!(
        (gr - wr).abs() <= TOLERANCE,
        "{case}: bounds.radius {gr} vs golden {wr}"
    );
}

/// Floats within 1e-9 (the `ln` of the size scale can differ in the last ulp across libms);
/// everything else exact.
fn json_close(got: &Value, want: &Value, path: &str) {
    match (got, want) {
        (Value::Number(g), Value::Number(w)) => {
            let (g, w) = (g.as_f64().unwrap(), w.as_f64().unwrap());
            assert!((g - w).abs() <= TOLERANCE, "{path}: {g} vs golden {w}");
        }
        (Value::Array(g), Value::Array(w)) => {
            assert_eq!(g.len(), w.len(), "{path}: length");
            for (i, (a, b)) in g.iter().zip(w).enumerate() {
                json_close(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(g), Value::Object(w)) => {
            let keys: Vec<&String> = g.keys().collect();
            let want_keys: Vec<&String> = w.keys().collect();
            assert_eq!(keys, want_keys, "{path}: keys");
            for (k, v) in g {
                json_close(v, &w[k], &format!("{path}.{k}"));
            }
        }
        _ => assert_eq!(got, want, "{path}"),
    }
}

/// Runs one `viz_*` golden input through the Rust builder.
fn viz_output(case: &str, input: &Value) -> Value {
    let input: OsVizInput =
        serde_json::from_value(input.clone()).unwrap_or_else(|e| panic!("{case}: input: {e}"));
    serde_json::to_value(build_os_view(&input)).unwrap()
}

#[test]
fn viz_goldens_match_the_rust_builder() {
    let files = viz_golden_files();
    assert!(
        files.len() >= 4,
        "expected the viz goldens (viz_*.json), found {}",
        files.len()
    );
    for file in &files {
        let case = file.file_name().unwrap().to_string_lossy().into_owned();
        let golden: Value = serde_json::from_str(&fs::read_to_string(file).unwrap())
            .unwrap_or_else(|e| panic!("{case}: invalid JSON: {e}"));
        let got = viz_output(&case, &golden["input"]);
        assert!(
            !golden["expected"].is_null(),
            "{case}: no expected output; run the ignored writer"
        );
        json_close(&got, &golden["expected"], &case);
        eprintln!(
            "viz parity {case}: os nodes={} ok",
            got["os"]["nodes"].as_array().unwrap().len()
        );
    }
}

/// Rewrites `expected` in every `tests/golden/viz/*.json` from the current builder. Run it only when the
/// output is meant to change, then review the diff:
///
/// `rustup run stable cargo test --release --test parity -- --ignored write_viz_goldens`
#[test]
#[ignore]
fn write_viz_goldens() {
    for file in viz_golden_files() {
        let case = file.file_name().unwrap().to_string_lossy().into_owned();
        let mut golden: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        let expected = viz_output(&case, &golden["input"]);
        golden["expected"] = expected;
        let mut text = serde_json::to_string_pretty(&golden).unwrap();
        text.push('\n');
        fs::write(&file, text).unwrap();
        eprintln!("wrote {}", file.display());
    }
}

/// The system graph a golden's `input` builds, as the parity test builds it.
fn system_graph_of(case: &str, input: &Value) -> SystemGraph {
    let snapshot: Option<OsSnapshot> = serde_json::from_value(input["snapshot"].clone())
        .unwrap_or_else(|e| panic!("{case}: snapshot: {e}"));
    let project: Option<CGData> = serde_json::from_value(input["project"].clone())
        .unwrap_or_else(|e| panic!("{case}: project: {e}"));
    let build_opts: BuildOptions = serde_json::from_value(input["buildOptions"].clone())
        .unwrap_or_else(|e| panic!("{case}: buildOptions: {e}"));
    build_system_graph(snapshot.as_ref(), project.as_ref(), &build_opts)
}

/// Re-indents a `serde_json` pretty block (two spaces per level) for a value that sits at
/// top-level key depth in the goldens (one space per level, the key itself at depth 1).
fn golden_block(pretty: &str) -> String {
    pretty
        .lines()
        .enumerate()
        .map(|(i, line)| {
            if i == 0 {
                return line.to_owned();
            }
            let spaces = line.len() - line.trim_start().len();
            format!("{}{}", " ".repeat(spaces / 2 + 1), line.trim_start())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Rewrites only the `systemGraph` value of every top-level golden in `tests/golden/*.json`, from
/// the golden's own `input` through the current builder. Every other byte of the file (inputs,
/// orbit, key order, indentation) is kept. Raw orbit cases (`input.rawSystemGraph`) are skipped.
/// Run it only when the system graph is meant to change, then review the diff:
///
/// `rustup run stable cargo test --release --test parity -- --ignored write_system_goldens`
#[test]
#[ignore]
fn write_system_goldens() {
    for file in golden_files() {
        let case = file.file_name().unwrap().to_string_lossy().into_owned();
        let text = fs::read_to_string(&file).unwrap();
        let golden: Value = serde_json::from_str(&text).unwrap();
        if !golden["input"]["rawSystemGraph"].is_null() {
            eprintln!("skipped {case}: raw orbit case");
            continue;
        }
        let key = "\n \"systemGraph\": ";
        let start = text
            .find(key)
            .unwrap_or_else(|| panic!("{case}: no top-level systemGraph key"))
            + key.len();
        let end = text[start..]
            .find("\n \"orbit\": ")
            .map(|i| start + i)
            .unwrap_or_else(|| panic!("{case}: systemGraph must be followed by orbit"));
        assert!(
            text[start..end].trim_end().ends_with(','),
            "{case}: unexpected layout around systemGraph"
        );
        // The typed graph, not a Value: a Value's keys are sorted, which would reorder every object.
        let graph = system_graph_of(&case, &golden["input"]);
        let block = golden_block(&serde_json::to_string_pretty(&graph).unwrap());
        let out = format!("{}{},{}", &text[..start], block, &text[end..]);
        // The rewritten file must still parse, and its systemGraph must be what the builder gave.
        let check: Value = serde_json::from_str(&out).unwrap_or_else(|e| panic!("{case}: {e}"));
        assert_eq!(
            check["systemGraph"],
            serde_json::to_value(&graph).unwrap(),
            "{case}"
        );
        fs::write(&file, out).unwrap();
        eprintln!("wrote systemGraph of {}", file.display());
    }
}
