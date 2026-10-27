// The one place the page calls the System view's pure core (buildSystemGraph and
// orbitLayout). The core is the Rust crate rust/os-graph, run as embedded WASM (./wasm);
// only this file and ./wasm change when the core does.
//
// The view is split in two so a change-feed refresh never rebuilds the project:
//   - computeCore(project): the project's nodes, edges and their 3D layout. It
//     depends on the project alone, so it is memoised on that identity.
//   - computeRing(snapshot): the recent-activity ring. Cheap (at most 24 items),
//     memoised on the ring's ids, times and labels, so identical activity gives
//     the same object.
import type { CGData } from '../../typescript/src/models';
import type {
  OrbitLayout,
  SystemGraph,
  SystemRingItem,
  Vec3,
} from '../../typescript/src/system/types';
import { buildSystemGraph, orbitLayout } from './wasm';
import type { OsSnapshot } from './types';

/** Hard caps the page applies. A caller can ask for less, never for more. */
export const SYSTEM_VIEW_LIMITS = { maxCoreNodes: 4000, maxRingItems: 24 } as const;

/** Seed of the orbit layout. Fixed so the same project always lays out the same way. */
const LAYOUT_SEED = 1;

export type CoreView = { graph: SystemGraph; layout: OrbitLayout };
export type RingView = { items: SystemRingItem[]; positions: Map<string, Vec3> };
export type SystemViewOptions = { maxCoreNodes?: number; maxRingItems?: number };

const EMPTY_GRAPH: SystemGraph = {
  core: [],
  edges: [],
  ring: [],
  truncated: { totalNodes: 0, keptNodes: 0, keptCommunities: 0 },
};

/** The core of "no project" (also what the page shows when drawing the project fails). */
export const EMPTY_CORE_VIEW: CoreView = {
  graph: EMPTY_GRAPH,
  layout: { core: new Map(), ring: new Map(), communityCenters: [], bounds: { radius: 0 } },
};

/** The ring of "no activity". */
export const EMPTY_RING_VIEW: RingView = { items: [], positions: new Map() };

function capped(value: number | undefined, cap: number): number {
  if (value === undefined || !Number.isFinite(value)) return cap;
  return Math.min(Math.max(0, Math.floor(value)), cap);
}

type CoreMemo = { project: CGData | null; maxCoreNodes: number; view: CoreView };

/** Single-slot memo: the page draws one project at a time. */
let coreMemo: CoreMemo | null = null;

/**
 * The project's core for the brain: nodes, edges and layout, with an empty ring.
 * Memoised by the identity of `project` (and the node cap): a refresh that only
 * changes the activity returns the same object and the orbit does not rebuild.
 */
export function computeCore(
  project: CGData | null,
  opts: SystemViewOptions = {},
): CoreView {
  const maxCoreNodes = capped(opts.maxCoreNodes, SYSTEM_VIEW_LIMITS.maxCoreNodes);
  if (coreMemo && coreMemo.project === project && coreMemo.maxCoreNodes === maxCoreNodes) {
    return coreMemo.view;
  }
  const graph = buildSystemGraph(null, project, { maxCoreNodes, maxRingItems: 0 });
  const layout = orbitLayout(graph, { seed: LAYOUT_SEED });
  const view: CoreView = { graph, layout };
  coreMemo = { project, maxCoreNodes, view };
  return view;
}

type RingMemo = { key: string; view: RingView };

let ringMemo: RingMemo | null = null;

/** The ring's identity: every field the orbit and the recent list read. */
function ringKey(items: SystemRingItem[]): string {
  return items.map((item) => [item.id, item.at, item.label, item.kind].join('\u0001')).join('\u0002');
}

/**
 * The recent-activity ring for a snapshot. Ring positions depend only on the
 * ring's item count and order, so they are laid out on a ring-only graph. The
 * same ring (same ids, times, labels and kinds) returns the same object.
 */
export function computeRing(
  snapshot: OsSnapshot | null,
  opts: SystemViewOptions = {},
): RingView {
  const maxRingItems = capped(opts.maxRingItems, SYSTEM_VIEW_LIMITS.maxRingItems);
  const items = buildSystemGraph(snapshot, null, { maxCoreNodes: 0, maxRingItems }).ring;
  const key = `${maxRingItems}\u0003${ringKey(items)}`;
  if (ringMemo && ringMemo.key === key) return ringMemo.view;
  const ringOnly: SystemGraph = { ...EMPTY_GRAPH, ring: items };
  const layout = orbitLayout(ringOnly, { seed: LAYOUT_SEED });
  const view: RingView = { items, positions: layout.ring };
  ringMemo = { key, view };
  return view;
}
