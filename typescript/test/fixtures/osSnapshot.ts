import type { OsSnapshot } from "../../src/system/types.js";

/** Minimal, fully-typed OsSnapshot literal used by the system builder tests. */
export function osSnapshotFixture(): OsSnapshot {
  return {
    generatedAt: "2026-10-27T00:00:00Z",
    apiVersion: 75,
    system: {
      features: null,
      kits: [{ id: "chat", requires: [], enabled: true }],
      status: "ok",
      checks: { db: true, claude: true, skills: true },
    },
    running: { chatTurns: [], meetingAgentRuns: [], liveSessions: [] },
    activity: {
      unread: 0,
      items: [
        { id: 3, kind: "chat", title: "Third", detail: null, link: null, createdAt: "2026-10-27 09:03:00" },
        { id: 2, kind: "loop", title: "Second", detail: { ok: true }, link: "/x", createdAt: "2026-10-27 09:02:00" },
        { id: 1, kind: "ingest", title: "First", detail: null, link: null, createdAt: "2026-10-27 09:01:00" },
      ],
    },
    tokens: {
      window: "day",
      windowDays: 1,
      since: "2026-10-27 00:00:00",
      totals: { calls: 0, runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billable: 0 },
      byModel: [],
      bySource: [],
      byEndpoint: [],
      turnComposition: { turns: 0, avgFirstCallPromptTokens: null, avgPrefixTokens: null, avgFenceTokens: null, avgToolResultTokens: null },
    },
    knowledge: {
      sources: { total: 0, byKind: [] },
      meetings: { count: 0 },
      pendingReviews: 0,
      outcomes: { total: 0, terminal: 0, byState: {} },
      codeGraph: [],
      projectMemory: [],
    },
    macOnly: { loop: "on this Mac", autoTasks: "on this Mac" },
  };
}
