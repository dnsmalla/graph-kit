// Structural types for the "Agentic OS" system view. `OsSnapshot` mirrors the
// `GET /kb/os/state` response of the LLM-IDE server (extension/src/lib/api-types.ts,
// GetKbOsStateResponse200). Keep it shape-identical: a server response must stay
// assignable to OsSnapshot.

/** How to stop an item: method and path of the existing route, and the JSON body to send. null for an item with no cancel route (a live capture session). */
export type OsCancel = {
  method?: "POST";
  path?: "/agent/v2/cancel" | "/kb/agent/stop";
  body?: {
    chatSessionId?: string;
    sessionId?: string;
  };
} | null;

export type OsKitStatus = {
  id: string;
  /** The LLMIDE_FEATURES keys this kit depends on; empty = always on. */
  requires: string[];
  enabled: boolean;
};

export type OsUsageCounts = {
  calls: number;
  runs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  billable: number;
};

/** Response of `GET /kb/os/state`. */
export interface OsSnapshot {
  /** ISO 8601 time the aggregate was built. */
  generatedAt: string;
  /** SERVER_API_VERSION of this server. */
  apiVersion: number;
  system: {
    /** The sorted enabled LLMIDE_FEATURES keys, or null when every feature is on. */
    features: string[] | null;
    kits: OsKitStatus[];
    /** Same as /health: ok when the DB, the Claude CLI and the skills checks all pass. */
    status: "ok" | "degraded";
    checks: {
      db: boolean;
      claude: boolean;
      claudeError?: string;
      skills: boolean;
      skillsError?: string;
    };
  };
  running: {
    /** This user's v2 chat turns running now (the in-process turn lock). Cancel: POST /agent/v2/cancel. */
    chatTurns: {
      chatSessionId: string;
      startedAt: string;
      cancel: OsCancel;
    }[];
    /** This user's meeting-agent runs attached to a capture session. Cancel: POST /kb/agent/stop. */
    meetingAgentRuns: ({
      sessionId: string;
      planId: string | null;
      startedAt: string | null;
      lastTickAt: string | null;
      cancel: OsCancel;
    })[];
    /** This user's live caption sessions not yet finalized. No cancel route: a session ends when its capture client stops. */
    liveSessions: ({
      sessionId: string;
      meetingTitle: string | null;
      startedAt: string | null;
      lastWrite: string | null;
      captionCount: number;
      /** Always null: a live capture session has no cancel route (it ends when its capture client stops). */
      cancel: null;
    })[];
  };
  activity: {
    /** Activity rows newer than the user's last-seen cursor. */
    unread: number;
    /** Newest first, from the activity table (kb/activity.mjs). */
    items: ({
      id: number;
      kind: string;
      title: string;
      /** The event's structured detail; its keys depend on the kind, so they are not declared. */
      detail: Record<string, unknown> | null;
      link: string | null;
      /** Local time as stored (YYYY-MM-DD HH:MM:SS). */
      createdAt: string;
    })[];
  };
  tokens: {
    window: "day" | "week";
    /** Calendar days in the window: 1 = today since local midnight (same as the daily model-limit cap), 7 = the last 7 days including today. */
    windowDays: 1 | 7;
    /** Window start, server-local time 'YYYY-MM-DD HH:MM:SS' (the usage ledger's format). */
    since: string;
    totals: {
      calls: number;
      runs: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      billable: number;
    };
    byModel: {
      calls: number;
      runs: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      billable: number;
      provider: string;
      model: string;
    }[];
    bySource: {
      calls: number;
      runs: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      billable: number;
      /** api, cli or auto-task. */
      source: string;
    }[];
    byEndpoint: ({
      calls: number;
      runs: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      billable: number;
      /** null when the row recorded no endpoint. */
      endpoint: string | null;
    })[];
    /** Averages over the caller's newest 50 v2 turns (turn_composition, kb/turn-composition.mjs). All are chars/4 estimates of LLM-IDE text except avgFirstCallPromptTokens, which is the first API call's real prompt size (input + cache write + cache read). Prefix = system prompt + skills append + LLM-IDE tool definitions; fence = context + memory + skills fences; null when no turn reported the value. */
    turnComposition: {
      turns: number;
      avgFirstCallPromptTokens: number | null;
      avgPrefixTokens: number | null;
      avgFenceTokens: number | null;
      avgToolResultTokens: number | null;
    };
  };
  knowledge: {
    sources: {
      total: number;
      byKind: ({
        kind: string;
        count: number;
        lastIndexedAt: string | null;
      })[];
    };
    meetings: {
      count: number;
    };
    /** review_items with status pending. */
    pendingReviews: number;
    outcomes: {
      total: number;
      terminal: number;
      /** Row count per outcome state (open, merged, closed, ...). */
      byState: Record<string, number>;
    };
    /** Freshness of each code graph this user has uploaded. */
    codeGraph: ({
      repoId: string;
      commitSha: string | null;
      generatedAt: string | null;
    })[];
    /** Per repo, the project-memory ledger facts (kb/memory-ledger.mjs): active and superseded counts. */
    projectMemory: ({
      repoRoot: string;
      facts: number;
      active: number;
      superseded: number;
      lastConfirmedAt: string | null;
    })[];
  };
  /** Kits the server cannot see yet; shown from the Mac app (the v1 gap). */
  macOnly: {
    loop: "on this Mac";
    autoTasks: "on this Mac";
  };
}

