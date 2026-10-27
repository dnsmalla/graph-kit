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
import { buildSystemGraph, initOsGraphAsync, orbitLayout, osGraphStatus } from './wasm';
import type { OsGraphStatus } from './wasm';
import type { OsSnapshot } from './types';

export { osGraphReady, osGraphStatus } from './wasm';
export type { OsGraphStatus } from './wasm';

/**
 * Starts loading the core (off the synchronous path) and resolves once it has settled: ready,
 * or failed. Never rejects; read osGraphStatus() afterwards. Idempotent. The page calls this
 * on mount, so the brain can show its loading state until the core is instantiated.
 */
export function whenOsGraphReady(): Promise<void> {
  return initOsGraphAsync().catch(() => undefined);
}

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

/** What the brain draws: the core and ring, or the empty views with a flag saying why. */
export type DrawnViews = {
  core: CoreView;
  ring: RingView;
  /** The core threw (a bad graph or a crashed core). The brain says it could not draw. */
  drawFailed: boolean;
  /** The core is still compiling. The brain shows its loading state, not a failure. */
  loading: boolean;
};

/** The two calls drawViews makes; a parameter so tests can make one of them throw. */
export type DrawDeps = {
  computeCore: (project: CGData | null, opts: SystemViewOptions) => CoreView;
  computeRing: (snapshot: OsSnapshot | null, opts: SystemViewOptions) => RingView;
};

const REAL_DRAW: DrawDeps = { computeCore, computeRing };

/**
 * The brain's two inputs. The core depends on the project alone and the ring on the activity,
 * so a change refresh rebuilds only the ring. While the core is compiling the result is the
 * loading state; a throw from either call is the failed state. Neither escapes as an exception.
 * The caller passes osGraphStatus() implicitly: the result changes once the core is ready.
 */
export function drawViews(
  project: CGData | null,
  snapshot: OsSnapshot | null,
  deps: DrawDeps = REAL_DRAW,
): DrawnViews {
  if (osGraphStatus() === 'loading') {
    return { core: EMPTY_CORE_VIEW, ring: EMPTY_RING_VIEW, drawFailed: false, loading: true };
  }
  try {
    return {
      core: deps.computeCore(project, SYSTEM_VIEW_LIMITS),
      ring: deps.computeRing(snapshot, SYSTEM_VIEW_LIMITS),
      drawFailed: false,
      loading: false,
    };
  } catch {
    return { core: EMPTY_CORE_VIEW, ring: EMPTY_RING_VIEW, drawFailed: true, loading: false };
  }
}
