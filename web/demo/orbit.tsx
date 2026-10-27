// Demo for the orbit "brain" view: a synthetic 3000-node project graph in 8
// clusters (all categories present) plus a 16-item activity snapshot. Every
// value is generated; nothing here comes from a real project.
import { createRoot } from 'react-dom/client';
import type { CGData, CGEdge, CGNode, CGNodeKind } from '../../typescript/src/models';
import { buildSystemGraph, orbitLayout, type OsSnapshot } from '../../typescript/src/system/index';
import { OrbitPanel } from '../src/orbit/index';
import { fixtureSnapshot } from './fixture';

const NODE_COUNT = 3000;
const CLUSTERS = 8;
const EDGES_PER_NODE = 3;

/** Small deterministic PRNG so the demo looks the same on every load. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One node per index; the kind/path mix cycles so every category is produced. */
function makeNode(i: number, cluster: number): CGNode {
  const mod = i % 10;
  const base = `c${cluster}-${i}`;
  if (mod < 6) {
    return { id: base, title: `fn${i}`, kind: 'function' as CGNodeKind, metadata: { source_file: `src/module${cluster}/file${i % 40}.ts` } };
  }
  if (mod === 6) {
    return { id: base, title: `doc${i}`, kind: 'docPage' as CGNodeKind, metadata: { source_file: `docs/area${cluster}/page${i}.md` } };
  }
  if (mod === 7) {
    return { id: base, title: `spec${i}`, kind: 'symbol' as CGNodeKind, metadata: { source_file: `tests/module${cluster}/case${i}.test.ts` } };
  }
  if (mod === 8) {
    return { id: base, title: `decision${i}`, kind: 'noteDecision' as CGNodeKind, metadata: {} };
  }
  return { id: base, title: `skill${i}`, kind: 'skill' as CGNodeKind, metadata: {} };
}

function buildProject(): CGData {
  const rand = rng(42);
  const nodes: CGNode[] = [];
  const clusterOf: number[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    const cluster = Math.floor(rand() * CLUSTERS);
    clusterOf.push(cluster);
    nodes.push(makeNode(i, cluster));
  }
  const byCluster: number[][] = Array.from({ length: CLUSTERS }, () => []);
  clusterOf.forEach((c, i) => byCluster[c]!.push(i));

  const edges: CGEdge[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    for (let k = 0; k < EDGES_PER_NODE; k++) {
      // Mostly intra-cluster, with a cross-cluster edge about one time in five.
      const crossCluster = rand() < 0.2;
      const pool = crossCluster ? null : byCluster[clusterOf[i]!]!;
      const j = pool ? pool[Math.floor(rand() * pool.length)]! : Math.floor(rand() * NODE_COUNT);
      if (j === i) continue;
      edges.push({ fromId: nodes[i]!.id, toId: nodes[j]!.id, kind: 'imports', confidence: 'EXTRACTED' });
    }
  }
  return { nodes, edges, layers: [], tour: [] };
}

const KINDS = ['function', 'merge', 'graph', 'skill', 'note', 'memory', 'loop', 'review'] as const;

/** A 16-item activity snapshot on top of the fixture (newest first). */
function buildSnapshot(): OsSnapshot {
  const base = Date.parse('2026-10-27T09:00:00Z');
  const items = Array.from({ length: 16 }, (_, i) => ({
    id: 1000 - i,
    kind: KINDS[i % KINDS.length]!,
    title: `Demo activity ${16 - i}`,
    detail: null,
    link: null,
    createdAt: new Date(base - i * 9 * 60_000).toISOString(),
  }));
  return { ...fixtureSnapshot, activity: { ...fixtureSnapshot.activity, items } } as unknown as OsSnapshot;
}

const project = buildProject();
const snapshot = buildSnapshot();
const graph = buildSystemGraph(snapshot, project, { maxCoreNodes: 4000, maxRingItems: 24 });
const layout = orbitLayout(graph, { seed: 1 });

const root = document.getElementById('root');
if (!root) throw new Error('Orbit demo: #root is missing from demo/orbit.html');
createRoot(root).render(
  <>
    <OrbitPanel graph={graph} layout={layout} onSelect={(item) => console.info('select', item)} />
    <div className="orbit-caption">Demo: synthetic graph, {graph.core.length} core nodes, {graph.ring.length} ring items</div>
  </>,
);