/** One entry of `OsSnapshot.activity.items`. */
export type OsActivityItem = OsSnapshot["activity"]["items"][number];

/** Connection state of the live OS event stream. */
export type OsLiveStatus = "idle" | "connecting" | "live" | "reconnecting" | "stopped";

/** A skill shown in the OS view. */
export type OsSkill = { id: string; name: string; description?: string; source?: string };

/** A scheduled routine shown in the OS view. */
export type OsRoutine = {
  id: string;
  title: string;
  schedule?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  enabled: boolean;
};

// ---- OS graph core: types only. The implementation is the Rust crate rust/os-graph,
// run in the web page as embedded WASM (web/src/wasm). The TypeScript package keeps
// these declarations so hosts can type what the core returns. ----

export type CoreCategory = "code" | "docs" | "tests" | "knowledge" | "other";

export interface SystemCoreNode {
  id: string;
  /** Absent when the node has no string title (the Rust core leaves it out). Hosts fall back to the id. */
  label?: string;
  category: CoreCategory;
  /** Index into the community ordering: 0 = largest community. */
  community: number;
  /** Weighted degree within the kept graph. */
  degree: number;
  /** The file the node is in (absent when it is in no file). Mirrors rust/os-graph SystemCoreNode.path. */
  path?: string;
  /** The node's kind as the code graph has it (`file`, `function`, ...). Absent when empty. */
  kind?: string;
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

export interface Vec3 { x: number; y: number; z: number; }

export interface OrbitOptions {
  /** Radius of the core sphere. Default 100. */
  coreRadius?: number;
  /** Radius of the activity ring (plane y = 0). Default 170. */
  ringRadius?: number;
  /** Relaxation steps over the core. Default 60. */
  iterations?: number;
  /** PRNG seed for the initial scatter. Default 1. */
  seed?: number;
}

export interface OrbitLayout {
  /** Every core node id -> position (keyed by the original node ids). */
  core: Map<string, Vec3>;
  /** Every ring item id -> position. */
  ring: Map<string, Vec3>;
  /**
   * Index = COMPACTED community index, not the raw `SystemCoreNode.community`
   * value. The distinct community values present in the core are mapped to
   * 0..k-1 in ascending order, so a sparse value such as 1e9 costs nothing.
   */
  communityCenters: Vec3[];
  /** Max distance from the origin of any core or ring point (0 when empty). */
  bounds: { radius: number };
}
