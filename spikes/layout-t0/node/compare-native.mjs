// Compares the native Rust output (t0native) with the Swift baseline and the WASM output.
// Usage: node compare-native.mjs <outDir> <name> [<name> ...]
// Expects <name>.native.out (t0native), <name>.rust.pos.f64 (t0.mjs), <name>.swift.json (T0Bench).
import fs from 'node:fs';
import path from 'node:path';
import { decodeOutput } from './encode.mjs';

const [dir, ...names] = process.argv.slice(2);
const load = (p) => { const b = fs.readFileSync(p); return decodeOutput(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
for (const name of names) {
  const nat = load(path.join(dir, `${name}.native.out`));
  const wb = fs.readFileSync(path.join(dir, `${name}.rust.pos.f64`));
  const wp = new Float64Array(wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.length));
  const sw = JSON.parse(fs.readFileSync(path.join(dir, `${name}.swift.json`), 'utf8'));
  let maxNW = 0, maxNS = 0, bitEqual = 0, overOnePx = 0, commEq = 0;
  for (let i = 0; i < nat.n; i++) {
    maxNW = Math.max(maxNW, Math.hypot(nat.pos[2 * i] - wp[2 * i], nat.pos[2 * i + 1] - wp[2 * i + 1]));
    const d = Math.hypot(nat.pos[2 * i] - sw.positions[2 * i], nat.pos[2 * i + 1] - sw.positions[2 * i + 1]);
    maxNS = Math.max(maxNS, d);
    if (d === 0) bitEqual++;
    if (d > 1) overOnePx++;
    if (nat.community[i] === sw.community[i]) commEq++;
  }
  console.log(JSON.stringify({ name, n: nat.n, nativeVsSwiftMaxPx: maxNS, nativeBitEqualShare: bitEqual / nat.n,
    communityEqualShare: commEq / nat.n, nativeVsWasmMaxPx: maxNW, nodesOverOnePx: overOnePx }));
}
