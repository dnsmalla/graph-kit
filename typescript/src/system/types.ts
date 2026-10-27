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
