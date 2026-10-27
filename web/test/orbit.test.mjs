// Orbit (K4) tests: `npm test`. The pure scene helpers and the OrbitPanel
// component load through Vite's SSR loader, like web.test.mjs. three.js is
// never drawn here (Node has no WebGL); the panel's effect does not run in SSR.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYSTEM = path.join(ROOT, '..', 'typescript', 'src', 'system', 'orbit.ts');

let server;
let scene;
let panel;
let orbit;
let view;

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
  scene = await server.ssrLoadModule('/src/orbit/scene.ts');
  panel = await server.ssrLoadModule('/src/orbit/OrbitPanel.tsx');
  orbit = await server.ssrLoadModule(SYSTEM);
  view = await server.ssrLoadModule('/src/orbit/OrbitView.ts');
});

after(async () => {
  await server?.close();
});

const core = (id, category, degree, community = 0) => ({ id, label: `Node ${id}`, category, community, degree });

/** A small hand-made SystemGraph: 4 core nodes in 2 communities, 5 edges, 3 ring items. */
function sampleGraph() {
  return {
    core: [
      core('a', 'code', 4, 0),
      core('b', 'docs', 1, 0),
      core('c', 'tests', 0, 1),
      core('d', 'knowledge', 2, 1),
    ],
    edges: [
      { source: 'a', target: 'b', weight: 1 },
      { source: 'a', target: 'c', weight: 5 },
      { source: 'b', target: 'd', weight: 3 },
      { source: 'c', target: 'd', weight: 2 },
      { source: 'a', target: 'd', weight: 4 },
    ],
    ring: [
      { id: 'activity:1', label: 'Newest', kind: 'merge', at: '2026-10-27T09:00:00Z', link: null },
      { id: 'activity:2', label: 'Older', kind: 'note', at: '2026-10-27T08:00:00Z', link: null },
      { id: 'activity:1', label: 'Duplicate', kind: 'merge', at: '2026-10-27T09:00:00Z', link: null },
    ],
    truncated: { totalNodes: 4, keptNodes: 4, keptCommunities: 2 },
  };
}

const CATEGORY_HEX = { code: '#5b8def', docs: '#e0b341', tests: '#4fbf86', knowledge: '#c17be6', other: '#8a93a6' };

describe('scene colour helpers', () => {
  it('maps categories to CSS custom property names', () => {
    assert.equal(scene.categoryColorVar('code'), '--os-cat-code');
    assert.equal(scene.categoryColorVar('other'), '--os-cat-other');
  });

  it('ships the documented fallback palette', () => {
    assert.deepEqual(scene.DEFAULT_CATEGORY_COLORS, CATEGORY_HEX);
  });

  it('parses 6-digit and 3-digit hex into 0..1 rgb', () => {
    assert.deepEqual(scene.hexToRgb01('#ff0000'), [1, 0, 0]);
    assert.deepEqual(scene.hexToRgb01('00ff00'), [0, 1, 0]);
    assert.deepEqual(scene.hexToRgb01('#fff'), [1, 1, 1]);
    const [r, g, b] = scene.hexToRgb01('#5b8def');
    assert.ok(Math.abs(r - 0x5b / 255) < 1e-12);
    assert.ok(Math.abs(g - 0x8d / 255) < 1e-12);
    assert.ok(Math.abs(b - 0xef / 255) < 1e-12);
  });

  it('rejects anything that is not hex', () => {
    assert.throws(() => scene.hexToRgb01('red'), TypeError);
    assert.throws(() => scene.hexToRgb01('#12345'), TypeError);
  });
});

