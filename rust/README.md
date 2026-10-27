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

Dependencies: `serde` and `serde_json` only. `wasm-bindgen` and `console_error_panic_hook`
are optional and enabled only by the `wasm` feature. The crate builds as `cdylib` (for
wasm-bindgen) and `rlib` (for tests and Rust callers). The wasm entry points install the panic
hook once, so a panic shows up in the browser console.

## Where Rust deliberately differs from the TS

The TS is the parity oracle, with two exceptions. Both are Rust-only guards and do not
change any output for inputs the page can produce.

- **Iteration clamp.** `orbitOptions.iterations` is clamped to `MAX_ITERATIONS = 10_000`
  (`orbit.rs`). The TS has no cap, so `iterations: 1e300` would hang the page. The goldens
  stay below 10,000. The TS source is not changed.
- **Radius clamp.** `coreRadius` and `ringRadius` are clamped to `MAX_RADIUS = 1e150`.
  Above that the squared norms overflow and coordinates would be non-finite. Radii the page
  can use are far below this. Non-finite output coordinates would be written as `null`, but
  the clamps keep every coordinate finite for every input.

## JSON boundary (lenient, as the TS is)

Inputs are read the way the TS reads them, never failing on a field it does not read:

- `metadata` may be `null`, a non-object, or hold any values. Only string values count;
  the rest are skipped. A later duplicate key that is not a string hides an earlier string,
  as `JSON.parse` does.
- A missing or non-string `title` leaves the label out of the output (the TS gives
  `undefined`, which `JSON.stringify` drops). Missing `kind`, edge `kind` and `confidence`
  are ignored. An edge with no string `fromId` / `toId` is dropped.
- Nodes without a string `id`, and any element that does not fit its model, are skipped.
- Ring ids: a JSON string is used verbatim; a number is formatted like JS `String(n)`
  (`1e+21`, `1e-7`, `1.5`, ...).
- Orbit input: community is floored when it is a non-negative number, otherwise 0 (as the
  TS `nonNegInt`). An edge weight is clamped to `[0, 4]`; a non-number or non-finite weight
  drops the edge. Option fields that are not numbers count as unset.
- Numeric strings are not coerced the way JS coerces them (`"5"` is unset here, `5` in JS).
  The `seed` option likewise.

Known limits of the JSON boundary:

- serde_json rejects nesting deeper than 128 levels, and rejects an out-of-range literal
  such as `1e400`, which `JSON.parse` accepts (as `Infinity`). `JSON.stringify` writes
  non-finite values as `null`, which is handled as absent, so the page path is unaffected.
- Non-string titles and ids are dropped or treated as absent, where the TS would copy the
  number through.

## Goldens

`tests/golden/` holds 19 cases. Two of them (`raw_orbit_sparse_communities`) go straight
through the orbit JSON boundary with odd hand-written values. The rest run the whole
builder plus layout. Coverage: every category and path key (with precedence), knowledge and
other kinds, test-path separators and case, non-BMP id ordering, NUL-in-id key collisions,
exact-fill and greedy caps, partial trim, ring dedupe with truncation, fractional and
negative limits, weights above 4, custom radii and seed, sparse communities.
