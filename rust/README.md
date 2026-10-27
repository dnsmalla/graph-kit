# rust/ — graph-kit OS graph core in Rust

`graph-kit-os` (crate `os-graph/`, lib `graph_kit_os`) is the Rust port of the "OS view"
graph core from `typescript/src/system/`:

- `builder.rs` — `build_system_graph`: node categorization, label-propagation communities,
  node cap (greedy whole-community fill, partial trim), collapsed edges, activity ring.
- `orbit.rs` — `orbit_layout`: deterministic 3D orbit layout (mulberry32, golden-spiral
  community centers, relaxation with volume term).
- `models.rs`, `snapshot.rs` — the canonical graph model (camelCase JSON) and the slice of
  `OsSnapshot` the builder reads.
- `api.rs` — JSON-in / JSON-out entry points; `wasm.rs` (feature `wasm`) exports them via
  wasm-bindgen.

## Status

This crate is now the **canonical implementation** of the OS graph core. The TypeScript
copy in `typescript/src/system/` is the **parity oracle** until the WASM build is wired
into `web/`. That needs `rustup target add wasm32-unknown-unknown` and `wasm-bindgen-cli`,
which are not installed on this machine yet. Until then, the TS copy is still what runs.

Parity is checked by `os-graph/tests/parity.rs` against golden files in
`os-graph/tests/golden/`. The golden files are written by
`typescript/scripts/gen-os-golden.mjs` from the built TS. The system graph must equal the
TS output exactly. Orbit coordinates must match within 1e-9; the remaining difference is
the last ulp of `sin`/`cos`/`cbrt` between V8 and Rust's libm.

## Commands

```sh
cd rust
cargo test                 # unit tests + golden parity
cargo test --release       # same, with the perf smoke tests timed against a 2 s budget
cargo check --features wasm
cargo clippy -- -D warnings

# Regenerate the golden files from the TS oracle (after `npx tsc -p tsconfig.json` in typescript/)
node typescript/scripts/gen-os-golden.mjs   # run from the graph-kit repo root
```

Dependencies: `serde` and `serde_json` only. `wasm-bindgen` is optional and enabled only
by the `wasm` feature.
