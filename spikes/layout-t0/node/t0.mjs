// T0 driver. Usage: node t0.mjs <scratch-dir> <wasm-path> [caseName ...]
// For each case: encode the graph fixture, run the WASM layout in a worker thread
// (direct and through a loopback HTTP route), check determinism, and compare
// against the Swift baseline written by T0Bench.
import { readFile, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import http from 'node:http';
import path from 'node:path';
import { encodeGraph, decodeOutput } from './encode.mjs';

const [dir, wasmPath, ...only] = process.argv.slice(2);
const ALL = ['code-small-288', 'code-1k', 'code-medium-1568', 'code-3k', 'code-large-8100',
  'docs-noisy', 'all-merged', 'fragmented-900', 'code-45k'];
const names = only.length ? only : ALL;
const MAX_BODY = 8 * 1024 * 1024; // core/config.mjs:223 default body limit

const worker = new Worker(new URL('./wasm-worker.mjs', import.meta.url), { workerData: { wasm: wasmPath } });
let nextId = 0;
const pending = new Map();
worker.on('message', (msg) => {
  if (msg.ready) return;
  const resolve = pending.get(msg.id);
  pending.delete(msg.id);
  resolve(msg);
});
const runInWorker = (buf) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg)));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  worker.postMessage({ id, input: ab }, [ab]);
});
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const r3 = (x) => Math.round(x * 1000) / 1000;

// Loopback HTTP route in front of the worker: the doc's `POST /kb/graph/layout` shape.
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/kb/graph/layout') { res.writeHead(404); res.end(); return; }
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { res.writeHead(413); res.end(); return; }
    chunks.push(c);
  }
  const body = Buffer.concat(chunks);
  try {
    const msg = await runInWorker(body);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-compute-ms': String(msg.computeMs) });
    res.end(Buffer.from(msg.output));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const results = [];
for (const name of names) {
  const graph = JSON.parse(await readFile(path.join(dir, `${name}.graph.json`), 'utf8'));
  const swift = JSON.parse(await readFile(path.join(dir, `${name}.swift.json`), 'utf8'));
  const runs = graph.n > 8000 ? 3 : 5;

  // Encode timing (JS side; in production this is the Swift encoder).
  const encTimes = [];
  let input;
  for (let r = 0; r < 3; r++) { const t = performance.now(); input = encodeGraph(graph); encTimes.push(performance.now() - t); }
  await writeFile(path.join(dir, `${name}.in.bin`), input);

  // Direct worker runs: round trip and in-worker compute.
  const rtTimes = [], computeTimes = [];
  let firstOut = null, deterministic = true;
  for (let r = 0; r < runs; r++) {
    const t = performance.now();
    const msg = await runInWorker(input);
    rtTimes.push(performance.now() - t);
    computeTimes.push(msg.computeMs);
    const bytes = Buffer.from(msg.output);
    if (!firstOut) firstOut = bytes; else if (!firstOut.equals(bytes)) deterministic = false;
  }

  // Through the loopback HTTP route (end to end, from a separate client).
  const httpTimes = [], httpCompute = [];
  let httpSame = true;
  for (let r = 0; r < runs; r++) {
    const t = performance.now();
    const resp = await fetch(`http://127.0.0.1:${port}/kb/graph/layout`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: input,
    });
    const body = Buffer.from(await resp.arrayBuffer());
    httpTimes.push(performance.now() - t);
    httpCompute.push(Number(resp.headers.get('x-compute-ms')));
    if (!firstOut.equals(body)) httpSame = false;
  }

  // Parity against Swift (index order; ids were written in the same order).
  const out = decodeOutput(firstOut.buffer.slice(firstOut.byteOffset, firstOut.byteOffset + firstOut.byteLength));
  const n = out.n;
  let commEq = 0, degEq = 0, inEq = 0, maxRadius = 0, maxPos = 0, within9 = 0, within6 = 0, over1 = 0;
  const diffs = [];
  for (let i = 0; i < n; i++) {
    if (out.community[i] === swift.community[i]) commEq++;
    maxRadius = Math.max(maxRadius, Math.abs(out.radius[i] - swift.radius[i]));
    const dx = out.pos[2 * i] - swift.positions[2 * i], dy = out.pos[2 * i + 1] - swift.positions[2 * i + 1];
    const d = Math.hypot(dx, dy);
    diffs.push(d);
    maxPos = Math.max(maxPos, d);
    if (d <= 1e-9) within9++;
    if (d <= 1e-6) within6++;
    if (d > 1) over1++;
  }
  // Degrees and in-degrees are not in the Swift JSON; communities are the discrete check.
  const sortedD = [...diffs].sort((a, b) => a - b);
  const f64 = new Float64Array(2 * n);
  f64.set(out.pos);
  await writeFile(path.join(dir, `${name}.rust.pos.f64`), Buffer.from(f64.buffer));
  const swiftF64 = Float64Array.from(swift.positions);
  await writeFile(path.join(dir, `${name}.swift.pos.f64`), Buffer.from(swiftF64.buffer));

  results.push({
    name, n, m: graph.edges.length, runs,
    encodeMedianMs: r3(median(encTimes)), inputBytes: input.length,
    outputBytes: firstOut.length,
    workerRoundTripMedianMs: r3(median(rtTimes)), workerComputeMedianMs: r3(median(computeTimes)),
    workerComputeRunsMs: computeTimes.map(r3),
    httpRoundTripMedianMs: r3(median(httpTimes)), httpComputeMedianMs: r3(median(httpCompute)),
    httpOverheadMedianMs: r3(median(httpTimes) - median(httpCompute)),
    swiftMedianMs: swift.medianMs, deterministicWorkerRuns: deterministic, httpBytesEqualWorker: httpSame,
    communityEqualCount: commEq, communityEqualFraction: r3(commEq / n),
    communityCountRust: out.communities, communityCountSwift: swift.communityCount,
    radiusMaxAbsDiff: maxRadius,
    positionMaxAbsDiff: maxPos, positionMedianAbsDiff: r3(sortedD[Math.floor(sortedD.length / 2)] ?? 0),
    positionWithin1e9: within9 / n, positionWithin1e6: within6 / n, positionOverOnePx: over1 / n,
    swiftDeterministic: swift.deterministicAcrossRuns,
  });
  console.log(JSON.stringify(results[results.length - 1]));
}

server.close();
await worker.terminate();
await writeFile(path.join(dir, 't0-node-results.json'), JSON.stringify(results, null, 2));
