# graph-layout

The shared 2D graph layout kernel: the same algorithm and contract as
`Sources/GraphCore/Layout/GraphLayoutEngine.swift`, in Rust, with no dependencies.

- **Contract (identical to Swift):** edges are *weighted* (`EdgeWeight` table x confidence
  multiplier), never degree-capped or pruned; the only filter is Swift's 0.30 weight floor.
  Parallel edges collapse to one link; self-loops and out-of-range endpoints are skipped.
  PageRank -> Louvain -> radii/masses -> cluster anchors -> phyllotaxis seeds -> Barnes-Hut
  force loop with collision passes. No RNG anywhere: seeds come from the golden angle, so
  the output is a pure function of the input.
- **Swift stays the source of truth** for the algorithm. If you change
  `GraphCore/Layout`, update this crate and run `scripts/layout-conformance.sh`.
- Origin: promoted from the T0 spike (`spikes/layout-t0.md`).

## Build

Use the toolchain's own cargo if the `cargo` shim on PATH is broken
(`export PATH=$(ls -d ~/.rustup/toolchains/*/bin | head -1):$PATH`).

```bash
cd rust && cargo test --release -p graph-layout       # kernel contract tests
scripts/build-layout-wasm.sh                          # -> rust/target/layout-wasm/graph_layout.wasm
```

Missing wasm target: `rustup target add wasm32-unknown-unknown` (needs network once).
`cargo check -p graph-layout --target wasm32-unknown-unknown` is the fast check.

## ABI (native and wasm32 are the same functions)

No wasm-bindgen (zero dependency surface; the module has no imports, instantiate with `{}`).

| export | meaning |
|---|---|
| `gl_alloc(len) -> ptr` | reserve `len` bytes in module memory for the input |
| `gl_layout(ptr, len) -> i32` | run; `0` ok, `1` malformed input (truncated, unknown edge kind) |
| `gl_out_ptr() / gl_out_len()` | the result buffer; valid until the next `gl_layout` |
| `gl_free(ptr, len)` | free an input buffer from `gl_alloc` |
| `memory` | linear memory; re-read `memory.buffer` after every call (it can grow) |

Input (little endian): `u32 n | u32 m | u8 kindCount | kindCount x (u8 len, utf8 name) |
m x (u32 from, u32 to, u8 kindIndex, u8 confidence 0=EXTRACTED 1=INFERRED 2=AMBIGUOUS)`.
Nodes are indices `0..n` (map your ids first-occurrence-wins, as the Swift engine does);
kind names are the `CGEdgeKind` raw values.

Output: `u32 n | u32 linkCount | u32 communityCount | n x (f64 x, f64 y, f64 radius,
u32 community, u32 degree, u32 inDegree) | linkCount x f64 weight`.

A panic (a bug, not an input error) aborts: on wasm it traps, so discard the instance.

## Consumers

**Tauri webview (WASM).** Ship `graph_layout.wasm` (about 106 KB, 40 KB gzip) as a static
asset, fetch it, and call it from a Worker so the ~1 s layout at 8k nodes does not block the UI:

```js
const { instance } = await WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), {});
const x = instance.exports;
const ptr = x.gl_alloc(input.length);
new Uint8Array(x.memory.buffer, ptr, input.length).set(input);
const rc = x.gl_layout(ptr, input.length);
x.gl_free(ptr, input.length);
if (rc !== 0) throw new Error('bad layout input');
const out = new Uint8Array(x.memory.buffer, x.gl_out_ptr(), x.gl_out_len()).slice();
```

`tools/run-wasm.mjs` is a complete, tested driver (it is what the conformance script runs).
Do not treat webview speed as measured: ForceAtlas2 ran 4-7x slower in WKWebView than in
Node (`spikes/layout-t0.md`); this kernel was only timed in Node/V8.

**Node sidecar.** Same code, in a `worker_threads` Worker.

**Mac app.** Stays on Swift `GraphLayoutEngine` (the single entry point; Swift is as fast
as it needs to be at 1.1 s for 8.1k nodes). If it ever moves to the kernel, link the native
`cdylib` (`libgraph_layout.dylib`, same `gl_*` symbols, `extern "C"`) and call it through a
C module; native output is bit-identical to Swift, so no visible change. Not wired today.

## Benchmark

`scripts/layout-bench.sh` (median of 5, ms, one Apple Silicon Mac, 2026-10-31, machine not
otherwise idle-verified). Swift includes its id-dictionary packaging, Rust is the bare kernel
(so true kernel-vs-kernel ratios are somewhat higher); wasm is Node 22/V8, not a webview.

| graph | nodes | Swift | Rust native | Rust wasm32 | native/Swift | wasm/Swift |
|---|---|---|---|---|---|---|
| code-1k | 1,008 | 170 | 94 | 125 | 0.55 | 0.74 |
| fragmented-900 | 3,600 | 704 | 444 | 656 | 0.63 | 0.93 |
| code-large | 8,100 | 1,121 | 784 | 934 | 0.70 | 0.83 |
| code-30k | 29,575 | 4,628 | 3,384 | 3,944 | 0.73 | 0.85 |
| code-45k | 44,800 | 7,681 | 5,517 | 6,236 | 0.72 | 0.81 |

## Conformance and tolerances

`scripts/layout-conformance.sh [--large]` lays out the schema fixtures plus synthetic graphs
from 3 to 44.8k nodes through Swift, Rust native and Rust wasm32 (Node) and runs
`graph-layout-lab --verify-conformance`:

| check | tolerance | why |
|---|---|---|
| community ids, count, degree, in-degree | exact | discrete outputs; any drift is a real bug |
| link count, link weights | exact count, 1e-12 | same table, same arithmetic |
| radius | 1e-9 | pure function of PageRank |
| position, per node | 0.01 layout units | native is bit-identical to Swift; wasm32 differs by libm `sin/cos/pow` (Rust's own vs macOS's), 8e-4 at 44.8k nodes. 0.01 is >10x the worst observed and far below one pixel |
| LayoutQuality metrics (ring, edgeCV, Q, separation, components, largest, ...) | 1e-6 relative | computed by Swift on both position sets, so a metric regression is caught even if positions were allowed to move |
| overlap ratio, crossing rate | max(1e-6, 3/n) absolute | threshold counts: a sub-pixel shift can flip one touching pair |

Positions are not required to be bit-identical in general (wasm is not), but the force
simulation is deterministic and chaotic only at the last bits, so the tolerance holds at every
measured size. Not yet covered: 3D layout (`CGSimulation3D`), graphs with duplicate node ids
beyond what Swift's first-wins mapping gives, real (non-synthetic) project graphs beyond the
three small schema fixtures.

## CI notes

No secrets, no network beyond the rust target install. A job needs: rust stable with
`wasm32-unknown-unknown`, node >= 18, and for the Swift half a macOS runner with Swift 5.9+.
- Linux/any: `cd rust && cargo test --release -p graph-layout` and `scripts/build-layout-wasm.sh`.
- macOS: `scripts/layout-conformance.sh` (add `--large` nightly; Swift alone needs ~10 s at 45k).
- `scripts/layout-bench.sh` is informational, never a gate (timings are machine-dependent).
- Pin the rustc version if you commit the .wasm anywhere; wasm bytes are only reproducible
  with the same compiler. Nothing here commits the .wasm today.
- Known local noise: `rust-objcopy` may print a `libLLVM.dylib` SIGABRT warning on release
  builds with `strip = true`; the build still succeeds (toolchain packaging issue).