describe('buildPointBuffers', () => {
  it('lays out one entry per core node in graph order, with matching lengths', () => {
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    const buf = scene.buildPointBuffers(graph, layout, CATEGORY_HEX);
    assert.deepEqual(buf.ids, ['a', 'b', 'c', 'd']);
    assert.equal(buf.positions.length, 4 * 3);
    assert.equal(buf.colors.length, 4 * 3);
    assert.equal(buf.sizes.length, 4);
    buf.ids.forEach((id, i) => {
      const p = layout.core.get(id);
      assert.equal(buf.positions[i * 3], Math.fround(p.x));
      assert.equal(buf.positions[i * 3 + 1], Math.fround(p.y));
      assert.equal(buf.positions[i * 3 + 2], Math.fround(p.z));
    });
  });

  it('colours each node by its category, as 0..1 rgb', () => {
    const graph = sampleGraph();
    const buf = scene.buildPointBuffers(graph, orbit.orbitLayout(graph), CATEGORY_HEX);
    const expected = scene.hexToRgb01(CATEGORY_HEX.docs);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(buf.colors[3 + k] - expected[k]) < 1e-6);
    for (const v of buf.colors) assert.ok(v >= 0 && v <= 1);
  });

  it('uses supplied colours and falls back to defaults for invalid ones', () => {
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    const buf = scene.buildPointBuffers(graph, layout, { ...CATEGORY_HEX, code: '#ffffff', docs: 'nope' });
    assert.deepEqual([buf.colors[0], buf.colors[1], buf.colors[2]], [1, 1, 1]);
    const docs = scene.hexToRgb01(CATEGORY_HEX.docs);
    assert.ok(Math.abs(buf.colors[3] - docs[0]) < 1e-6);
  });

  it('sizes follow 1.5 + 2.5 * sqrt(degree / maxDegree)', () => {
    const graph = sampleGraph();
    const buf = scene.buildPointBuffers(graph, orbit.orbitLayout(graph), CATEGORY_HEX);
    assert.ok(Math.abs(buf.sizes[0] - 4) < 1e-6); // degree 4 = max
    assert.ok(Math.abs(buf.sizes[1] - (1.5 + 2.5 * 0.5)) < 1e-6); // degree 1
    assert.ok(Math.abs(buf.sizes[2] - 1.5) < 1e-6); // degree 0
    for (const s of buf.sizes) assert.ok(s >= 1.5 && s <= 4 + 1e-6);
  });

  it('gives zero-degree-only graphs the minimum size without NaN', () => {
    const graph = { ...sampleGraph(), core: [core('x', 'code', 0), core('y', 'other', 0)] };
    const buf = scene.buildPointBuffers(graph, orbit.orbitLayout(graph), CATEGORY_HEX);
    assert.deepEqual(Array.from(buf.sizes), [1.5, 1.5]);
  });
});

describe('buildEdgeBuffer', () => {
  it('returns every usable edge as 6 floats when under the cap', () => {
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    const buf = scene.buildEdgeBuffer(graph, layout, 10);
    assert.equal(buf.length, graph.edges.length * 6);
    // Every original edge appears once: the segment starts are the source positions.
    graph.edges.forEach((edge, k) => {
      const p = layout.core.get(edge.source);
      assert.equal(buf[k * 6], Math.fround(p.x));
    });
  });

  it('keeps the highest-weight edges first when over the cap', () => {
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    const buf = scene.buildEdgeBuffer(graph, layout, 3);
    assert.equal(buf.length, 3 * 6);
    // Weights are 5 (a-c), 4 (a-d), 3 (b-d): the first kept segment must be a-c.
    const pa = layout.core.get('a');
    const pc = layout.core.get('c');
    const expected = [pa.x, pa.y, pa.z, pc.x, pc.y, pc.z].map(Math.fround);
    assert.deepEqual(Array.from(buf.slice(0, 6)), expected);
    const pd = layout.core.get('d');
    const pb = layout.core.get('b');
    const third = [pb.x, pb.y, pb.z, pd.x, pd.y, pd.z].map(Math.fround);
    assert.deepEqual(Array.from(buf.slice(12, 18)), third);
  });

  it('returns an empty buffer for a zero cap and skips edges to unknown nodes', () => {
    const graph = sampleGraph();
    graph.edges.push({ source: 'a', target: 'missing', weight: 99 });
    const layout = orbit.orbitLayout(graph);
    assert.equal(scene.buildEdgeBuffer(graph, layout, 0).length, 0);
    assert.equal(scene.buildEdgeBuffer(graph, layout).length, 5 * 6);
  });
});

describe('ringLabelPositions', () => {
  it('matches layout.ring, de-duplicated, in graph order', () => {
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    const labels = scene.ringLabelPositions(graph, layout);
    assert.deepEqual(labels.map((l) => l.id), ['activity:1', 'activity:2']);
    for (const l of labels) {
      const p = layout.ring.get(l.id);
      assert.deepEqual({ x: l.x, y: l.y, z: l.z }, p);
    }
    assert.equal(labels[0].label, 'Newest');
    assert.equal(labels[0].kind, 'merge');
  });
});

