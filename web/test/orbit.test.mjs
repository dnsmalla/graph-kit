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
import * as THREE from 'three';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The layout runs in the page as WASM (src/wasm); the TS layout no longer exists.
const WASM = path.join(ROOT, 'src', 'wasm', 'index.ts');

let server;
let scene;
let panel;
let orbit;
let view;
let search;
let nodeSearch;

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
  orbit = await server.ssrLoadModule(WASM);
  view = await server.ssrLoadModule('/src/orbit/OrbitView.ts');
  search = await server.ssrLoadModule('/src/orbit/search.ts');
  nodeSearch = await server.ssrLoadModule('/src/components/NodeSearch.tsx');
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

describe('coreFramingRadius', () => {
  it('is the 90th percentile of the core distances, so a few far outliers do not set the framing', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const layout = { core: new Map(ids.map((id, i) => [id, { x: i < 9 ? i + 1 : 1000, y: 0, z: 0 }])), ring: new Map(), communityCenters: [], bounds: { radius: 1000 } };
    assert.equal(scene.coreFramingRadius(ids, layout), 9, 'the 9th of 10 sorted distances');
    assert.equal(scene.coreFramingRadius([], layout), 0);
  });
});

describe('coreSizeScale', () => {
  it('is 1 at the reference size, larger when sparse and smaller when dense, within clamps', () => {
    assert.equal(scene.coreSizeScale(400), 1);
    assert.ok(scene.coreSizeScale(100) > scene.coreSizeScale(400), 'sparse: larger points');
    assert.ok(scene.coreSizeScale(2500) < scene.coreSizeScale(400), 'dense: smaller points');
    assert.equal(scene.coreSizeScale(1), 2, 'clamped at 2');
    assert.equal(scene.coreSizeScale(1e6), 0.4, 'clamped at 0.4');
    assert.equal(scene.coreSizeScale(0), 1);
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

describe('ringLabels', () => {
  it('keeps item order, drops duplicates and items without a position', () => {
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    const items = [...graph.ring, { id: 'activity:9', label: 'No position', kind: 'note', at: '', link: null }];
    const labels = scene.ringLabels(items, layout.ring);
    assert.deepEqual(labels.map((l) => l.id), ['activity:1', 'activity:2']);
    assert.deepEqual({ x: labels[1].x, y: labels[1].y, z: labels[1].z }, layout.ring.get('activity:2'));
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

/** The core and ring inputs OrbitPanel takes, built the way the page builds them. */
function panelInputs(graph = sampleGraph()) {
  const layout = orbit.orbitLayout(graph);
  return {
    core: { graph, layout },
    ring: { items: graph.ring, positions: layout.ring },
  };
}

describe('OrbitPanel (SSR)', () => {
  it('renders the empty state when there is no graph', () => {
    const html = renderToString(createElement(panel.OrbitPanel, { core: null, ring: null }));
    assert.match(html, /No project graph yet/);
    assert.match(html, /class="orbit-panel"/);
  });

  it('renders the empty state when the graph has no core nodes', () => {
    const graph = { ...sampleGraph(), core: [], edges: [] };
    const html = renderToString(createElement(panel.OrbitPanel, { ...panelInputs(graph) }));
    assert.match(html, /No project graph yet/);
  });

  it('hides the empty text while the caller says the load has not settled', () => {
    const html = renderToString(createElement(panel.OrbitPanel, { core: null, ring: null, showEmpty: false }));
    assert.doesNotMatch(html, /No project graph yet/);
  });

  it('the empty text is plain text, not a second status region', () => {
    const html = renderToString(createElement(panel.OrbitPanel, { core: null, ring: null }));
    assert.doesNotMatch(html, /role="status"/);
  });

  it('does not throw during SSR with a real graph', () => {
    let html = '';
    assert.doesNotThrow(() => {
      html = renderToString(createElement(panel.OrbitPanel, { ...panelInputs(), onSelect: () => {}, onFallback: () => {} }));
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
    attrs: {},
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    getAttribute(k) {
      return el.attrs[k] ?? null;
    },
    getRootNode() {
      return globalThis.document;
    },
    get ownerDocument() {
      return globalThis.document;
    },
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
    setPointerCapture() {},
    releasePointerCapture() {},
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
    // The canvas needs a size: zoom-to-cursor divides by the canvas rectangle.
    doc.createElement = (tag) => fakeElement(tag, tag === 'canvas' ? { width: 400, height: 300 } : {});
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

  it('core points use normal blending on both themes (additive saturates to white)', () => {
    const v = make();
    v.setGraph(sampleGraph(), orbit.orbitLayout(sampleGraph()));
    // THREE.NormalBlending = 1 (AdditiveBlending = 2 is never used for the core).
    assert.equal(v.corePoints.material.blending, 1, 'dark');
    assert.ok(Math.abs(v.corePoints.material.uniforms.uOpacity.value - 0.85) < 1e-9, 'alpha ~0.85 on dark');
    v.setTheme('light');
    assert.equal(v.corePoints.material.blending, 1, 'light');
    assert.ok(v.corePoints.material.uniforms.uOpacity.value > 0.9);
    v.setTheme('dark');
    assert.equal(v.corePoints.material.blending, 1, 'dark again');
  });

  it('core point sizes are scaled by the node count (sparse larger than dense)', () => {
    const small = make();
    const sg = chainGraph(40);
    small.setGraph(sg, orbit.orbitLayout(sg));
    const sparseSize = small.coreSizeAttr.array[0];
    const base = scene.buildPointBuffers(sg, orbit.orbitLayout(sg), CATEGORY_HEX).sizes[0];
    assert.ok(Math.abs(sparseSize - base * scene.coreSizeScale(40)) < 1e-5, 'scaled by coreSizeScale');
    assert.ok(sparseSize > base, 'a 40-node core draws larger points than the base size');
  });

  /** A core of `n` nodes in one community, chained so the layout has edges. */
  function chainGraph(n, prefix = 'n') {
    const nodes = Array.from({ length: n }, (_, i) => core(`${prefix}${i}`, 'code', 2, 0));
    const edges = nodes.slice(1).map((node, i) => ({ source: nodes[i].id, target: node.id, weight: 1 }));
    return { core: nodes, edges, ring: [], truncated: { totalNodes: n, keptNodes: n, keptCommunities: 1 } };
  }

  it('setRing rebuilds only the ring: core buffers, core children and the camera pose stay', () => {
    const v = make();
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setGraph(graph, layout);
    const corePoints = v.corePoints;
    const coreChildren = [...v.coreGroup.children];
    const pose = v.camera.position.toArray();

    v.setRing(graph.ring, layout.ring);
    assert.equal(v.corePoints, corePoints, 'core points are the same object');
    assert.deepEqual([...v.coreGroup.children], coreChildren, 'core group untouched');
    assert.deepEqual(v.camera.position.toArray(), pose, 'camera did not move');
    assert.ok(v.ringPoints, 'ring points built');
    assert.equal(v.ringPoints.geometry.attributes.position.count, 2, 'one point per unique ring item');
  });

  it('setRing does not reset the hover', () => {
    const picks = [];
    const v = make({ onHover: (item) => picks.push(item) });
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setGraph(graph, layout);
    const before = picks.length;
    v.setRing(graph.ring, layout.ring);
    assert.equal(picks.length, before, 'no hover callback from a ring change');
  });

  it('setRing with the same ids and times is a no-op; a changed time rebuilds the ring', () => {
    const v = make();
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setGraph(graph, layout);
    v.setRing(graph.ring, layout.ring);
    const first = v.ringPoints;
    v.setRing(graph.ring.map((item) => ({ ...item })), layout.ring);
    assert.equal(v.ringPoints, first, 'equal content, new objects: no rebuild');
    v.setRing(graph.ring.map((item, i) => (i === 0 ? { ...item, at: '2026-10-27T10:00:00Z' } : item)), layout.ring);
    assert.notEqual(v.ringPoints, first, 'a changed time rebuilds');
  });

  it('setGraph keeps the ring that setRing drew', () => {
    const v = make();
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setRing(graph.ring, layout.ring);
    const ring = v.ringPoints;
    assert.ok(ring, 'ring drawn before any core');
    v.setGraph(graph, layout);
    assert.equal(v.ringPoints, ring, 'core update leaves the ring in place');
  });

  it('setGraph with a new same-sized graph keeps the camera pose', () => {
    const v = make();
    const g = chainGraph(40);
    v.setGraph(g, orbit.orbitLayout(g));
    v.camera.position.set(1, 2, 3);
    const same = chainGraph(40, 'm');
    v.setGraph(same, orbit.orbitLayout(same, { seed: 7 }));
    assert.deepEqual(v.camera.position.toArray(), [1, 2, 3], 'same size: the camera is not re-framed');
  });

  it('setGraph re-frames the camera when the core node count changes by more than 20%', () => {
    const v = make();
    const g = chainGraph(40);
    v.setGraph(g, orbit.orbitLayout(g));
    v.camera.position.set(1, 2, 3);
    const big = chainGraph(60, 'b');
    v.setGraph(big, orbit.orbitLayout(big));
    assert.notDeepEqual(v.camera.position.toArray(), [1, 2, 3], 'a 50% larger core is framed again');
  });

  it('refit() frames the camera on the current scene on demand', () => {
    const v = make();
    const g = chainGraph(40);
    v.setGraph(g, orbit.orbitLayout(g));
    const pose = v.camera.position.toArray();
    v.camera.position.set(1, 2, 3);
    v.refit();
    assert.deepEqual(v.camera.position.toArray(), pose);
  });

  it('calls onFallback once when WebGL is unavailable, and not when it is', () => {
    let calls = 0;
    const v = new view.OrbitView(container, {
      createRenderer: () => {
        throw new Error('no WebGL');
      },
      onFallback: () => {
        calls++;
      },
    });
    live.push(v);
    assert.equal(calls, 1);
    v.setRing(sampleGraph().ring, orbit.orbitLayout(sampleGraph()).ring);
    assert.equal(calls, 1, 'not repeated by later calls');

    let working = 0;
    make({ onFallback: () => working++ });
    assert.equal(working, 0, 'WebGL present: no fallback callback');
  });

  /** Camera distance from the orbit centre. */
  const dist = (v) => v.camera.position.distanceTo(v.controls.target);
  /** Runs queued frames until none are left (or 40 rounds): the loop settles when nothing moves. */
  function settle(t0 = 0) {
    for (let i = 0; i < 40 && frames.size > 0; i++) runFrames(t0 + i * 16);
  }

  it('creates OrbitControls on the canvas, with damping and zoom limits, and disposes them', () => {
    const v = make();
    assert.ok(v.controls, 'controls exist');
    assert.equal(v.controls.enableDamping, true);
    assert.ok(v.controls.minDistance > 0);
    assert.ok(v.controls.maxDistance > v.controls.minDistance);
    const canvas = renderers[0].domElement;
    assert.equal(canvas.tabIndex, 0, 'the canvas takes keyboard focus');
    assert.ok(canvas.listenerCount('wheel') >= 1, 'controls listen for the wheel');
    v.dispose();
    assert.equal(canvas.listenerCount('wheel'), 0);
    assert.equal(canvas.listenerCount('gesturechange'), 0);
    assert.equal(canvas.listenerCount('keydown'), 0);
  });

  it('wheel and trackpad pinch change the camera distance, within the zoom bounds, and stop the page zooming', () => {
    const v = make();
    const g = chainGraph(40);
    v.setGraph(g, orbit.orbitLayout(g));
    const canvas = renderers[0].domElement;
    const { minDistance, maxDistance } = v.controls;
    let prevented = 0;
    const off = () => ({ preventDefault: () => prevented++ });

    const d0 = dist(v);
    canvas.dispatch('wheel', { ...off(), deltaY: -120, deltaMode: 0, clientX: 200, clientY: 150, ctrlKey: false });
    runFrames(0);
    assert.ok(dist(v) < d0, 'wheel up zooms in');
    assert.ok(prevented >= 1, 'the wheel default is prevented');

    for (let i = 0; i < 200; i++) canvas.dispatch('wheel', { ...off(), deltaY: -500, deltaMode: 0, clientX: 200, clientY: 150, ctrlKey: false });
    runFrames(0);
    assert.ok(dist(v) >= minDistance - 1e-9, 'never closer than the minimum');

    const beforeGesture = prevented;
    canvas.dispatch('gesturestart', off());
    canvas.dispatch('gesturechange', { ...off(), scale: 0.5 });
    assert.ok(dist(v) <= maxDistance + 1e-9, 'a pinch out is capped at the maximum');
    canvas.dispatch('gesturechange', { ...off(), scale: 1000 });
    assert.ok(Math.abs(dist(v) - minDistance) < 1e-6, 'a pinch in is capped at the minimum');
    canvas.dispatch('gesturechange', { ...off(), scale: 0.0 }); // not a usable scale: ignored, distance unchanged
    assert.ok(Math.abs(dist(v) - minDistance) < 1e-6);
    canvas.dispatch('gestureend', off());
    assert.equal(prevented - beforeGesture, 5, 'every gesture event is prevented (start, three changes, end)');
  });

  it('reset restores the framed camera pose and the orbit centre', () => {
    const v = make();
    const g = chainGraph(40);
    v.setGraph(g, orbit.orbitLayout(g));
    const pose = v.camera.position.toArray();
    const target = v.controls.target.toArray();
    v.zoomIn();
    v.zoomIn();
    v.camera.position.x += 3;
    v.controls.update();
    assert.notDeepEqual(v.camera.position.toArray(), pose);
    v.resetView();
    // The controls recompute the position from spherical coordinates, so compare to rounding error.
    const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
    assert.ok(near(v.camera.position.toArray(), pose), 'camera back on the framed pose');
    assert.ok(near(v.controls.target.toArray(), target), 'orbit centre back at the origin');
  });

  it('zoomIn and zoomOut move the distance by a step, inside the bounds', () => {
    const v = make();
    const g = chainGraph(40);
    v.setGraph(g, orbit.orbitLayout(g));
    const d0 = dist(v);
    v.zoomIn();
    assert.ok(Math.abs(dist(v) - d0 / 1.25) < 1e-6);
    v.zoomOut();
    v.zoomOut();
    assert.ok(Math.abs(dist(v) - d0 * 1.25) < 1e-6);
    for (let i = 0; i < 100; i++) v.zoomIn();
    assert.ok(dist(v) >= v.controls.minDistance - 1e-9);
  });

  it('pause stops the auto-rotation, play resumes it, and a paused view idles', () => {
    const v = make({ rotationSpeed: 0.05 });
    const g = sampleGraph();
    v.setGraph(g, orbit.orbitLayout(g));
    runFrames(0);
    assert.equal(v.controls.autoRotate, true, 'the view rotates by default');
    assert.equal(frames.size, 1, 'a rotating view keeps a frame armed');
    assert.equal(v.toggleRotation(), true, 'toggle reports paused');
    assert.equal(v.controls.autoRotate, false);
    settle(100);
    assert.equal(frames.size, 0, 'paused: nothing re-arms');
    assert.equal(v.toggleRotation(), false);
    assert.equal(v.controls.autoRotate, true);
    assert.equal(frames.size, 1, 'play re-arms the loop');
  });

  it('auto-rotation makes one turn in about 40 s', () => {
    const v = make({ rotationSpeed: 0.05 });
    const g = sampleGraph();
    v.setGraph(g, orbit.orbitLayout(g));
    const speed = v.controls.autoRotateSpeed;
    // One call of update(dt) turns the camera by (2*PI/60) * speed * dt radians.
    assert.ok(Math.abs(((2 * Math.PI) / 60) * speed * 40 - 2 * Math.PI) < 1e-9);
  });

  it('the loop idles when nothing moves: a settled view does not re-arm frames', () => {
    let requests = 0;
    const v = make({
      reducedMotion: true,
      requestFrame: (cb) => {
        requests++;
        const id = nextFrameId++;
        frames.set(id, cb);
        return id;
      },
    });
    const g = sampleGraph();
    v.setGraph(g, orbit.orbitLayout(g));
    settle();
    assert.equal(frames.size, 0, 'settled: no frame queued');
    const before = requests;
    settle();
    runFrames(5000);
    assert.equal(requests, before, 'no request was made while idle');
  });

  it('reduced motion: no auto-rotation, but zoom still works', () => {
    const v = make({ reducedMotion: true });
    const g = sampleGraph();
    v.setGraph(g, orbit.orbitLayout(g));
    runFrames(0);
    assert.equal(v.controls.autoRotate, false);
    const d0 = dist(v);
    v.zoomIn();
    assert.ok(dist(v) < d0);
  });

  it('setSelection updates the attributes in place and dims the non-neighbours', () => {
    const v = make({ reducedMotion: true });
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setGraph(graph, layout);
    const geo = v.corePoints.geometry;
    const alpha = geo.attributes.aAlpha.array;
    const sizes = geo.attributes.aSize.array;
    const positions = geo.attributes.position.array;
    const edgeColors = v.coreGroup.children.find((o) => o.isLineSegments).geometry.attributes.color.array;
    // Node order is a, b, c, d. Core edges: a-b, a-c, b-d, c-d, a-d. Selecting c: its neighbours are a and d.
    v.setSelection('c');
    assert.equal(v.corePoints.geometry, geo, 'no new geometry');
    assert.equal(geo.attributes.aAlpha.array, alpha, 'the alpha buffer is the same object');
    assert.equal(geo.attributes.position.array, positions, 'positions are untouched');
    assert.equal(alpha[2], 1, 'the selected node stays bright');
    assert.equal(alpha[0], 1, 'a neighbour stays bright');
    assert.equal(alpha[3], 1, 'a neighbour stays bright');
    assert.ok(Math.abs(alpha[1] - 0.15) < 1e-6, 'a non-neighbour dims');
    const k = scene.coreSizeScale(4); // the size scale of a four-node core
    assert.ok(Math.abs(sizes[2] - 1.5 * k * 1.8) < 1e-4, 'the selected node grows');
    assert.ok(Math.abs(sizes[0] - 4 * k * 1.35) < 1e-4, 'a neighbour grows less');
    const edgeAlpha = Array.from({ length: edgeColors.length / 4 }, (_, i) => edgeColors[i * 4 + 3]);
    assert.ok(edgeAlpha.includes(4), 'edges touching the selection are brighter');
    assert.ok(edgeAlpha.includes(0.25), 'the other edges dim');
    v.setSelection(null);
    assert.ok(Array.from(alpha).every((a) => a === 1), 'clearing restores every node');
    assert.ok(Array.from(sizes).every((s, i) => Math.abs(s - v.baseSizes[i]) < 1e-6), 'clearing restores the sizes');
    assert.ok(edgeAlpha.length > 0 && Array.from(edgeColors).filter((_, i) => i % 4 === 3).every((a) => a === 1));
  });

  it('a ring selection highlights its ring point and dims the other ring points', () => {
    const v = make({ reducedMotion: true });
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setGraph(graph, layout);
    v.setRing(graph.ring, layout.ring);
    v.setSelection('activity:2');
    const alpha = v.ringPoints.geometry.attributes.aAlpha.array;
    assert.equal(alpha[1], 1);
    assert.ok(Math.abs(alpha[0] - 0.15) < 1e-6);
  });

  it('a ring selection leaves every core alpha and every edge alpha at 1 (the core is not dimmed)', () => {
    const v = make({ reducedMotion: true });
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setGraph(graph, layout);
    v.setRing(graph.ring, layout.ring);
    v.setSelection('activity:2');
    assert.ok(Array.from(v.corePoints.geometry.attributes.aAlpha.array).every((a) => a === 1), 'core alphas');
    const edgeColors = v.coreGroup.children.find((o) => o.isLineSegments).geometry.attributes.color.array;
    assert.ok(Array.from(edgeColors).filter((_, i) => i % 4 === 3).every((a) => a === 1), 'edge alphas');
  });

  it('the core fills about 60% of the stage height on framing, and the ring may run past it', () => {
    const v = make({ reducedMotion: true });
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setGraph(graph, layout);
    v.setRing(graph.ring, layout.ring);
    const coreR = scene.coreFramingRadius(graph.core.map((n) => n.id), layout);
    const vHalf = Math.PI / 8; // half of the 45 degree field of view
    const fraction = coreR / (dist(v) * Math.tan(vHalf));
    assert.ok(Math.abs(fraction - 0.6) < 1e-6, `core/height fraction ${fraction}`);
    assert.ok(v.radius > coreR, 'the ring radius is larger than the framed core');
  });

  it('zoom limits follow the layout radius on every setGraph, not only on framing', () => {
    const v = make({ reducedMotion: true });
    const small = chainGraph(4);
    v.setGraph(small, orbit.orbitLayout(small));
    const max1 = v.controls.maxDistance;
    const big = chainGraph(400, 'q');
    v.setGraph(big, orbit.orbitLayout(big));
    assert.ok(v.controls.maxDistance > max1, 'a larger layout raises the zoom-out limit');
    assert.ok(Math.abs(v.controls.maxDistance - v.radius * 6) < 1e-9, 'limit = MAX_DISTANCE_RATIO * radius');
  });

  it('a render is requested on start and after setGraph, with no input (the first frame is never skipped)', () => {
    const v = make({ reducedMotion: true });
    assert.ok(frames.size >= 1, 'armed on construction');
    runFrames(0);
    assert.equal(renderers[0].calls.render, 1, 'the first frame renders the empty scene');
    const g = sampleGraph();
    v.setGraph(g, orbit.orbitLayout(g));
    assert.ok(frames.size >= 1, 'setGraph queues a frame');
    runFrames(16);
    assert.equal(renderers[0].calls.render, 2, 'and it renders');
  });

  it('auto-rotation rotates the camera only: the scene groups keep rotation 0', () => {
    const v = make({ rotationSpeed: 0.05 });
    const g = sampleGraph();
    v.setGraph(g, orbit.orbitLayout(g));
    for (let t = 0; t <= 2000; t += 100) runFrames(t);
    assert.equal(v.controls.autoRotate, true, 'spinning');
    assert.equal(v.coreGroup.rotation.y, 0, 'core group not rotated');
    assert.equal(v.ringGroup.rotation.y, 0, 'ring group not rotated');
  });

  it('a focus flight pauses the auto-rotation, and it resumes RESUME_MS (4 s) after the flight', () => {
    const timers = [];
    const v = make({
      rotationSpeed: 0.05,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      clearTimer: (h) => {
        if (timers[h]) timers[h].fn = null;
      },
    });
    const g = sampleGraph();
    v.setGraph(g, orbit.orbitLayout(g));
    runFrames(0);
    runFrames(100);
    assert.equal(v.controls.autoRotate, true);
    assert.equal(v.focusNode('c'), true);
    assert.equal(v.controls.autoRotate, false, 'no rotation during the flight');
    for (const t of [200, 400, 600, 800]) runFrames(t);
    assert.equal(v.controls.autoRotate, false, 'still paused right after the flight');
    const resume = timers.filter((t) => t.fn && t.ms === 4000).at(-1);
    assert.ok(resume, 'a resume timer of 4000 ms is armed');
    resume.fn();
    assert.equal(v.controls.autoRotate, true, 'rotation resumes');
  });

  it('after a focus flight the orbit centre stays on the node and the distance is constant while rotating', () => {
    const timers = [];
    const v = make({
      rotationSpeed: 0.05,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      clearTimer: (h) => {
        if (timers[h]) timers[h].fn = null;
      },
    });
    const g = sampleGraph();
    const layout = orbit.orbitLayout(g);
    v.setGraph(g, layout);
    v.focusNode('c');
    for (const t of [0, 200, 400, 600, 800]) runFrames(t);
    timers.filter((t) => t.fn && t.ms === 4000).at(-1).fn();
    const node = layout.core.get('c');
    const d0 = dist(v);
    for (let i = 0; i < 30; i++) runFrames(1000 + i * 16);
    assert.ok(v.controls.target.distanceTo(node) < 1e-4, 'the orbit centre is still on the node');
    assert.ok(Math.abs(dist(v) - d0) < 1e-4, 'the camera orbits at a constant distance');
    assert.equal(v.coreGroup.rotation.y, 0);
  });

  it('pick threshold scales with the camera distance (about 8 px in world units)', () => {
    const v = make({ reducedMotion: true });
    const g = sampleGraph();
    v.setGraph(g, orbit.orbitLayout(g));
    const d0 = dist(v);
    v.pickAt(200, 150);
    const t0 = v.raycaster.params.Points.threshold;
    const vHalf = Math.PI / 8;
    assert.ok(Math.abs(t0 - (d0 * Math.tan(vHalf) * 2 * 8) / 300) < 1e-9, 'distance * tan(fov/2) * 2 * 8 / height');
    v.zoomIn();
    v.pickAt(200, 150);
    const t1 = v.raycaster.params.Points.threshold;
    assert.ok(Math.abs(t1 / t0 - dist(v) / d0) < 1e-9, 'scales with the distance');
  });

  it('a plain click does not count as a camera move; a drag past the slop does', () => {
    const v = make({ reducedMotion: true });
    const g = sampleGraph();
    v.setGraph(g, orbit.orbitLayout(g));
    const canvas = renderers[0].domElement;
    const ptr = (type, x, y) => ({ type, button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
    canvas.dispatch('pointerdown', ptr('pointerdown', 200, 150));
    runFrames(0);
    canvas.dispatch('pointerup', ptr('pointerup', 200, 150));
    runFrames(0);
    assert.equal(v.userMoved, false, 'a click leaves the view auto-framed');
    // The controls listen for pointermove and pointerup on the document (as in the browser, the event bubbles there).
    const doc = globalThis.document;
    canvas.dispatch('pointerdown', ptr('pointerdown', 200, 150));
    canvas.dispatch('pointermove', ptr('pointermove', 260, 180));
    doc.dispatch('pointermove', ptr('pointermove', 260, 180));
    runFrames(0);
    canvas.dispatch('pointerup', ptr('pointerup', 260, 180));
    doc.dispatch('pointerup', ptr('pointerup', 260, 180));
    runFrames(0);
    assert.equal(v.userMoved, true, 'a drag is a camera move');
  });

  it('focusNode moves the orbit centre to the node and leaves the selection alone', () => {
    const v = make({ reducedMotion: true });
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setGraph(graph, layout);
    assert.equal(v.focusNode('missing'), false);
    assert.equal(v.focusNode('c'), true);
    for (let t = 0; t <= 500; t += 100) runFrames(t);
    const p = layout.core.get('c');
    const target = v.controls.target;
    assert.ok(Math.abs(target.x - p.x) < 1e-4, 'x');
    assert.ok(Math.abs(target.y - p.y) < 1e-4, 'y');
    assert.ok(Math.abs(target.z - p.z) < 1e-4, 'z');
    assert.ok(dist(v) >= v.controls.minDistance - 1e-9 && dist(v) <= v.controls.maxDistance + 1e-9);
    assert.equal(v.selectedId, null, 'focusing does not select');
  });

  it('a focus flight is eased over about 400 ms, not a jump', () => {
    const v = make({ reducedMotion: true });
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    v.setGraph(graph, layout);
    const start = v.controls.target.clone();
    v.focusNode('c');
    runFrames(0);
    runFrames(200);
    const mid = v.controls.target.clone();
    assert.ok(mid.distanceTo(start) > 0, 'the target has moved part way');
    assert.ok(mid.distanceTo(layout.core.get('c')) > 0, 'but has not arrived');
    runFrames(400);
    runFrames(450);
    assert.ok(v.controls.target.distanceTo(start) > 0);
    assert.equal(frames.size, 0, 'the flight ends and the loop idles');
  });

  it('colour mode switch recolours the core in place', () => {
    const v = make();
    const graph = sampleGraph();
    v.setGraph(graph, orbit.orbitLayout(graph));
    const attr = v.corePoints.geometry.attributes.aColor;
    const arr = attr.array;
    const kindA = Array.from(arr.slice(0, 3));
    v.setColorMode('cluster');
    assert.equal(v.corePoints.geometry.attributes.aColor, attr, 'same attribute');
    assert.equal(attr.array, arr, 'same buffer');
    const round = (xs) => xs.map((x) => Math.round(x * 1e4) / 1e4);
    // a is community 0 (palette slot 1), c is community 1 (slot 2).
    assert.deepEqual(round(Array.from(arr.slice(0, 3))), round(scene.hexToRgb01(scene.DEFAULT_CLUSTER_COLORS[0])));
    assert.deepEqual(round(Array.from(arr.slice(6, 9))), round(scene.hexToRgb01(scene.DEFAULT_CLUSTER_COLORS[1])));
    v.setColorMode('kind');
    assert.deepEqual(Array.from(arr.slice(0, 3)), kindA, 'back to the category colour');
  });

  it('keyboard: plus and minus zoom, 0 resets, space pauses, other keys are ignored', () => {
    const v = make();
    const g = sampleGraph();
    v.setGraph(g, orbit.orbitLayout(g));
    const canvas = renderers[0].domElement;
    const d0 = dist(v);
    let prevented = 0;
    const key = (k, extra = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, preventDefault: () => prevented++, ...extra });
    canvas.dispatch('keydown', key('+'));
    assert.ok(dist(v) < d0, '+ zooms in');
    canvas.dispatch('keydown', key('-'));
    canvas.dispatch('keydown', key('-'));
    assert.ok(dist(v) > d0, '- zooms out');
    canvas.dispatch('keydown', key('0'));
    assert.ok(Math.abs(dist(v) - d0) < 1e-9, '0 resets');
    canvas.dispatch('keydown', key(' '));
    assert.equal(v.isRotationPaused(), true, 'space pauses');
    canvas.dispatch('keydown', key('x'));
    canvas.dispatch('keydown', key('+', { metaKey: true }));
    assert.equal(prevented, 5, 'only the five handled keys are prevented');
    assert.equal(v.isRotationPaused(), true);
  });

  it('orbitKeyAction maps the keys and nothing else', () => {
    assert.equal(view.orbitKeyAction('+'), 'zoomIn');
    assert.equal(view.orbitKeyAction('='), 'zoomIn');
    assert.equal(view.orbitKeyAction('-'), 'zoomOut');
    assert.equal(view.orbitKeyAction('0'), 'reset');
    assert.equal(view.orbitKeyAction(' '), 'togglePause');
    assert.equal(view.orbitKeyAction('a'), null);
    assert.equal(view.orbitKeyAction('Enter'), null);
  });
});

describe('colour and selection helpers', () => {
  it('colorToHex reads hex and CSS rgb() in both the percent and number forms', () => {
    assert.equal(scene.colorToHex('#5B8DEF'), '#5b8def');
    assert.equal(scene.colorToHex('#abc'), '#aabbcc');
    assert.equal(scene.colorToHex('rgb(100% 0% 50%)'), '#ff0080');
    assert.equal(scene.colorToHex('rgb(255, 0, 128)'), '#ff0080');
    assert.equal(scene.colorToHex(' rgb(36% 55% 94%) '), '#5c8cf0');
    assert.equal(scene.colorToHex(''), null);
    assert.equal(scene.colorToHex('oklch(0.7 0.1 200)'), null);
  });

  it('the cluster palette has ten distinct colours and clusterColor wraps every ten clusters', () => {
    const pal = scene.DEFAULT_CLUSTER_COLORS;
    assert.equal(pal.length, 10);
    assert.equal(new Set(pal).size, 10);
    assert.equal(scene.clusterColor(0, pal), pal[0]);
    assert.equal(scene.clusterColor(10, pal), pal[0]);
    assert.equal(scene.clusterColor(13, pal), pal[3]);
  });

  it('clusterSummary counts nodes per community, largest community first', () => {
    const nodes = [{ community: 1 }, { community: 0 }, { community: 1 }, { community: 2 }];
    assert.deepEqual(scene.clusterSummary(nodes), [
      { community: 0, count: 1 },
      { community: 1, count: 2 },
      { community: 2, count: 1 },
    ]);
  });

  it('buildEdgeData returns the same positions as buildEdgeBuffer, plus endpoint indexes', () => {
    const graph = sampleGraph();
    const layout = orbit.orbitLayout(graph);
    const index = new Map(['a', 'b', 'c', 'd'].map((id, i) => [id, i]));
    const data = scene.buildEdgeData(graph, layout, index);
    assert.deepEqual(Array.from(data.positions), Array.from(scene.buildEdgeBuffer(graph, layout)));
    assert.equal(data.ends.length, graph.edges.length * 2);
    assert.deepEqual(Array.from(data.ends.slice(0, 2)), [0, 2], 'a-c is the heaviest edge');
  });

  it('searchCoreNodes ranks label prefix, then label substring, then id; case-insensitive; capped', () => {
    const graph = {
      core: [
        { id: 'x1', label: 'Alpha', category: 'code', community: 0, degree: 1 },
        { id: 'x2', label: 'Beta alpha', category: 'docs', community: 0, degree: 1 },
        { id: 'alpha-id', label: 'zeta', category: 'tests', community: 0, degree: 1 },
        { id: 'y', label: 'Gamma', category: 'other', community: 0, degree: 1 },
      ],
      edges: [],
      ring: [],
      truncated: { totalNodes: 4, keptNodes: 4, keptCommunities: 1 },
    };
    assert.deepEqual(search.searchCoreNodes(graph, 'ALPHA').map((h) => h.id), ['x1', 'x2', 'alpha-id']);
    assert.deepEqual(search.searchCoreNodes(graph, '  '), []);
    assert.deepEqual(search.searchCoreNodes(null, 'alpha'), []);
    assert.equal(search.searchCoreNodes(graph, 'a', 2).length, 2);
    assert.equal(search.SEARCH_LIMIT, 8);
  });
});

describe('toolbar and search (SSR)', () => {
  const noop = () => {};
  const toolbarProps = (extra = {}) => ({
    colorBy: 'kind',
    paused: false,
    rotationDisabled: false,
    onZoomIn: noop,
    onZoomOut: noop,
    onReset: noop,
    onTogglePause: noop,
    onColorByChange: noop,
    ...extra,
  });

  it('the toolbar has labelled zoom, reset and pause buttons and a Colour by group', () => {
    const html = renderToString(createElement(panel.OrbitToolbar, toolbarProps()));
    for (const label of ['Zoom in', 'Zoom out', 'Reset view', 'Pause rotation']) {
      assert.match(html, new RegExp(`aria-label="${label}"`));
    }
    assert.match(html, /role="group" aria-label="Colour by"/);
    assert.match(html, /aria-pressed="true"[^>]*>Kind</);
    assert.match(html, /aria-pressed="false"[^>]*>Cluster</);
  });

  it('the toolbar shows Play when paused, marks Cluster when colouring by cluster, and disables pause under reduced motion', () => {
    const html = renderToString(createElement(panel.OrbitToolbar, toolbarProps({ paused: true, colorBy: 'cluster', rotationDisabled: true })));
    assert.match(html, /aria-label="Play rotation"/);
    assert.match(html, /aria-pressed="true"[^>]*>Cluster</);
    assert.match(html, /disabled=""/);
  });

  it('the panel renders the toolbar', () => {
    const html = renderToString(createElement(panel.OrbitPanel, { core: null, ring: null }));
    assert.match(html, /aria-label="Zoom in"/);
    assert.match(html, /role="toolbar"/);
  });

  it('SearchResults renders a listbox with one option per hit and marks the active one', () => {
    const results = [
      { id: 'a', label: 'Alpha', category: 'code' },
      { id: 'b', label: 'Beta', category: 'docs' },
    ];
    const html = renderToString(createElement(nodeSearch.SearchResults, { results, activeIndex: 1, listId: 'L', onChoose: noop }));
    assert.match(html, /role="listbox"/);
    assert.equal((html.match(/role="option"/g) ?? []).length, 2);
    assert.match(html, /id="L-1" role="option" aria-selected="true"/);
    assert.match(html, /id="L-0" role="option" aria-selected="false"/);
  });

  it('SearchResults says when nothing matches', () => {
    const html = renderToString(createElement(nodeSearch.SearchResults, { results: [], activeIndex: 0, listId: 'L', onChoose: noop }));
    assert.match(html, /role="status"/);
    assert.match(html, /No matching nodes/);
    assert.doesNotMatch(html, /role="listbox"/);
  });

  it('NodeSearch renders a combobox, closed until the user types', () => {
    const graph = sampleGraphForSearch();
    const html = renderToString(createElement(nodeSearch.NodeSearch, { graph, onChoose: noop }));
    assert.match(html, /role="combobox"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /role="listbox"/);
    const empty = renderToString(createElement(nodeSearch.NodeSearch, { graph: null, onChoose: noop }));
    assert.match(empty, /disabled=""/);
  });
});

function sampleGraphForSearch() {
  return {
    core: [{ id: 'a', label: 'Alpha', category: 'code', community: 0, degree: 1 }],
    edges: [],
    ring: [],
    truncated: { totalNodes: 1, keptNodes: 1, keptCommunities: 1 },
  };
}

// ---- OrbitView: the OS graph (setViz) with the same fake renderer ------------
// The OS graph is a VizGraph laid out by the core. Picks are resolved by projecting the node
// with the view's own camera, so a click lands where the node is drawn.

/** A small OS-graph sample: a hub, two models, a provider; one labelled edge, one self-loop, one duplicate id. */
function vizSample() {
  const node = (id, kind, extra = {}) => ({
    id,
    label: extra.label ?? id,
    kind,
    group: extra.group ?? 0,
    size: extra.size ?? 1,
    labelled: !!extra.labelled,
    drill: extra.drill ?? null,
    status: extra.status ?? null,
    meta: {},
  });
  return {
    level: 'models',
    title: 'Models',
    nodes: [
      node('hub:models', 'hub', { label: 'Models', size: 4, labelled: true, drill: 'models', status: 'ok', group: 4 }),
      node('model:a/one', 'model', { label: 'one', status: 'running', labelled: true, group: 4 }),
      node('model:a/two', 'model', { label: 'two', status: 'off', group: 4 }),
      node('provider:a', 'provider', { label: 'a', status: 'warn', labelled: true, group: 4 }),
      node('model:a/one', 'model', { label: 'duplicate' }),
    ],
    edges: [
      { source: 'hub:models', target: 'model:a/one', kind: 'member', weight: 1 },
      { source: 'provider:a', target: 'model:a/one', kind: 'provides', weight: 3, label: 'serves one' },
      { source: 'hub:models', target: 'model:a/two', kind: 'member', weight: 0.5 },
      { source: 'model:a/two', target: 'model:a/two', kind: 'member', weight: 1 },
    ],
  };
}

describe('OrbitView: the OS graph (fake renderer)', () => {
  let container;
  let frames;
  let nextFrameId;
  let savedGlobals;
  const globalsToStub = ['document', 'ResizeObserver', 'getComputedStyle'];
  const live = [];

  beforeEach(() => {
    savedGlobals = Object.fromEntries(globalsToStub.map((k) => [k, globalThis[k]]));
    const doc = fakeElement('document');
    doc.hidden = false;
    doc.documentElement = fakeElement('html');
    doc.createElement = (tag) => fakeElement(tag, tag === 'canvas' ? { width: 400, height: 300 } : {});
    globalThis.document = doc;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    delete globalThis.getComputedStyle;
    container = fakeElement('div', { width: 400, height: 300 });
    frames = new Map();
    nextFrameId = 1;
  });

  afterEach(() => {
    while (live.length) live.pop().dispose();
    for (const [k, v] of Object.entries(savedGlobals)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });

  function make(extra = {}) {
    const v = new view.OrbitView(container, {
      rotationSpeed: 0.05,
      createRenderer: (canvas) => fakeRenderer(canvas),
      requestFrame: (cb) => {
        const id = nextFrameId++;
        frames.set(id, cb);
        return id;
      },
      cancelFrame: (id) => frames.delete(id),
      ...extra,
    });
    live.push(v);
    return v;
  }

  function runFrames(t) {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(t);
  }

  const labelLayer = () => container.children.find((c) => c.className === 'orbit-labels');
  const labelsIn = () => (labelLayer()?.children ?? []).filter((c) => c.className === 'orbit-label');
  const edgeLines = (v) => v.coreGroup.children.find((o) => o.isLineSegments && o.material.vertexColors);
  const labelEdgeLines = (v) => v.coreGroup.children.find((o) => o.isLineSegments && !o.material.vertexColors);

  /** Where a layout point is drawn on the canvas (client pixels), with the view's own camera. */
  function screenOf(v, p) {
    v.camera.updateMatrixWorld();
    const ndc = new THREE.Vector3(p.x, p.y, p.z).project(v.camera);
    return { clientX: ((ndc.x + 1) / 2) * 400, clientY: ((1 - ndc.y) / 2) * 300 };
  }

  it('builds one point per distinct node, sized by its size, and labels only the labelled nodes', () => {
    const v = make({ reducedMotion: true });
    const viz = vizSample();
    const layout = orbit.vizLayout(viz, { seed: 1 });
    v.setViz(viz, layout);
    const geo = v.corePoints.geometry;
    assert.equal(geo.attributes.position.count, 4, 'four distinct nodes (the duplicate id is dropped)');
    assert.equal(geo.attributes.aSize.count, 4);
    assert.equal(geo.attributes.aAlpha.count, 4);
    assert.ok(Math.abs(geo.attributes.aSize.array[0] - scene.vizNodeSize(viz.nodes[0])) < 1e-4, 'the hub is the largest point');
    assert.ok(geo.attributes.aSize.array[0] > geo.attributes.aSize.array[1] * 1.5, 'the hub is well above a member');
    const labels = labelsIn();
    assert.equal(labels.length, 3, 'hub, one and a are labelled; two is not');
    assert.deepEqual(labels.map((l) => l.textContent), ['Models', 'one', 'a']);
    assert.equal(v.ringGroup.visible, false, 'the ring is hidden in the OS graph');
  });

  it('colours by kind and status, and quiets an off node', () => {
    const v = make({ reducedMotion: true });
    const viz = vizSample();
    v.setViz(viz, orbit.vizLayout(viz, { seed: 1 }));
    const geo = v.corePoints.geometry;
    const colors = geo.attributes.aColor.array;
    const expected = scene.vizNodeRgb(viz.nodes[1], 'dark');
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(colors[3 + c] - expected[c]) < 1e-6, 'a running model takes its kind colour with the status tint');
    const alpha = geo.attributes.aAlpha.array;
    assert.equal(alpha[0], 1);
    assert.ok(Math.abs(alpha[2] - scene.VIZ_OFF_ALPHA) < 1e-6, 'an off node is drawn quiet');
  });

  it('draws the drawn edges by weight, drops self-loops, and keeps the labelled edge for hover', () => {
    const v = make({ reducedMotion: true });
    const viz = vizSample();
    v.setViz(viz, orbit.vizLayout(viz, { seed: 1 }));
    const edges = edgeLines(v);
    assert.equal(edges.geometry.attributes.position.count, 6, 'three edges, two vertices each (the self-loop is dropped)');
    const rgba = edges.geometry.attributes.color.array;
    const heaviest = rgba[(1 * 2) * 4 + 3];
    const lightest = rgba[(2 * 2) * 4 + 3];
    assert.equal(heaviest, 1);
    assert.ok(Math.abs(lightest - (0.33 + 0.67 * (0.5 / 3))) < 1e-6, 'the lightest edge keeps a third');
    assert.equal(labelEdgeLines(v).geometry.attributes.position.count, 2, 'one labelled edge is hit-tested');
  });

  it('hovering a labelled edge reports it as an edge pick with its label', () => {
    const picks = [];
    const v = make({ reducedMotion: true, onHover: (item) => picks.push(item) });
    const viz = vizSample();
    const layout = orbit.vizLayout(viz, { seed: 1 });
    v.setViz(viz, layout);
    const provider = layout.core.get('provider:a');
    const target = layout.core.get('model:a/one');
    const mid = { x: provider.x + (target.x - provider.x) * 0.5, y: provider.y + (target.y - provider.y) * 0.5, z: provider.z + (target.z - provider.z) * 0.5 };
    const at = screenOf(v, mid);
    v.renderer.domElement.dispatch('pointermove', at);
    const last = picks[picks.length - 1];
    assert.ok(last, 'a hover pick was reported');
    assert.equal(last.type, 'edge');
    assert.equal(last.label, 'serves one');
    assert.equal(last.detail, 'provides');
  });

  it('a click on a node reports a viz pick with its id, kind and drill hub', () => {
    const selects = [];
    const v = make({ reducedMotion: true, onSelect: (item) => selects.push(item) });
    const viz = vizSample();
    const layout = orbit.vizLayout(viz, { seed: 1 });
    v.setViz(viz, layout);
    const at = screenOf(v, layout.core.get('hub:models'));
    const canvas = v.renderer.domElement;
    canvas.dispatch('pointerdown', { ...at, button: 0 });
    canvas.dispatch('pointerup', { ...at, type: 'pointerup', button: 0 });
    assert.equal(selects.length, 1);
    assert.deepEqual(selects[0], { type: 'viz', id: 'hub:models', label: 'Models', detail: 'hub', drill: 'models' });
  });

  it('a running node pulses on frames; with reduced motion it holds still', () => {
    const viz = vizSample();
    const layout = orbit.vizLayout(viz, { seed: 1 });
    const moving = make({});
    moving.setViz(viz, layout);
    runFrames(0);
    const a0 = moving.corePoints.geometry.attributes.aAlpha.array[1];
    runFrames(350);
    const a1 = moving.corePoints.geometry.attributes.aAlpha.array[1];
    assert.notEqual(a0, a1, 'the running node changes alpha over time');
    assert.equal(moving.corePoints.geometry.attributes.aAlpha.array[0], 1, 'a node that is not running does not pulse');
    moving.dispose();

    const still = make({ reducedMotion: true });
    still.setViz(viz, layout);
    runFrames(0);
    const s0 = still.corePoints.geometry.attributes.aAlpha.array[1];
    runFrames(350);
    assert.equal(still.corePoints.geometry.attributes.aAlpha.array[1], s0, 'reduced motion: no pulse');
  });

  it('switching between the OS graph and the code brain disposes the old buffers and clears the labels', () => {
    const v = make({ reducedMotion: true });
    const graph = sampleGraph();
    v.setGraph(graph, orbit.orbitLayout(graph));
    v.setRing(graph.ring, orbit.orbitLayout(graph).ring);
    const oldGeo = v.corePoints.geometry;
    let disposed = 0;
    const realDispose = oldGeo.dispose.bind(oldGeo);
    oldGeo.dispose = () => {
      disposed++;
      realDispose();
    };
    const viz = vizSample();
    v.setViz(viz, orbit.vizLayout(viz, { seed: 1 }));
    assert.ok(disposed >= 1, 'the code brain points are disposed on the switch');
    assert.equal(v.ringGroup.visible, false);
    assert.equal(labelsIn().length, 3);
    v.setGraph(graph, orbit.orbitLayout(graph));
    assert.equal(labelsIn().length, 0, 'the OS labels are removed on the way back');
    assert.equal(v.ringGroup.visible, true, 'the ring comes back in the code brain');
    assert.equal(v.vizGraph, null);
    assert.ok(v.corePoints.geometry !== oldGeo);
  });

  it('setViz with the same objects is a no-op; a theme change restyles the labels', () => {
    const v = make({ reducedMotion: true });
    const viz = vizSample();
    const layout = orbit.vizLayout(viz, { seed: 1 });
    v.setViz(viz, layout);
    const first = v.corePoints;
    v.setViz(viz, layout);
    assert.equal(v.corePoints, first);
    v.setTheme('light');
    assert.equal(labelsIn()[0].style.color, '#1c2230');
    v.setTheme('dark');
    assert.equal(labelsIn()[0].style.color, '#f2f4f8');
  });

  it('getCamera and setCamera round-trip a pose, and a non-finite pose is ignored', () => {
    const v = make({ reducedMotion: true });
    const viz = vizSample();
    v.setViz(viz, orbit.vizLayout(viz, { seed: 1 }));
    const home = v.getCamera();
    assert.equal(home.position.length, 3);
    const pose = { position: [home.position[0] + 2, home.position[1], home.position[2]], target: home.target };
    v.setCamera(pose);
    const back = v.getCamera();
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back.position[i] - pose.position[i]) < 1e-6);
    v.setCamera({ position: [NaN, 0, 0], target: [0, 0, 0] });
    assert.deepEqual(v.getCamera().position, back.position, 'a non-finite pose changes nothing');
  });
});
