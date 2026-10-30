#!/usr/bin/env bash
# Timing: Swift GraphLayoutEngine vs Rust native vs Rust wasm32 (Node), same synthetic graphs.
#
#   scripts/layout-bench.sh [runs=5]
#
# Median wall ms per layout. Caveats: Swift's figure includes its id-keyed dictionary packaging,
# the Rust figures are the bare kernel; wasm figures are Node/V8 on this machine, a webview's
# JIT can differ. Run on an idle machine; one 11 s outlier was seen under load (layout-t0.md).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RUNS="${1:-5}"
WORK="$(mktemp -d)"
(cd rust && cargo build --release -p graph-layout --bin gl-bench) 2>/dev/null
scripts/build-layout-wasm.sh >/dev/null
swift build -c release --product graph-layout-lab >/dev/null
LAB="$(swift build -c release --product graph-layout-lab --show-bin-path)/graph-layout-lab"
T="${CARGO_TARGET_DIR:-$ROOT/rust/target}"
"$LAB" --emit-conformance "$WORK" --large --runs "$RUNS" >/dev/null
node rust/graph-layout/tools/run-wasm.mjs "$T/layout-wasm/graph_layout.wasm" "$WORK" "$RUNS" >"$WORK/wasm.log"
printf '%-18s %8s %10s %10s %10s %8s %8s\n' case nodes swift_ms rust_ms wasm_ms rust/sw wasm/sw
for f in "$WORK"/*.in.bin; do
  n="$(basename "${f%.in.bin}")"
  case "$n" in code-1k|code-large-8100|code-30k|code-45k|all-merged|fragmented-900) ;; *) continue ;; esac
  sw="$(cat "$WORK/$n.swift.ms")"
  rs="$("$T/release/gl-bench" "$f" "$RUNS" | sed -E 's/.*median_ms=([0-9.]+).*/\1/')"
  wa="$(sed -nE "s/^wasm $n: median ([0-9.]+) ms/\1/p" "$WORK/wasm.log")"
  nodes="$(od -An -tu4 -N4 "$f" | tr -d ' ')"
  awk -v n="$n" -v nodes="$nodes" -v s="$sw" -v r="$rs" -v w="$wa" 'BEGIN{printf "%-18s %8d %10.1f %10.1f %10.1f %8.2f %8.2f\n", n, nodes, s, r, w, r/s, w/s}'
done
