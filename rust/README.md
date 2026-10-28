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

This crate is the **canonical implementation** of the OS graph core. The TypeScript
implementation it was ported from (`typescript/src/system/builder.ts` and `orbit.ts`) has
been removed from the Node package. Its output is frozen in `os-graph/tests/golden/`.

The page runs the crate as **embedded WASM**: `web/src/wasm/` holds the generated glue and
the module as base64, and `web/src/systemGraph.ts` calls it. The wasm build is reproducible
with the same rustc on the same platform only, so it is committed. CI installs that rustc and runs
`scripts/build-os-wasm.sh --check --strict --glue-only` (the JS glue and types must match a fresh
build; the wasm bytes differ between Linux and macOS hosts and are validated by the parity and web
tests instead). Run the full `--check --strict` locally on the platform that built the bytes.

Parity is checked by `os-graph/tests/parity.rs` against the golden files. The system graph
must equal the golden exactly. Orbit coordinates must match within 1e-9; the remaining
difference is the last ulp of `sin`/`cos`/`cbrt` between the golden's recording engine and
Rust's libm.

## Commands

```sh
cd rust
rustup run stable cargo test --release         # unit tests + golden parity (perf smoke tests timed)
rustup run stable cargo clippy --all-targets -- -D warnings
rustup run stable cargo clippy --all-targets --features wasm -- -D warnings

# WASM: rebuild the files web/ embeds (from the graph-kit root)
scripts/build-os-wasm.sh          # writes web/src/wasm/pkg/ and web/src/wasm/bytes.ts
scripts/build-os-wasm.sh --check  # builds into a temp dir and diffs; skipped if rustc differs
```

Use `rustup run stable cargo` rather than a Homebrew `cargo` on PATH. The wasm build needs
the `wasm32-unknown-unknown` target and the `wasm-bindgen` CLI matching `rust/Cargo.lock`
(0.2.129).

Dependencies: `serde` and `serde_json` only. `wasm-bindgen` and `console_error_panic_hook`
are optional and enabled only by the `wasm` feature. The crate builds as `cdylib` (for
wasm-bindgen) and `rlib` (for tests and Rust callers). The wasm entry points install the panic
hook once, so a panic shows up in the browser console.

The `[profile.release]` is tuned for size (`opt-level = "z"`, LTO, one codegen unit, strip,
`panic = "abort"`), because the wasm ships inside the web bundle. Native results are the same
under it; the goldens and parity test pass unchanged.

## Where Rust deliberately differs from the removed TypeScript

The TypeScript was the parity oracle, with two exceptions. Both are Rust-only guards and do not
change any output for inputs the page can produce.

- **Iteration clamp.** `orbitOptions.iterations` is clamped to `MAX_ITERATIONS = 10_000`
  (`orbit.rs`). The TypeScript had no cap, so `iterations: 1e300` would hang the page. The goldens
  stay below 10,000.
- **Radius clamp.** `coreRadius` and `ringRadius` are clamped to `MAX_RADIUS = 1e150`.
  Above that the squared norms overflow and coordinates would be non-finite. Radii the page
  can use are far below this. Non-finite output coordinates would be written as `null`, but
  the clamps keep every coordinate finite for every input.

## JSON boundary (lenient, as the removed TS was)

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

## VizGraph (the whole OS as one graph)

`os-graph/src/viz.rs` builds the OS view. One generic `VizGraph` type (`nodes`, `edges`,
`level`, `title`) feeds one layout (`viz_layout_json`) and one renderer:

- `build_os_view_json(input)` returns `{os, hubs}`: the top-level graph (one hub per part,
  members capped at 40 per hub, or 24 for Activity, with `meta.more`), and a drill-down graph for
  each hub except `code`. `code` drills into the existing SystemGraph; `code_summary_json`
  summarises it for the OS view.
- Ten hubs, in `HUB_KEYS` order: `code`, `knowledge`, `memory`, `skills`, `models`, `agents`,
  `routines`, `kits`, `activity`, `storage`. The OS ring spaces them evenly; with ten hubs the member
  shells shrink to 0.3 of the chord to the neighbouring hub (`orbit.rs`), so no member reaches
  the next hub's shell. The hub centre is size 6.0.
- The **activity** hub (`hub:activity`, drill key `activity`) is the recent-activity feed
  (`activity.items`, newest first). At the OS level its members are the newest 24 rows
  (`activity:<id>`, kind `activity`, size 1.0 for the newest falling linearly to 0.6). Its
  centre `meta` has `members` (all usable rows), `more`, `unread` (the feed's unread count) and
  `newestAt` (the newest `createdAt`, or `null`). A member's `meta` has `title`, `activityKind`,
  `createdAt` (or `null`), `link` (or `null`) and `detail` (the object, else `null`). The drill
  shows the newest 60, grouped under one `group` node per kind (`group:activity:<kind>`, labelled,
  `meta.count`); items hang off their group and groups off the hub. The eight newest items are
  labelled. An empty feed is the centre alone, status `off`.
- Cross-hub edges are only the ones the data states: kit to feature, Knowledge to Code when a
  code graph exists, Routines to Models when auto-task usage exists, and Code to the
  `code_graph_3d` feature. Model usage is not cross-tabulated by caller in the snapshot, so models
  link to the Models hub only.
- Ids are stable (`hub:models`, `model:<provider>/<model>`, `skill:<id>`, `activity:<id>`, ...),
  all lists are sorted, and the output does not depend on input order.

Goldens for it are in `os-graph/tests/golden/viz/` (a subfolder on purpose: the web test reads
only the top level of `tests/golden/` and expects the system-graph shape there). They are
frozen; to regenerate after an intended change, run
`rustup run stable cargo test --release --test parity -- --ignored write_viz_goldens`, then
review the diff.

## Goldens

`tests/golden/` holds 19 frozen cases. They are fixtures now: the TypeScript generator that
wrote them has been removed. To add a case, write the JSON by hand (input plus the expected
`systemGraph` and `orbit`) or generate it from this crate, then run `cargo test` to check it. One case (`raw_orbit_sparse_communities`) goes straight through the orbit JSON boundary with odd hand-written values. The rest run the whole
builder plus layout. Coverage: every category and path key (with precedence), knowledge and
other kinds, test-path separators and case, non-BMP id ordering, NUL-in-id key collisions,
exact-fill and greedy caps, partial trim, ring dedupe with truncation, fractional and
negative limits, weights above 4, custom radii and seed, sparse communities.
