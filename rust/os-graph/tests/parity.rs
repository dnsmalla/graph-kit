//! Parity against the TypeScript oracle. Every `tests/golden/*.json` was written by
//! `typescript/scripts/gen-os-golden.mjs` from the built TS. Here the Rust builder must
//! produce a system graph EXACTLY equal to the golden one, and the Rust orbit layout must
//! match the golden coordinates within 1e-9.

use graph_kit_os::{
    build_system_graph, orbit_layout, BuildOptions, CGData, OrbitOptions, OsSnapshot,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const TOLERANCE: f64 = 1e-9;

fn golden_files() -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
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
        files.len() >= 6,
        "expected the golden cases in tests/golden (run `node typescript/scripts/gen-os-golden.mjs`), found {}",
        files.len()
    );

    let mut max_coord_diff = 0.0f64;
    for file in &files {
        let case = file.file_name().unwrap().to_string_lossy().into_owned();
        let golden: Value = serde_json::from_str(&fs::read_to_string(file).unwrap())
            .unwrap_or_else(|e| panic!("{case}: invalid JSON: {e}"));
        let input = &golden["input"];

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
        let want_orbit = &golden["orbit"];
        compare_points(
            &case,
            "core",
            &got_orbit["core"],
            &want_orbit["core"],
            &mut max_coord_diff,
        );
        compare_points(
            &case,
            "ring",
            &got_orbit["ring"],
            &want_orbit["ring"],
            &mut max_coord_diff,
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
                &case,
                &format!("communityCenters[{i}]"),
                g,
                w,
                &mut max_coord_diff,
            );
        }
        let (gr, wr) = (
            got_orbit["bounds"]["radius"].as_f64().unwrap(),
            want_orbit["bounds"]["radius"].as_f64().unwrap(),
        );
        max_coord_diff = max_coord_diff.max((gr - wr).abs());
        assert!(
            (gr - wr).abs() <= TOLERANCE,
            "{case}: bounds.radius {gr} vs golden {wr}"
        );

        eprintln!(
            "parity {case}: core={} edges={} ring={} ok",
            graph.core.len(),
            graph.edges.len(),
            graph.ring.len()
        );
    }
    eprintln!("max observed orbit coordinate difference vs TS: {max_coord_diff:e}");
}
