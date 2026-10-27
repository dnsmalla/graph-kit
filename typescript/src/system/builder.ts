// Pure builder for the "Agentic OS" system view: a dense core made from the
// project's code/knowledge graph, plus a ring of recent activity orbiting it.
// No I/O and no dependencies; output is deterministic for a given input.

import type { CGData, CGNode } from "../models.js";
import type { OsSnapshot } from "./types.js";

export type CoreCategory = "code" | "docs" | "tests" | "knowledge" | "other";

export interface SystemCoreNode {
  id: string;
  label: string;
  category: CoreCategory;
  /** Index into the community ordering: 0 = largest community. */
  community: number;
  /** Weighted degree within the kept graph. */
  degree: number;
}

export interface SystemCoreEdge {
  source: string;
  target: string;
  /** Number of original edges collapsed into this one. */
  weight: number;
}

export interface SystemRingItem {
  id: string;
  label: string;
  kind: string;
  at: string;
  link: string | null;
}

export interface SystemGraph {
  core: SystemCoreNode[];
  edges: SystemCoreEdge[];
  ring: SystemRingItem[];
  truncated: { totalNodes: number; keptNodes: number; keptCommunities: number };
}

export interface BuildOptions {
  /** Maximum number of core nodes kept. Default 4000. */
  maxCoreNodes?: number;
  /** Maximum number of ring items. Default 24. */
  maxRingItems?: number;
}

const TEST_PATH = /(^|[\/._-])(test|tests|spec|__tests__)([\/._-]|$)/i;
const DOC_EXT = /\.(md|mdx|txt|rst)$/i;

/** Node kinds that are documentation of the project (not code). */
const DOC_KINDS: ReadonlySet<string> = new Set(["docPage", "memoryDoc", "memoryChunk"]);

/** Node kinds that come from the knowledge base (notes, sources, claims). */
const KNOWLEDGE_KINDS: ReadonlySet<string> = new Set([
  "noteDecision", "noteTask", "noteQuestion", "noteFact", "noteConcept", "notePlaybook",
  "noteHypothesis", "noteEvent", "noteSource", "article", "entity", "topic", "claim",
]);

/** Node kinds that are code structure. Anything in NODE_KINDS not listed here, in
 *  DOC_KINDS, KNOWLEDGE_KINDS, or the `other` kind, is also treated as code. */
const NON_CODE_KINDS: ReadonlySet<string> = new Set(["other", "skill", "agent"]);

function nodePaths(node: CGNode): string[] {
  const m = node.metadata ?? {};
  return [m.source_file, m.source_path, m.path, m.file].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

/**
 * Classify a node into the core category used by the system view. Decided in
 * this order, first match wins:
 *   1. kind: DOC_KINDS → docs, KNOWLEDGE_KINDS → knowledge (the title is never
 *      consulted, so a note called "unit-test plan" stays knowledge);
 *   2. a path (metadata source_file / source_path / path / file, or the id)
 *      ending in a doc extension → docs (so `docs/spec/a.md` is docs, not tests);
 *   3. a path or id matching TEST_PATH → tests (title still ignored);
 *   4. NON_CODE_KINDS → other; anything else → code.
 */
export function categorize(node: CGNode): CoreCategory {
  if (DOC_KINDS.has(node.kind)) return "docs";
  if (KNOWLEDGE_KINDS.has(node.kind)) return "knowledge";
  const locators = [...nodePaths(node), node.id];
  if (locators.some((s) => DOC_EXT.test(s))) return "docs";
  if (locators.some((s) => TEST_PATH.test(s))) return "tests";
  if (NON_CODE_KINDS.has(node.kind)) return "other";
  return "code";
}

/**
 * Deterministic label propagation on the undirected graph. Nodes are visited in
 * sorted-id order; each takes the most frequent neighbour label (ties: smallest
 * label). Runs at most 20 passes or until stable. Communities are renumbered
 * 0..k-1 by descending size (ties by smallest member id).
 */
export function detectCommunities(
  nodeIds: string[],
  edges: { source: string; target: string }[],
): Map<string, number> {
  const ids = [...new Set(nodeIds)].sort();
  const known = new Set(ids);
  const adj = new Map<string, Map<string, number>>();
  for (const id of ids) adj.set(id, new Map());
  for (const e of edges) {
    if (e.source === e.target || !known.has(e.source) || !known.has(e.target)) continue;
    const a = adj.get(e.source)!;
    const b = adj.get(e.target)!;
    a.set(e.target, (a.get(e.target) ?? 0) + 1);
    b.set(e.source, (b.get(e.source) ?? 0) + 1);
  }

  const label = new Map<string, string>(ids.map((id) => [id, id]));
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (const id of ids) {
      const neighbours = adj.get(id)!;
      if (neighbours.size === 0) continue;
      const counts = new Map<string, number>();
      for (const [nb, w] of neighbours) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) ?? 0) + w);
      }
      let best: string | null = null;
      let bestCount = -1;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && best !== null && l < best)) {
          best = l;
          bestCount = c;
        }
      }
      if (best !== null && best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const l = label.get(id)!;
    const g = groups.get(l);
    if (g) g.push(id);
    else groups.set(l, [id]);
  }
  const ordered = [...groups.values()]
    .map((members) => members.sort())
    .sort((x, y) => y.length - x.length || byId(x[0] ?? "", y[0] ?? ""));

  const out = new Map<string, number>();
  ordered.forEach((members, idx) => {
    for (const m of members) out.set(m, idx);
  });
  return out;
}

