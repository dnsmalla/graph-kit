// Types for the generic graphs the OS view draws: the whole OS (`os`) and one graph per
// part (`hubs`). They mirror rust/os-graph/src/viz.rs (VizGraph, VizNode, VizEdge, OsView)
// and the code part's CodeSummary. The core builds them (src/wasm); the page only reads them.
import type { OsRoutine, OsSkill, OsSnapshot } from './types';

/** Status of a node: a tint on the point and a chip in the details card. null = no status. */
export type VizStatus = 'ok' | 'warn' | 'off' | 'running' | 'unknown';

export interface VizNode {
  id: string;
  label: string;
  /** hub, codeCluster, sourceKind, memoryRepo, skill, skillSource, model, provider, caller, endpoint, chatTurn, agentRun, liveSession, routine, kit, feature, check, activity, ... */
  kind: string;
  /** The layout community: the hub's index at the OS level, a family within a hub. */
  group: number;
  /** 1 is normal; hubs are larger; models and sources scale with their weight. */
  size: number;
  /** Whether the page draws a text label for the node. */
  labelled: boolean;
  /** The hub key to open (`code`, `knowledge`, ...). Only hub nodes have one. */
  drill: string | null;
  status: VizStatus | null;
  /** Small facts for the details card: counts, tokens, schedule, path, ... */
  meta: Record<string, unknown>;
}

export interface VizEdge {
  source: string;
  target: string;
  /** member, requires, relates, source, provides, indexes. */
  kind: string;
  weight: number;
  /** Short text for the edge when the data gives one. */
  label?: string;
}

export interface VizGraph {
  /** `os`, or a hub key. */
  level: string;
  title: string;
  nodes: VizNode[];
  edges: VizEdge[];
}

/** The `{os, hubs}` pair build_os_view_json returns. `hubs` has every hub except `code`. */
export interface OsView {
  os: VizGraph;
  hubs: Record<string, VizGraph>;
}

/** Per-community summary of the code graph (the largest communities only). */
export interface CodeCommunity {
  index: number;
  size: number;
  dominantCategory: string;
  topLabels: string[];
}

/** The code part of the OS view, summarised from the project's SystemGraph (code_summary_json). */
export interface CodeSummary {
  totalNodes: number;
  keptNodes: number;
  communityCount: number;
  communities: CodeCommunity[];
}

/** Input of build_os_view_json. Every field is optional on the wire; null is an empty input. */
export interface OsViewInput {
  snapshot: OsSnapshot | null;
  skills: OsSkill[];
  routines: OsRoutine[];
  code: CodeSummary | null;
}

/** Hub keys in display order. `code` is the project's SystemGraph; the rest are VizGraphs. */
export const HUB_KEYS = ['code', 'knowledge', 'memory', 'skills', 'models', 'agents', 'routines', 'kits'] as const;
export type HubKey = (typeof HUB_KEYS)[number];

/** The titles of the hubs, as the core names them. */
export const HUB_TITLES: Record<HubKey, string> = {
  code: 'Code',
  knowledge: 'Knowledge',
  memory: 'Memory',
  skills: 'Skills',
  models: 'Models',
  agents: 'Agents',
  routines: 'Routines',
  kits: 'Kits',
};

export function isHubKey(value: unknown): value is HubKey {
  return typeof value === 'string' && (HUB_KEYS as readonly string[]).includes(value);
}

/** Where the brain is: the whole OS, or one part (`code` is the project's own graph). */
export type ViewLevel = { level: 'os' } | { level: 'hub'; hub: HubKey };

/** A camera pose as plain numbers: what the view remembers per level. */
export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

/** The key a level's camera is remembered under. */
export function levelKey(view: ViewLevel): string {
  return view.level === 'os' ? 'os' : `hub:${view.hub}`;
}

/** The hub a node opens, if it opens one. */
export function drillOf(node: VizNode): HubKey | null {
  return isHubKey(node.drill) ? node.drill : null;
}
