#!/usr/bin/env bash
# Conformance: Swift GraphLayoutEngine vs the Rust kernel (native AND wasm32 via Node).
#
#   scripts/layout-conformance.sh [--large]
#
# Needs: swift (graph-layout-lab), cargo + wasm32-unknown-unknown target, node >= 18.
# --large adds the 8.1k and 44.8k node cases (Swift alone takes ~8 s for the latter).
# Exits non-zero on any mismatch. No network, no secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WORK="${CONFORMANCE_DIR:-$(mktemp -d)}"
LARGE=()
[ "${1:-}" = "--large" ] && LARGE=(--large)

echo "== build"
(cd rust && cargo build --release -p graph-layout --bin gl-bench)
scripts/build-layout-wasm.sh >/dev/null
swift build -c release --product graph-layout-lab >/dev/null
LAB="$(swift build -c release --product graph-layout-lab --show-bin-path)/graph-layout-lab"
NATIVE="${CARGO_TARGET_DIR:-$ROOT/rust/target}/release/gl-bench"
WASM="${CARGO_TARGET_DIR:-$ROOT/rust/target}/layout-wasm/graph_layout.wasm"

echo "== swift reference -> $WORK"
"$LAB" --emit-conformance "$WORK" ${LARGE[@]+"${LARGE[@]}"} >/dev/null
echo "== rust native"
for f in "$WORK"/*.in.bin; do "$NATIVE" "$f" 1 "${f%.in.bin}.rust.bin" >/dev/null; done
echo "== rust wasm32 (node)"
node rust/graph-layout/tools/run-wasm.mjs "$WASM" "$WORK" >/dev/null

"$LAB" --verify-conformance "$WORK" rust
"$LAB" --verify-conformance "$WORK" wasm
