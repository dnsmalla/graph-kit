#!/usr/bin/env bash
# Builds the shared layout kernel (rust/graph-layout) to a plain wasm32 module.
# No wasm-bindgen: the module exports a C ABI (gl_alloc / gl_free / gl_layout / gl_out_ptr /
# gl_out_len, plus `memory`) and needs no imports, so any host can instantiate it with `{}`.
#
#   scripts/build-layout-wasm.sh [out-dir]    default out-dir: rust/target/layout-wasm
#
# Prints the output path, byte size and gzip size. Requires the wasm32-unknown-unknown rust
# target (`rustup target add wasm32-unknown-unknown`). OS_WASM_TOOLCHAIN picks a toolchain.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/rust/target}"
OUT="${1:-$TARGET_DIR/layout-wasm}"
TC=()
[ -n "${OS_WASM_TOOLCHAIN:-}" ] && TC=("+$OS_WASM_TOOLCHAIN")
cd "$ROOT/rust"
cargo ${TC[@]+"${TC[@]}"} build --release -p graph-layout --lib --target wasm32-unknown-unknown
mkdir -p "$OUT"
cp "$TARGET_DIR/wasm32-unknown-unknown/release/graph_layout.wasm" "$OUT/graph_layout.wasm"
printf '%s  %s bytes, %s gzip\n' "$OUT/graph_layout.wasm" \
  "$(wc -c <"$OUT/graph_layout.wasm" | tr -d ' ')" "$(gzip -9 -c "$OUT/graph_layout.wasm" | wc -c | tr -d ' ')"
