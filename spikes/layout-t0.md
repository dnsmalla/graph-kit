# T0 spike: graph layout in Rust/WASM versus Swift

Status: measured 2026-10-28 on one Mac (Apple Silicon, macOS 25.6). Spike only: nothing here is wired into the Mac app, the server or `rust/`.
Question: can the 2D layout (`mac/LocalPackages/graph-kit/Sources/GraphCore/Layout/`) run as Rust compiled to WASM in a Node worker, inside the budget in `docs/kits/graph-kit.md` §8.3, and what does that imply for Q1?

Code: `spikes/layout-t0/` (`swift/` baseline harness, `rust/` port, `node/` driver).

## 1. What was ported, and what was not

| Stage (`GraphLayoutEngine.layout`) | Swift source | Rust port (`rust/src/lib.rs`) |
|---|---|---|
| EdgeWeight table (37 kinds) and confidence multiplier | `EdgeWeight.swift` | yes (copied table, not generated; see Q7) |
| Topology, parallel-edge collapse, degrees, in-degree | `GraphTopology.swift` | yes |
| PageRank (40 iterations) | `GraphTopology.swift` | yes |
| Louvain with the hierarchical boost | `CommunityDetection.swift` | yes |
| Radii, masses, cluster anchors (spiral packing with grid), phyllotaxis seeds | `GraphLayoutEngine.swift` | yes |
| Barnes-Hut tree, force loop, collision passes | `SpatialTree.swift`, `ForceDirectedLayout.swift` | yes |
| `LayoutQuality` (the lab's metrics) | `LayoutQuality.swift` | **no**. The metrics run in Swift on the Rust output (`T0Bench metrics`). |
| `CGSimulation3D` (Float 3D sim) | `CGSimulation3D.swift` | no (Q4) |
| `signals(of:)`, `applying(_:to:)`, dictionary packaging by node id | `GraphLayoutEngine.swift` | no. The timings below exclude id packaging on the Rust side. |

So the measured Rust kernel is the whole force layout pipeline, not only the force step. The Swift baseline is `GraphLayoutEngine.layout` with `measureQuality = false`, which includes its id-keyed packaging. That asymmetry is the main caveat of the timing comparison (section 5).

## 2. Inputs and baseline

- Synthetic graphs: the lab's own generator, copied verbatim (`cmp`-identical to `Sources/GraphLayoutLab/SyntheticGraph.swift`). `code-large-8100` is the lab's `code/large` case (8,100 nodes). `code-1k`, `code-3k` and `code-45k` are the same generator with other sizes; `code-45k` is 44,800 nodes, not exactly 50,000.
- Real-shaped graph: one graphify-format graph from the app's CodeGraph cache (`~/Library/Application Support/MeetNotesMac/CodeGraph/<hash>/graph.json`): 1,281 nodes, 2,072 links. It is NOT the canonical graph-kit 1.1 `graph.json` (the doc says none was found). Its relations were mapped: `contains`, `inherits`, `calls` unchanged; `method` to `defines`; `case_of` to `references` (`node/convert-graphify.mjs`). The mapping is a judgement and it changes weights.
- Swift baseline, release build, `GraphLayoutEngine.layout`, quality off: median of 5 runs (3 at 8.1k and above). Deterministic across runs in-process. The lab's own number for `code/large` with quality on was 1.11 s (`docs/kits/graph-kit.md` §6.4); this run gives 1.09 s without quality.

## 3. Measurements

Times in ms, median. "WASM compute" is `t0_layout` inside the Node worker thread (`performance.now` around the call). "Native" is the same Rust code built for `aarch64-apple-darwin` and run in a separate process.

| Graph | n | m | Swift | Native Rust | WASM in worker | WASM / Swift | HTTP overhead (loopback) | input bytes | output bytes |
|---|---|---|---|---|---|---|---|---|---|
| code-small | 288 | 463 | 49 | 25 | 34 | 0.69 | 2.7 | 4,662 | 13,884 |
| code-1k | 1,008 | 1,642 | 158 | 89 | 114 | 0.72 | 2.2 | 16,452 | 49,108 |
| code-medium | 1,568 | 2,587 | 263 | 166 | 229 | 0.87 | 2.0 | 25,902 | 76,708 |
| code-3k | 2,800 | 4,674 | 457 | 290 | 341 | 0.75 | 2.4 | 46,772 | 137,540 |
| **code-large (8.1k)** | 8,100 | 13,139 | **1,091** | 773 | **911** | **0.84** | 3.0 | 131,422 | 395,820 |
| docs-noisy | 540 | 7,253 | 124 | 62 | 84 | 0.68 | 2.0 | 72,569 | 23,828 |
| all-merged | 2,108 | 9,975 | 415 | 238 | 303 | 0.73 | 2.0 | 99,813 | 101,604 |
| fragmented-900 | 3,600 | 2,700 | 636 | 414 | 618 | 0.97 | 1.2 | 27,018 | 151,212 |
| **code-45k** | 44,800 | 73,419 | **7,175** | 5,111 | **6,030** | **0.84** | 3.4 | 734,222 | 2,198,060 |
| real-shaped (mapped) | 1,281 | 2,072 | 220 | 120 | 169 | 0.77 | 2.4 | 20,772 | 62,704 |

Runs per case: 5 (3 for the 8.1k and 45k cases) for WASM and native. The HTTP column is a loopback `node:http` route in front of the same worker, measured end to end from a `fetch` client in the same process, minus the in-worker compute.

Other measurements:

- **WASM size**: 93.0 KB (`opt-level = 3`, LTO, stripped); 36.8 KB gzip -9. An `opt-level = "s"` build was 92.5 KB and slower (1.0 to 1.4 s at 8.1k against 0.86 to 0.91 s), so it was not used.
- **Transfer**: the input is 10 bytes per edge plus a kind table. The doc's compact format (§7.1) is 18 bytes per edge; that variant was not built, so its cost is an estimate (about +8 bytes per edge, under 0.6 MB at 45k). The output is 36 bytes per node plus 8 bytes per kept link, as specified. At 45k the output is 2.2 MB and the loopback overhead is 3.4 ms, so the copy is not the cost.
- **Encode**: the Node encoder took 0.3 to 5 ms per graph. This is a proxy for the Swift encoder, which was not built.

## 4. Parity against Swift

| Check | Result |
|---|---|
| Community ids (Louvain), all nodes | Identical on all 10 graphs (100%). Community count equal on every graph. |
| Radius | Identical to Swift on every graph (difference 0). |
| Degree, in-degree | Not compared. Swift's JSON export does not carry them; the Rust values are only checked by construction. |
| **Native Rust positions vs Swift** | **Bit-identical on all 10 graphs** (every coordinate equal, `nativeVsSwiftMaxPx = 0`). |
| WASM positions vs Swift, max distance in px | 2.4e-12 (small), 1.8e-9 (1k), 1.6e-9 (medium), 2.5e-7 (3k), 3.3e-6 (8.1k), 6.7e-12 (docs), 1.6e-8 (merged), 2.9e-12 (fragmented), 8.0e-4 (45k), 5.4e-8 (real). |
| WASM nodes off by more than 1 px | 0 on every graph. Share of nodes within 1e-6 px: 100% up to 3k, 99.9% at 8.1k, 97.0% at 45k. |
| Lab quality metrics (`LayoutQuality`, computed by Swift) on Swift vs Rust positions | Equal to about 1e-11 relative on all 8 synthetic cases. |

What the numbers mean:

- Rust on macOS, compiled natively, matches Swift bit for bit. That answers the doc's open FMA and operation-order question for these inputs: neither side fused or reordered in a way that changed a bit. This is evidence, not a proof for every input.
- WASM does not match native exactly. Native and WASM outputs differ in the last bits, and the difference grows to 8e-4 px at 45k. The likely cause is that the `wasm32` build uses Rust's own libm for `sin`, `cos` and `pow`, while the native build uses the macOS libm. I did not verify this; it is the cause the doc's §6.6 predicts.
- Discrete outputs (communities, degrees, radii) are exact on WASM, and no node moved by more than a pixel. This fits the doc's Q5 bar (metric-level, not bit-identical).

## 5. Determinism

- WASM output was byte-identical across 5 repeated runs in the worker and across the HTTP route (`deterministicWorkerRuns`, `httpBytesEqualWorker`: true on all graphs).
- Native output was byte-identical across separate processes (checked at 1.6k and 8.1k, with an earlier build of the same code; the later edits changed validation and lints only, and the 8.1k output was re-checked unchanged).
- Swift output was identical across runs in-process.
- One WASM run on `code-medium` took 11.0 s instead of about 0.21 s. It was not reproduced in later runs (0.21 to 0.30 s, including a re-run of the same graph). The machine was under load (load average about 3.5). The cause is unexplained; it should be watched in a real harness.

## 6. Budget verdict (doc §8.3, "proposed, to re-set after T0")

| Budget | Target | Measured | Verdict |
|---|---|---|---|
| 8,000 nodes, p95 compute | at most 1.5 × Swift on the same machine | 0.84 × Swift at 8.1k (911 vs 1,091 ms); 0.68 to 0.97 × over all graphs | Passes, with margin. p95 not measured (3 to 5 runs only). |
| 8,000 nodes, HTTP overhead | under 50 ms | 1 to 5 ms (loopback) | Passes. Not measured against a real server or a non-loopback network. |
| 50,000 nodes, compute | target 15 s | 6.0 s at 44,800 nodes | Passes for 45k. 50k not measured. |

The budget was set in the doc before these numbers existed. On this data it is not tight: a WASM worker is faster than the Swift path. The Swift path includes id-keyed dictionary packaging, which the Rust path does not, so the true WASM-kernel-versus-Swift-kernel ratio is somewhere above these numbers. The Swift force step was not timed separately, so this cannot be split further.

The Mac has no layout performance problem to fix: the Swift path takes 1.1 s at 8.1k (doc §6.3, with a spinner).

## 7. Recommendation for Q1

- Gate result: T0's condition for option A (WASM in the sidecar) is met on all measured inputs, so by the doc's own rule (§7.3) the answer is **A, not D**.
- Reframe: the case for A is the shared kernel (the System page, a Node sidecar and the Tauri desktop), not Mac speed. The Mac is already fast enough. If the shared kernel is not wanted in the near term, **D** (keep Swift, share goldens) is the cheaper choice and loses nothing measurable.
- Option B (native static library) is the only bit-exact path (section 4). It is about 15 percent faster than WASM here (773 against 911 ms at 8.1k). It is still the heaviest option for one consumer (doc §7.2), so this spike does not change the doc's recommendation against it for the Mac alone.
- Option C (WASM in JavaScriptCore) was not measured (section 8).
- For Q5: metric-level parity is what WASM gives (section 4). The bit-identical bar is only reachable with native code.

## 8. Not measured (be explicit)

- Canonical graph-kit 1.1 `graph.json`. Only the graphify-format graph described in section 2 was used, with the relation mapping shown there.
- Option C (JavaScriptCore). Not built or run.
- Swift-side encode and decode cost of the binary contract, and the 18-byte compact variant. The Node encoder is a proxy.
- Swift timing split by stage (force loop alone, packaging alone). The Swift number is end to end.
- p95 and longer-run variance. Runs were 3 to 5 per graph, on a machine under load.
- `LayoutQuality` in Rust. Metrics were computed in Swift on Rust output, which is what the lab compares.
- `CGSimulation3D` (Q4).
- The real llm-ide server. The HTTP route is a bare `node:http` prototype: no auth, no feature gating (`code_graph_3d`), the 8 MB body limit is a hand-written check, Node 22 only (llm-ide supports Node 20+).
- Mac integration: main-actor use, spinner behaviour, cancellation. The doc notes a running layout cannot be cancelled; a worker can be terminated but was not tested.
- The cause of the WASM-versus-native drift (section 4): inferred, not verified.
- Rust unit tests. The spike has none; parity is checked only by the Node harness against Swift.
- Whether the 11 s outlier (section 5) recurs.

## 9. What a K1a port would cost (estimate, not measured)

K1a in the doc is the data step, which needs no migration (§8.3). The port cost is therefore the layout work in T1 to T7 (doc §7.4).

- Done in this spike, unhardened: T2 (topology, PageRank), T3 (Louvain), T4 (Barnes-Hut tree), T5a (force, anchors, seeds). About 1,000 lines of Rust (`rust/src/lib.rs` is 990 lines including the WASM ABI). The Louvain, tree and force code were written as line-by-line ports of the Swift and checked against Swift output, but without the doc's published-value tests and exact-sum tree tests (T3, T4 gates).
- Still to do: T1 (a golden exporter as a real `graph-kit` executable, not this spike's harness), T5b (quality metrics, or keep them in Swift), T6 (the route: `readBody` limit, feature gating, contract fixtures for 200, 400, 404, 413, 500, a worker pool or single worker with restart on panic), T7 (Swift client, preference, fallback on error or timeout), the shared EdgeWeight table (Q7), and CI gates (§8.4).
- Judgement: the doc sizes T1 to T7 at 8 to 9 tasks. With the algorithm already written and matched, the remaining work is nearer 4 to 5 tasks, dominated by T6 and T7 and by making the parity gates run in CI.
- Risks found in the spike: with `panic = "abort"` any Rust panic traps the whole WASM instance. Unknown edge kinds used to panic; they are now rejected at parse time, but any other panic path needs the same treatment or a worker restart policy. The EdgeWeight table is copied, not generated, so it can drift (Q7).

## 10. Reproduce

```sh
# Swift baseline (sandbox off for SwiftPM)
cd spikes/layout-t0/swift && swift build -c release
B=.build/release/T0Bench; OUT=$TMPDIR/t0; mkdir -p $OUT
$B fixtures $OUT
for c in code-small-288 code-1k code-medium-1568 code-3k code-large-8100 docs-noisy all-merged fragmented-900 code-45k; do $B bench $OUT $c 5; done

# Real-shaped graph (path is local, not committed)
node ../node/convert-graphify.mjs "<path>/graph.json" $OUT real-graphify-1281 && $B bench $OUT real-graphify-1281 5

# Rust: WASM module and native driver
cd ../rust && rustup run stable cargo build --release --target wasm32-unknown-unknown --lib && rustup run stable cargo build --release --bin t0native
# Node driver (WASM in worker + HTTP route, parity against Swift)
cd ../node && node t0.mjs $OUT ../rust/target/wasm32-unknown-unknown/release/layout_t0.wasm
# Native run and comparison
../rust/target/release/t0native $OUT/code-large-8100.in.bin 5 $OUT/code-large-8100.native.out && node compare-native.mjs $OUT code-large-8100
# Quality metrics on any output (positions file written by t0.mjs)
$B metrics $OUT code-large-8100 $OUT/code-large-8100.rust.pos.f64
```

Clippy (toolchain binaries called directly; the `rustup run` wrapper mangles `clippy` flags) is clean for the spike crate.

Rust toolchain: stable 1.99.1, `wasm32-unknown-unknown`. Node 22.23.1. Swift: the toolchain used by `make graph-gates`.
