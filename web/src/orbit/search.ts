// Type-ahead search over the core nodes of a SystemGraph. Pure, so the search box
// and its tests share one ranking: label prefix, then label substring, then id substring.
import type { CoreCategory, SystemGraph } from "../../../typescript/src/system/index.js";
import { uniqueCoreNodes } from "./scene";

export interface NodeSearchHit {
  id: string;
  label: string;
  category: CoreCategory;
}

/** Hits shown in the search listbox. */
export const SEARCH_LIMIT = 8;

/**
 * Core nodes whose label or id contains `query` (case-insensitive, trimmed), best matches
 * first, at most `limit`. An empty query matches nothing.
 */
export function searchCoreNodes(graph: SystemGraph | null, query: string, limit = SEARCH_LIMIT): NodeSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!graph || q === "" || limit <= 0) return [];
  const prefix: NodeSearchHit[] = [];
  const inLabel: NodeSearchHit[] = [];
  const inId: NodeSearchHit[] = [];
  for (const node of uniqueCoreNodes(graph)) {
    const label = (node.label ?? node.id).toLowerCase();
    const hit = { id: node.id, label: node.label ?? node.id, category: node.category };
    if (label.startsWith(q)) prefix.push(hit);
    else if (label.includes(q)) inLabel.push(hit);
    else if (node.id.toLowerCase().includes(q)) inId.push(hit);
    else continue;
  }
  return [...prefix, ...inLabel, ...inId].slice(0, limit);
}
