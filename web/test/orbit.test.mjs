// Orbit (K4) tests: `npm test`. The pure scene helpers and the OrbitPanel
// component load through Vite's SSR loader, like web.test.mjs. three.js is
// never drawn here (Node has no WebGL); the panel's effect does not run in SSR.
import { after, before, describe, it } from 'node:test';
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
