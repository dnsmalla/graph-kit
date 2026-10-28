// Types for the generic graphs the OS view draws: the whole OS (`os`) and one graph per
// part (`hubs`). They mirror rust/os-graph/src/viz.rs (VizGraph, VizNode, VizEdge, OsView)
// and the code part's CodeSummary. The core builds them (src/wasm); the page only reads them.
import type { OsRoutine, OsSkill, OsSnapshot } from './types';

/** Status of a node: a tint on the point and a chip in the details card. null = no status. */
export type VizStatus = 'ok' | 'warn' | 'off' | 'running' | 'unknown';

export interface VizNode {
  id: string;
  label: string;
  /** hub, codeCluster, sourceKind, memoryRepo, skill, skillSource, model, provider, caller, endpoint, chatTurn, agentRun, liveSession, recentRun, routine, kit, feature, check, activity, storage, ... */
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
export const HUB_KEYS = ['code', 'knowledge', 'memory', 'skills', 'models', 'agents', 'routines', 'kits', 'activity', 'storage'] as const;
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
  activity: 'Activity',
  storage: 'Storage',
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

/** A click or double-click on a hub that just opened its part is the same gesture: it is swallowed. */
export const DRILL_GUARD_MS = 350;

/** The guard a drill leaves: the hub's node id and the time (ms) until which that id is swallowed. */
export interface DrillGuard {
  id: string;
  until: number;
}

/** True when a pick of `id` at time `now` is the trailing part of the drill `guard` came from. Other picks pass. */
export function swallowsPick(guard: DrillGuard | null, id: string, now: number): boolean {
  return guard !== null && guard.id === id && now < guard.until;
}

// ---- Colour by part: which hub a VizGraph node kind belongs to ----------------------

/**
 * The hub a VizGraph node kind belongs to: its colour is that hub's hue (the native graph's
 * per-part colours, see orbit/scene.ts HUB_HUE). A hub node is coloured by its own hub (its
 * `drill` key, or the level it is drawn in) and is not in this table.
 *
 *   code        codeCluster
 *   knowledge   sourceKind
 *   memory      memoryRepo
 *   skills      skill, skillSource
 *   models      model, provider, caller, endpoint
 *   agents      chatTurn, agentRun, liveSession, recentRun
 *   routines    routine
 *   kits        kit, feature, check
 *   activity    activity
 *   storage     storage
 *
 * `group` rows and any kind not listed here have no hub and draw in the neutral grey.
 */
export const KIND_HUB: Record<string, string> = {
  codeCluster: 'code',
  sourceKind: 'knowledge',
  memoryRepo: 'memory',
  skill: 'skills',
  skillSource: 'skills',
  model: 'models',
  provider: 'models',
  caller: 'models',
  endpoint: 'models',
  chatTurn: 'agents',
  agentRun: 'agents',
  liveSession: 'agents',
  recentRun: 'agents',
  routine: 'routines',
  kit: 'kits',
  feature: 'kits',
  check: 'kits',
  activity: 'activity',
  storage: 'storage',
};

/**
 * A member's lightness within its hub's hue, by kind: positive lightens toward white, negative
 * darkens toward black. Keeps the members of one part visibly related but not identical.
 */
export const KIND_SHADE: Record<string, number> = {
  feature: 0.15,
  check: 0.15,
  endpoint: 0.1,
  provider: 0.1,
  caller: -0.1,
  sourceKind: -0.1,
  skillSource: -0.2,
  memoryRepo: 0,
};

/** The hub key a node kind belongs to (see KIND_HUB), or null for a kind with no hub. */
export function hubOf(kind: string): string | null {
  return Object.prototype.hasOwnProperty.call(KIND_HUB, kind) ? KIND_HUB[kind]! : null;
}
