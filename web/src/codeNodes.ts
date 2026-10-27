// Helpers for one code node: the links it has to other nodes (directed, from the project's own
// edges, since the core's edges are collapsed and undirected), the largest node of a cluster, and
// the core node index. Pure; the lookups are memoised on the array they read, so a redraw is cheap.
import type { SystemCoreNode } from '../../typescript/src/system/types';

/** Most neighbours a list shows before its "+N more". */
export const LINK_LIST_CAP = 12;

/** A project edge as the links read it. */
export interface LinkEdge {
  fromId: string;
  toId: string;
}

/** Each node's outgoing and incoming neighbours (ids, unique, in the order the edges give). */
export interface LinkIndex {
  out: Map<string, string[]>;
  inc: Map<string, string[]>;
}

const linkMemo = new WeakMap<readonly LinkEdge[], LinkIndex>();

/** The directed links of a project's edges, memoised on the edges array. */
export function linkIndex(edges: readonly LinkEdge[]): LinkIndex {
  const hit = linkMemo.get(edges);
  if (hit) return hit;
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.fromId === edge.toId) continue;
    const key = `${edge.fromId}\u0001${edge.toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    push(out, edge.fromId, edge.toId);
    push(inc, edge.toId, edge.fromId);
  }
  const index = { out, inc };
  linkMemo.set(edges, index);
  return index;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const coreMemo = new WeakMap<readonly SystemCoreNode[], Map<string, SystemCoreNode>>();

/** The core nodes by id, memoised on the core array. */
export function coreById(nodes: readonly SystemCoreNode[]): Map<string, SystemCoreNode> {
  const hit = coreMemo.get(nodes);
  if (hit) return hit;
  const map = new Map<string, SystemCoreNode>();
  for (const node of nodes) if (!map.has(node.id)) map.set(node.id, node);
  coreMemo.set(nodes, map);
  return map;
}

/** A neighbour as a list row: a node that is drawn in the core (so it can be selected). */
export interface Neighbour {
  id: string;
  label: string;
  category: SystemCoreNode['category'];
}

/** One direction's list: up to `cap` drawn neighbours and how many more there are. */
export interface NeighbourList {
  items: Neighbour[];
  more: number;
  /** Every drawn neighbour in this direction. */
  total: number;
}

function labelOf(node: SystemCoreNode): string {
  return node.label && node.label.length > 0 ? node.label : node.id;
}

/**
 * The "Depends on" (outgoing) and "Used by" (incoming) lists of a node. Only neighbours that are
 * drawn in the core are listed (a trimmed-away node cannot be selected), sorted by label then id.
 */
export function linksOf(
  index: LinkIndex,
  nodeId: string,
  core: readonly SystemCoreNode[],
  cap: number = LINK_LIST_CAP,
): { dependsOn: NeighbourList; usedBy: NeighbourList } {
  const drawn = coreById(core);
  const list = (ids: string[] | undefined): NeighbourList => {
    const rows: Neighbour[] = [];
    for (const id of ids ?? []) {
      const node = drawn.get(id);
      if (node) rows.push({ id, label: labelOf(node), category: node.category });
    }
    rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { items: rows.slice(0, cap), more: Math.max(0, rows.length - cap), total: rows.length };
  };
  return { dependsOn: list(index.out.get(nodeId)), usedBy: list(index.inc.get(nodeId)) };
}

/** The core node a cluster's click explores: the highest-degree node of community `community`, or null. */
export function largestInCommunity(core: readonly SystemCoreNode[], community: number): SystemCoreNode | null {
  let best: SystemCoreNode | null = null;
  for (const node of core) {
    if (node.community !== community) continue;
    if (!best || node.degree > best.degree || (node.degree === best.degree && node.id < best.id)) best = node;
  }
  return best;
}
