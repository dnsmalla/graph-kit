// Type-ahead search over the nodes the brain draws. Pure, so the search box and its tests
// share one ranking: label prefix, then label substring, then id substring. The project's
// core nodes and the OS graph's nodes both search this way.
import type { CoreCategory, SystemGraph } from "../../../typescript/src/system/index.js";
import type { VizGraph } from "../viz";
import { uniqueCoreNodes } from "./scene";

export interface NodeSearchHit {
  id: string;
  label: string;
  /** The core category (project nodes) or the node kind (OS graph nodes). */
  category: CoreCategory | string;
}

/** Hits shown in the search listbox. */
export const SEARCH_LIMIT = 8;

/** Ranks `items` against `query` (case-insensitive, trimmed): prefix, then label, then id. */
function rank(
  items: Array<{ id: string; label: string; category: CoreCategory | string }>,
  query: string,
  limit: number,
): NodeSearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === "" || limit <= 0) return [];
  const prefix: NodeSearchHit[] = [];
  const inLabel: NodeSearchHit[] = [];
  const inId: NodeSearchHit[] = [];
  for (const item of items) {
    const label = item.label.toLowerCase();
    const hit = { id: item.id, label: item.label, category: item.category };
    if (label.startsWith(q)) prefix.push(hit);
    else if (label.includes(q)) inLabel.push(hit);
    else if (item.id.toLowerCase().includes(q)) inId.push(hit);
  }
  return [...prefix, ...inLabel, ...inId].slice(0, limit);
}

/**
 * Core nodes whose label or id contains `query` (case-insensitive, trimmed), best matches
 * first, at most `limit`. An empty query matches nothing.
 */
export function searchCoreNodes(graph: SystemGraph | null, query: string, limit = SEARCH_LIMIT): NodeSearchHit[] {
  if (!graph) return [];
  return rank(
    uniqueCoreNodes(graph).map((node) => ({ id: node.id, label: node.label ?? node.id, category: node.category })),
    query,
    limit,
  );
}

/** Nodes of an OS-graph VizGraph whose label or id matches `query`; `category` is the node kind. */
export function searchVizNodes(graph: VizGraph | null, query: string, limit = SEARCH_LIMIT): NodeSearchHit[] {
  if (!graph) return [];
  const seen = new Set<string>();
  const items: Array<{ id: string; label: string; category: string }> = [];
  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    items.push({ id: node.id, label: node.label || node.id, category: node.kind });
  }
  return rank(items, query, limit);
}
