// Runs the WASM layout in a worker_threads Worker (the doc's option A shape).
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';

const { instance } = await WebAssembly.instantiate(await readFile(workerData.wasm), {});
const x = instance.exports;

parentPort.on('message', ({ id, input }) => {
  const bytes = new Uint8Array(input);
  const ptr = x.t0_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
  const t0 = performance.now();
  const rc = x.t0_layout(ptr, bytes.length);
  const computeMs = performance.now() - t0;
  x.t0_free(ptr, bytes.length);
  if (rc !== 0) { parentPort.postMessage({ id, error: `t0_layout rc=${rc}` }); return; }
  const out = new Uint8Array(x.memory.buffer, x.t0_out_ptr(), x.t0_out_len()).slice();
  parentPort.postMessage({ id, output: out.buffer, computeMs }, [out.buffer]);
});
parentPort.postMessage({ ready: true });
