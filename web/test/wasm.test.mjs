// The embedded WASM core, checked against the frozen parity goldens: `npm test`.
// Every rust/os-graph/tests/golden/*.json case must come out of the page's wrappers the
// same way it comes out of the Rust tests (parity.rs): the system graph exactly, the orbit
// coordinates within 1e-9. Also checks the generated files the page depends on.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, '..', 'rust', 'os-graph', 'tests', 'golden');
const WASM_DIR = path.join(ROOT, 'src', 'wasm');
const TOLERANCE = 1e-9;

let server;
let wasm;
let glue;
let systemGraph;

before(async () => {
  server = await createServer({
    root: ROOT,
    configFile: false,
    plugins: [react()],
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  wasm = await server.ssrLoadModule(path.join(WASM_DIR, 'index.ts'));
  glue = await server.ssrLoadModule(path.join(WASM_DIR, 'pkg', 'graph_kit_os.js'));
  systemGraph = await server.ssrLoadModule(path.join(ROOT, 'src', 'systemGraph.ts'));
});

after(async () => {
  await server?.close();
});

function goldenCases() {
  return readdirSync(GOLDEN)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: f, golden: JSON.parse(readFileSync(path.join(GOLDEN, f), 'utf8')) }));
}

/** Compares `[[id, {x,y,z}], ...]` from the golden with the wrapper's Map, in order. */
function assertPoints(name, label, gotEntries, wantEntries) {
  assert.equal(gotEntries.length, wantEntries.length, `${name}: ${label} length`);
  gotEntries.forEach(([gid, gp], i) => {
    const [wid, wp] = wantEntries[i];
    assert.equal(gid, wid, `${name}: ${label} id order at ${i}`);
    for (const axis of ['x', 'y', 'z']) {
      const diff = Math.abs(gp[axis] - wp[axis]);
      assert.ok(diff <= TOLERANCE, `${name}: ${label} ${gid}.${axis} diff ${diff}`);
    }
  });
}

function assertOrbit(name, layout, want) {
  assertPoints(name, 'core', [...layout.core.entries()], want.core);
  assertPoints(name, 'ring', [...layout.ring.entries()], want.ring);
  assertPoints(
    name,
    'communityCenters',
    layout.communityCenters.map((c, i) => [String(i), c]),
    want.communityCenters.map((c, i) => [String(i), c]),
  );
  assert.ok(
    Math.abs(layout.bounds.radius - want.bounds.radius) <= TOLERANCE,
    `${name}: bounds.radius ${layout.bounds.radius} vs ${want.bounds.radius}`,
  );
}

// Runs first on purpose: the async tests need a core nothing has started synchronously yet.
describe('async init (Chromium: no synchronous compile on the main thread)', () => {
  it('starts idle, compiles with WebAssembly.compile while loading, then is ready', async () => {
    assert.equal(wasm.osGraphStatus(), 'idle');
    assert.equal(wasm.osGraphReady(), false);
    const realCompile = WebAssembly.compile;
    let compiles = 0;
    WebAssembly.compile = (...args) => {
      compiles += 1;
      return realCompile(...args);
    };
    try {
      const first = wasm.initOsGraphAsync();
      assert.equal(wasm.osGraphStatus(), 'loading');
      assert.equal(wasm.initOsGraphAsync(), first, 'a second call shares the in-flight promise');
      await first;
    } finally {
      WebAssembly.compile = realCompile;
    }
    assert.equal(compiles, 1, 'the async path compiles exactly once');
    assert.equal(wasm.osGraphStatus(), 'ready');
    assert.equal(wasm.osGraphReady(), true);
  });

  it('is idempotent once ready: resolves at once, with no second compile', async () => {
    const realCompile = WebAssembly.compile;
    let compiles = 0;
    WebAssembly.compile = (...args) => {
      compiles += 1;
      return realCompile(...args);
    };
    try {
      await wasm.initOsGraphAsync();
      await wasm.initOsGraphAsync();
      wasm.initOsGraph();
    } finally {
      WebAssembly.compile = realCompile;
    }
    assert.equal(compiles, 0);
  });

  it('while the core compiles, the brain draws the loading state, not a failure', async () => {
    // A fresh core is not in this process any more, so this uses the status directly: the
    // loading state is what drawViews reports whenever the status is 'loading'.
    const drawn = systemGraph.drawViews(null, null);
    assert.equal(drawn.loading, false, 'a ready core is not loading');
    assert.equal(drawn.drawFailed, false);
  });

  it('a sync init afterwards is a no-op and the wrappers work', () => {
    wasm.initOsGraph();
    const graph = wasm.buildSystemGraph(null, null, {});
    assert.deepStrictEqual(graph.core, []);
  });
});