describe('OrbitPanel (SSR)', () => {
  it('renders the empty state when there is no graph', () => {
    const html = renderToString(createElement(panel.OrbitPanel, { graph: null, layout: null }));
    assert.match(html, /No project graph yet/);
    assert.match(html, /class="orbit-panel"/);
  });

  it('renders the empty state when the graph has no core nodes', () => {
    const graph = { ...sampleGraph(), core: [], edges: [] };
    const layout = orbit.orbitLayout(graph);
    const html = renderToString(createElement(panel.OrbitPanel, { graph, layout }));
    assert.match(html, /No project graph yet/);
  });

  it('does not throw during SSR with a real graph', () => {
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    let html = '';
    assert.doesNotThrow(() => {
      html = renderToString(createElement(panel.OrbitPanel, { graph, layout, onSelect: () => {} }));
    });
    assert.match(html, /class="orbit-panel"/);
    assert.doesNotMatch(html, /No project graph yet/);
  });
});

// ---- OrbitView (three.js) with an injected fake renderer -------------------
// No WebGL and no jsdom: the container, canvas, document, ResizeObserver and
// frame clock are small fakes, and only WebGLRenderer is replaced by createRenderer.

/** A minimal DOM-ish element: children, listeners, style and size. */
function fakeElement(tag, size = {}) {
  const listeners = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    style: {},
    textContent: '',
    parent: null,
    children: [],
    clientWidth: size.width ?? 0,
    clientHeight: size.height ?? 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    dispatch(type, ev) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
    },
    appendChild(child) {
      child.parent?.removeChild(child);
      child.parent = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parent = null;
      return child;
    },
    remove() {
      el.parent?.removeChild(el);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight };
    },
  };
  return el;
}

function fakeRenderer(canvas) {
  const calls = { setSize: [], render: 0, dispose: 0, forceContextLoss: 0 };
  return {
    calls,
    domElement: canvas,
    pixelRatio: 1,
    setPixelRatio(v) { this.pixelRatio = v; },
    getPixelRatio() { return this.pixelRatio; },
    setSize(w, h, updateStyle) { calls.setSize.push([w, h, updateStyle]); },
    render() { calls.render++; },
    dispose() { calls.dispose++; },
    forceContextLoss() { calls.forceContextLoss++; },
  };
}

