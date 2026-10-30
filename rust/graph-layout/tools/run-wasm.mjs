#!/usr/bin/env node
// Runs graph_layout.wasm over every <name>.in.bin in a directory and writes <name>.wasm.bin.
// This is also the reference for how a host drives the C ABI (see README.md).
//   node run-wasm.mjs <graph_layout.wasm> <dir> [runs=1]   (runs>1 prints median compute ms)
import { readFile, readdir, writeFile } from 'node:fs/promises';

const [wasmPath, dir, runsArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 1);
const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {});
const x = instance.exports;

export function layout(input) {
  const ptr = x.gl_alloc(input.length);
  new Uint8Array(x.memory.buffer, ptr, input.length).set(input);
  const rc = x.gl_layout(ptr, input.length);
  x.gl_free(ptr, input.length);
  if (rc !== 0) throw new Error(`gl_layout failed (rc=${rc}): bad input`);
  // Copy out: the view is invalidated by the next call (and by memory growth).
  return new Uint8Array(x.memory.buffer, x.gl_out_ptr(), x.gl_out_len()).slice();
}

for (const f of (await readdir(dir)).filter((f) => f.endsWith('.in.bin')).sort()) {
  const input = new Uint8Array(await readFile(`${dir}/${f}`));
  const times = [];
  let out;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = layout(input);
    times.push(performance.now() - t);
  }
  await writeFile(`${dir}/${f.replace('.in.bin', '.wasm.bin')}`, out);
  times.sort((a, b) => a - b);
  console.log(`wasm ${f.replace('.in.bin', '')}: median ${times[Math.floor(times.length / 2)].toFixed(1)} ms`);
}