interface PairEdge { source: string; target: string; weight: number; }

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Collapse parallel edges into unordered pairs; drop self-loops and dangling edges. */
function collapseEdges(nodeIds: Set<string>, edges: CGData["edges"]): PairEdge[] {
  const pairs = new Map<string, PairEdge>();
  for (const e of edges) {
    if (e.fromId === e.toId) continue;
    if (!nodeIds.has(e.fromId) || !nodeIds.has(e.toId)) continue;
    const key = pairKey(e.fromId, e.toId);
    const existing = pairs.get(key);
    if (existing) existing.weight += 1;
    else {
      const [source, target] = e.fromId < e.toId ? [e.fromId, e.toId] : [e.toId, e.fromId];
      pairs.set(key, { source, target, weight: 1 });
    }
  }
  return [...pairs.values()].sort((a, b) => byId(a.source, b.source) || byId(a.target, b.target));
}

/**
 * Build the system view graph. `project` supplies the core (nodes + edges);
 * `snapshot` supplies the ring of recent activity. Either may be null.
 * Capping removes nodes only: every edge between two kept nodes is kept.
 *
 * Cap rule (when there are more than `maxCoreNodes` nodes): communities are
 * walked largest-first and each is kept whole if it fits in the remaining
 * budget; one that does not fit is skipped and the walk continues, so smaller
 * communities later in the order can still fill the core. If the largest
 * community alone exceeds the cap, only its `maxCoreNodes` highest-degree nodes
 * are kept and no other community is. `truncated.keptCommunities` counts the
 * whole communities kept (1 in the partial-trim case, 0 if the cap is 0).
 */
export function buildSystemGraph(
  snapshot: OsSnapshot | null,
  project: CGData | null,
  opts: BuildOptions = {},
): SystemGraph {
  const maxCore = Math.max(0, Math.floor(opts.maxCoreNodes ?? 4000));
  const maxRing = Math.max(0, Math.floor(opts.maxRingItems ?? 24));

  const ring: SystemRingItem[] = (snapshot?.activity.items ?? []).slice(0, maxRing).map((item) => ({
    id: `activity:${item.id}`,
    label: item.title,
    kind: item.kind,
    at: item.createdAt,
    link: item.link,
  }));

  // Dedupe nodes by id (first wins).
  const nodeById = new Map<string, CGNode>();
  for (const n of project?.nodes ?? []) if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  const nodeIds = new Set(nodeById.keys());
  const pairs = collapseEdges(nodeIds, project?.edges ?? []);
  const allIds = [...nodeIds].sort();

  const communityOf = detectCommunities(allIds, pairs);
  // Loop rather than Math.max(...values): spreading >~125k args throws RangeError.
  let maxCommunity = -1;
  for (const c of communityOf.values()) if (c > maxCommunity) maxCommunity = c;
  const communityCount = maxCommunity + 1;
  const totalNodes = allIds.length;

  // Full-graph weighted degree, used to rank nodes when trimming.
  const fullDegree = new Map<string, number>(allIds.map((id) => [id, 0]));
  for (const p of pairs) {
    fullDegree.set(p.source, fullDegree.get(p.source)! + p.weight);
    fullDegree.set(p.target, fullDegree.get(p.target)! + p.weight);
  }

  let kept: Set<string>;
  let keptCommunities: number;
  if (totalNodes <= maxCore) {
    kept = new Set(allIds);
    keptCommunities = communityCount;
  } else {
    // Group members by community (community 0 is largest).
    const members: string[][] = Array.from({ length: communityCount }, () => []);
    for (const id of allIds) members[communityOf.get(id)!]!.push(id);

    kept = new Set();
    keptCommunities = 0;
    const largest = members[0] ?? [];
    if (largest.length > maxCore) {
      // Partial trim: the largest community alone exceeds the cap, so keep its
      // highest-degree nodes and nothing else. Community indices on the core
      // stay the raw detectCommunities numbers (not renumbered).
      const ranked = [...largest].sort(
        (a, b) => fullDegree.get(b)! - fullDegree.get(a)! || byId(a, b),
      );
      for (const id of ranked.slice(0, maxCore)) kept.add(id);
      keptCommunities = kept.size > 0 ? 1 : 0;
    } else {
      // Greedy fill, largest community first: keep each community that fits in
      // the remaining budget and skip (continue past) any that does not, so a
      // large community that no longer fits does not block smaller ones.
      // Community indices on the core are the raw detectCommunities numbers, so
      // they may skip values where a community was dropped.
      for (const group of members) {
        if (kept.size + group.length > maxCore) continue;
        for (const id of group) kept.add(id);
        keptCommunities++;
        if (kept.size === maxCore) break;
      }
    }
  }

  const keptEdges = pairs.filter((p) => kept.has(p.source) && kept.has(p.target));
  const degree = new Map<string, number>([...kept].map((id) => [id, 0]));
  for (const p of keptEdges) {
    degree.set(p.source, degree.get(p.source)! + p.weight);
    degree.set(p.target, degree.get(p.target)! + p.weight);
  }

  const core: SystemCoreNode[] = [...kept].sort(byId).map((id) => {
    const node = nodeById.get(id)!;
    return {
      id,
      label: node.title,
      category: categorize(node),
      community: communityOf.get(id)!,
      degree: degree.get(id)!,
    };
  });

  return {
    core,
    edges: keptEdges.map((p) => ({ source: p.source, target: p.target, weight: p.weight })),
    ring,
    truncated: { totalNodes, keptNodes: kept.size, keptCommunities },
  };
}