describe('OrbitView (fake renderer)', () => {
  let container;
  let renderers;
  let frames;
  let cancelled;
  let observers;
  let nextFrameId;
  let savedGlobals;

  const globalsToStub = ['document', 'ResizeObserver', 'getComputedStyle'];

  function makeOptions(extra = {}) {
    return {
      rotationSpeed: 0.05,
      createRenderer: (canvas) => {
        const r = fakeRenderer(canvas);
        renderers.push(r);
        return r;
      },
      requestFrame: (cb) => {
        const id = nextFrameId++;
        frames.set(id, cb);
        return id;
      },
      cancelFrame: (id) => {
        cancelled.push(id);
        frames.delete(id);
      },
      ...extra,
    };
  }

  /** Run every queued animation frame at time t (ms). */
  function runFrames(t) {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(t);
  }

  beforeEach(() => {
    savedGlobals = Object.fromEntries(globalsToStub.map((k) => [k, globalThis[k]]));
    const doc = fakeElement('document');
    doc.hidden = false;
    doc.documentElement = fakeElement('html');
    doc.createElement = (tag) => fakeElement(tag);
    globalThis.document = doc;
    observers = [];
    globalThis.ResizeObserver = class {
      constructor(cb) {
        this.cb = cb;
        this.observed = [];
        this.disconnected = 0;
        observers.push(this);
      }
      observe(el) { this.observed.push(el); }
      disconnect() { this.disconnected++; }
    };
    delete globalThis.getComputedStyle;
    container = fakeElement('div', { width: 400, height: 300 });
    renderers = [];
    frames = new Map();
    cancelled = [];
    nextFrameId = 1;
  });

  afterEach(() => {
    disposeAll();
    for (const [k, v] of Object.entries(savedGlobals)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });

  const live = [];
  function disposeAll() {
    while (live.length) live.pop().dispose();
  }
  function make(extra) {
    const v = new view.OrbitView(container, makeOptions(extra));
    live.push(v);
    return v;
  }

  it('builds the canvas inside a positioned container and sizes the renderer', () => {
    make();
    assert.equal(renderers.length, 1);
    const canvas = renderers[0].domElement;
    assert.equal(container.children[0], canvas);
    assert.equal(container.style.position, 'relative');
    assert.equal(canvas.style.position, 'absolute');
    assert.equal(canvas.style.width, '100%');
    assert.equal(canvas.style.height, '100%');
    assert.deepEqual(renderers[0].calls.setSize[0], [400, 300, false]);
  });

  it('renders on a frame tick and rotates while spinning', () => {
    const v = make();
    const graph = sampleGraph();
    v.setGraph(graph, orbit.orbitLayout(graph));
    assert.ok(frames.size >= 1, 'a frame is queued');
    runFrames(0);
    const r = renderers[0];
    assert.equal(r.calls.render, 1);
    runFrames(1000);
    assert.equal(r.calls.render, 2);
    assert.ok(frames.size >= 1, 'animation keeps going');
  });

  it('does not rebuild buffers when the same graph and layout are passed again', () => {
    const v = make();
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setGraph(graph, layout);
    const first = v.corePoints;
    assert.ok(first, 'core points built');
    v.setGraph(graph, layout);
    assert.equal(v.corePoints, first);
    const groupSize = v.coreGroup.children.length;
    v.setGraph(graph, layout);
    assert.equal(v.coreGroup.children.length, groupSize);
    // A new layout object (even with equal content) rebuilds.
    v.setGraph(graph, orbit.orbitLayout(graph));
    assert.notEqual(v.corePoints, first);
  });

  it('dispose cancels the frame, removes listeners and the canvas, and disposes the renderer once', () => {
    const v = make();
    v.setGraph(sampleGraph(), orbit.orbitLayout(sampleGraph()));
    const canvas = renderers[0].domElement;
    const pendingId = [...frames.keys()][0];
    assert.ok(pendingId !== undefined);
    const obs = observers[0];

    v.dispose();
    assert.deepEqual(cancelled, [pendingId]);
    assert.equal(frames.size, 0);
    assert.equal(obs.disconnected, 1);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave']) {
      assert.equal(canvas.listenerCount(type), 0, type);
    }
    assert.equal(container.children.includes(canvas), false);
    assert.equal(renderers[0].calls.dispose, 1);
    assert.equal(renderers[0].calls.forceContextLoss, 1);

    // Methods after dispose are no-ops; a second dispose does nothing.
    const renderCount = renderers[0].calls.render;
    const sizeCount = renderers[0].calls.setSize.length;
    v.setGraph(sampleGraph(), orbit.orbitLayout(sampleGraph()));
    v.resize();
    v.setReducedMotion(true);
    v.setTheme('light');
    runFrames(5000);
    v.dispose();
    assert.equal(renderers[0].calls.render, renderCount);
    assert.equal(renderers[0].calls.setSize.length, sizeCount);
    assert.equal(renderers[0].calls.dispose, 1);
    assert.equal(cancelled.length, 1);
  });

  it('falls back to the text message when createRenderer throws', () => {
    const v = new view.OrbitView(container, {
      createRenderer: () => {
        throw new Error('no WebGL');
      },
    });
    live.push(v);
    const p = container.children.find((c) => c.className === 'orbit-fallback');
    assert.ok(p, 'fallback element appended');
    assert.equal(p.textContent, '3D view unavailable');
    assert.doesNotThrow(() => v.setGraph(sampleGraph(), orbit.orbitLayout(sampleGraph())));
    assert.doesNotThrow(() => v.resize());
    v.dispose();
    assert.equal(container.children.includes(p), false);
  });

  it('setReducedMotion(true) stops the spin; setReducedMotion(false) resumes it', () => {
    const v = make();
    v.setGraph(sampleGraph(), orbit.orbitLayout(sampleGraph()));
    v.setReducedMotion(true);
    runFrames(0);
    runFrames(500);
    assert.equal(frames.size, 0, 'no further frames while reduced');
    v.setReducedMotion(false);
    assert.equal(frames.size, 1, 'frame queued again');
  });

  it('setTheme("light") switches to normal blending on the point materials', () => {
    const v = make();
    v.setGraph(sampleGraph(), orbit.orbitLayout(sampleGraph()));
    // THREE.AdditiveBlending = 2, THREE.NormalBlending = 1.
    assert.equal(v.corePoints.material.blending, 2);
    v.setTheme('light');
    assert.equal(v.corePoints.material.blending, 1, 'NormalBlending in light');
    assert.ok(v.corePoints.material.uniforms.uOpacity.value > 0.9);
    v.setTheme('dark');
    assert.equal(v.corePoints.material.blending, 2);
  });
});
