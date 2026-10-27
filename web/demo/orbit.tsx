// Demo for the orbit "brain" view: the shared synthetic project graph from
// demo/fixture.ts (every value is generated) plus a 16-item activity snapshot.
// The core and the ring come from systemGraph.ts, the same path the page uses.
import { createRoot } from 'react-dom/client';
import { OrbitPanel } from '../src/orbit/index';
import { computeCore, computeRing, SYSTEM_VIEW_LIMITS } from '../src/systemGraph';
import type { OsSnapshot } from '../src/types';
import { buildDemoProjectGraph, fixtureSnapshot } from './fixture';

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

const core = computeCore(buildDemoProjectGraph(), SYSTEM_VIEW_LIMITS);
const ring = computeRing(buildSnapshot(), SYSTEM_VIEW_LIMITS);

const root = document.getElementById('root');
if (!root) throw new Error('Orbit demo: #root is missing from demo/orbit.html');
createRoot(root).render(
  <>
    <OrbitPanel
      core={core}
      ring={ring}
      onSelect={(item) => console.info('select', item)}
    />
    <div className="orbit-caption">
      Demo: synthetic graph, {core.graph.core.length} core nodes, {ring.items.length} ring items
    </div>
  </>,
);
