// The one place the page calls the System view's pure core (buildSystemGraph and
// orbitLayout). The core is TypeScript today; the Rust crate (rust/os-graph) will
// replace it behind WASM, and only this file changes when that lands.
import type { CGData } from '../../typescript/src/models';
import { buildSystemGraph, orbitLayout, type OrbitLayout, type SystemGraph } from '../../typescript/src/system/index';
import type { OsSnapshot } from './types';

/** Hard caps the page applies. A caller can ask for less, never for more. */
export const SYSTEM_VIEW_LIMITS = { maxCoreNodes: 4000, maxRingItems: 24 } as const;

/** Seed of the orbit layout. Fixed so the same project always lays out the same way. */
const LAYOUT_SEED = 1;

export type SystemView = { graph: SystemGraph; layout: OrbitLayout };

export type SystemViewOptions = { maxCoreNodes?: number; maxRingItems?: number };

type Memo = {
  activity: unknown;
  project: CGData | null;
  maxCoreNodes: number;
  maxRingItems: number;
  view: SystemView;
};

/** Single-slot memo: the page renders one view at a time. */
let memo: Memo | null = null;

function capped(value: number | undefined, cap: number): number {
  if (value === undefined || !Number.isFinite(value)) return cap;
  return Math.min(Math.max(0, Math.floor(value)), cap);
}

/**
 * The brain view for one snapshot and one project. Memoised by the identity of
 * `snapshot.activity` and of `project` (and the caps): a re-render with the same
 * inputs returns the same object, so the orbit panel does not rebuild its scene.
 */
export function computeSystemView(
  snapshot: OsSnapshot | null,
  project: CGData | null,
  opts: SystemViewOptions = {},
): SystemView {
  const maxCoreNodes = capped(opts.maxCoreNodes, SYSTEM_VIEW_LIMITS.maxCoreNodes);
  const maxRingItems = capped(opts.maxRingItems, SYSTEM_VIEW_LIMITS.maxRingItems);
  const activity = snapshot ? snapshot.activity : null;
  if (
    memo &&
    memo.activity === activity &&
    memo.project === project &&
    memo.maxCoreNodes === maxCoreNodes &&
    memo.maxRingItems === maxRingItems
  ) {
    return memo.view;
  }
  const graph = buildSystemGraph(snapshot, project, { maxCoreNodes, maxRingItems });
  const layout = orbitLayout(graph, { seed: LAYOUT_SEED });
  const view = { graph, layout };
  memo = { activity, project, maxCoreNodes, maxRingItems, view };
  return view;
}