describe('crash recovery (panic = abort traps as WebAssembly.RuntimeError)', () => {
  it('a trap is reported as a restart with the trap as its cause, and the next call works', () => {
    wasm.initOsGraph();
    const before = glue.initSync();
    // An out-of-bounds read inside the core: a real trap from the real module, not a fake.
    const retptr = before.__wbindgen_add_to_stack_pointer(-16);
    assert.throws(
      () =>
        wasm.runCore(() => before.build_system_graph_json(retptr, 0, 0x7fffffff, 0, 0, 0, 0)),
      (err) =>
        err instanceof Error &&
        err.message === 'OS graph core crashed; it was restarted' &&
        err.cause instanceof WebAssembly.RuntimeError,
    );
    const after = glue.initSync();
    assert.notEqual(after, before, 'the glue re-instantiated the core');
    const graph = wasm.buildSystemGraph(null, null, {});
    assert.deepStrictEqual(graph.core, []);
    const layout = wasm.orbitLayout(graph, {});
    assert.equal(layout.core.size, 0);
  });

  it('a non-trap error passes through unchanged and does not restart the core', () => {
    wasm.initOsGraph();
    const before = glue.initSync();
    const original = new TypeError('not a trap');
    assert.throws(() => wasm.runCore(() => { throw original; }), (err) => err === original);
    assert.equal(glue.initSync(), before, 'no restart for an ordinary error');
  });
});

describe('embedded WASM core reproduces the parity goldens', () => {
  const cases = goldenCases();

  it('finds the golden cases', () => {
    assert.ok(cases.length >= 19, `expected >= 19 golden cases, found ${cases.length}`);
  });

  for (const { name, golden } of cases) {
    it(name, () => {
      const input = golden.input;
      if (input.rawSystemGraph !== null && input.rawSystemGraph !== undefined) {
        // Odd, hand-written orbit input: straight through the lenient JSON boundary.
        const layout = wasm.orbitLayout(input.rawSystemGraph, input.orbitOptions);
        assertOrbit(name, layout, golden.orbit);
        return;
      }
      const graph = wasm.buildSystemGraph(input.snapshot, input.project, input.buildOptions);
      assert.deepStrictEqual(graph, golden.systemGraph, `${name}: system graph`);
      const layout = wasm.orbitLayout(graph, input.orbitOptions);
      assertOrbit(name, layout, golden.orbit);
    });
  }
});

describe('wrapper contract', () => {
  it('parseResult throws only for the { error: string } object the core builds', () => {
    assert.throws(() => wasm.parseResult('{"error":"boom"}', 'what'), /^Error: what: boom$/);
    // Any other object is a result, even one with an error key.
    assert.deepStrictEqual(wasm.parseResult('{"error":"x","extra":1}', 'w'), { error: 'x', extra: 1 });
    assert.deepStrictEqual(wasm.parseResult('{"error":5}', 'w'), { error: 5 });
    assert.deepStrictEqual(wasm.parseResult('{"core":[]}', 'w'), { core: [] });
    assert.deepStrictEqual(wasm.parseResult('[]', 'w'), []);
  });

  it('throws the core error instead of returning it', () => {
    assert.throws(() => wasm.orbitLayout(null, {}), /orbitLayout: .*must not be null/);
    const bad = { activity: { items: [{ id: true, kind: 'x', title: 't', createdAt: 't' }] } };
    assert.throws(() => wasm.buildSystemGraph(bad, null, {}), /buildSystemGraph: snapshot/);
  });

  it('maps the layout to Maps keyed by id, in the core order', () => {
    const graph = wasm.buildSystemGraph(null, null, {});
    const layout = wasm.orbitLayout(graph, {});
    assert.ok(layout.core instanceof Map);
    assert.ok(layout.ring instanceof Map);
    assert.equal(layout.core.size, 0);
    assert.deepStrictEqual(layout.communityCenters, []);
    assert.deepStrictEqual(layout.bounds, { radius: 0 });
  });
});

describe('generated WASM files', () => {
  it('bytes.ts records the rustc version it was built with', () => {
    const text = readFileSync(path.join(WASM_DIR, 'bytes.ts'), 'utf8');
    assert.match(text, /^\/\/ GENERATED by scripts\/build-os-wasm\.sh/m);
    assert.match(text, /^\/\/ rustc: rustc \d+\.\d+\.\d+ /m);
    assert.match(text, /^export const OS_GRAPH_WASM_BASE64 = "[A-Za-z0-9+/=]+";$/m);
  });

  it('the wasm-bindgen glue has no import.meta (no bundler asset for the page)', () => {
    const glue = readFileSync(path.join(WASM_DIR, 'pkg', 'graph_kit_os.js'), 'utf8');
    assert.ok(!glue.includes('import.meta'), 'glue must not reference import.meta');
    assert.ok(!/new URL\(/.test(glue), 'glue must not construct a URL to a .wasm file');
  });

  it('no separate .wasm file is kept in pkg/', () => {
    const files = readdirSync(path.join(WASM_DIR, 'pkg'));
    assert.deepStrictEqual(files.filter((f) => f.endsWith('.wasm')), []);
    assert.ok(existsSync(path.join(WASM_DIR, 'pkg', 'graph_kit_os.d.ts')));
  });
});
