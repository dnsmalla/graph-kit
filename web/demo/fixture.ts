import type { CGData, CGEdge, CGNode, CGNodeKind } from "../../typescript/src/models";
import type { OsRoutine, OsSkill, OsSnapshot } from "../src/types";

// Example OsSnapshot for the demo and the tests. Generated from the seeded server
// fixture (schema/http/fixtures/os); every value is example data.
export const fixtureSnapshot: OsSnapshot = {
  "generatedAt": "2026-10-26T13:56:08.696Z",
  "apiVersion": 79,
  "system": {
    "features": null,
    "kits": [
      {
        "id": "os-kit",
        "requires": [],
        "enabled": true
      },
      {
        "id": "knowledge-kit",
        "requires": [],
        "enabled": true
      },
      {
        "id": "agent-kit",
        "requires": [
          "agent_chat"
        ],
        "enabled": true
      },
      {
        "id": "capture-kit",
        "requires": [],
        "enabled": true
      },
      {
        "id": "graph-kit",
        "requires": [
          "code_graph_3d"
        ],
        "enabled": true
      },
      {
        "id": "docs-kit",
        "requires": [
          "doc_gen"
        ],
        "enabled": true
      },
      {
        "id": "work-kit",
        "requires": [
          "gantt_issues"
        ],
        "enabled": true
      },
      {
        "id": "workspace-kit",
        "requires": [
          "file_explorer",
          "terminal"
        ],
        "enabled": true
      },
      {
        "id": "automation-kit",
        "requires": [
          "auto_tasks"
        ],
        "enabled": true
      },
      {
        "id": "sync-kit",
        "requires": [
          "mobile_sync"
        ],
        "enabled": true
      }
    ],
    "status": "ok",
    "checks": {
      "db": true,
      "claude": true,
      "skills": true
    }
  },
  "running": {
    "chatTurns": [
      {
        "chatSessionId": "chat-1",
        "startedAt": "2026-10-26T13:56:08.693Z",
        "cancel": {
          "method": "POST",
          "path": "/agent/v2/cancel",
          "body": {
            "chatSessionId": "chat-1"
          }
        }
      }
    ],
    "meetingAgentRuns": [
      {
        "sessionId": "live-1",
        "planId": null,
        "startedAt": "2026-10-26T13:56:08.695Z",
        "lastTickAt": null,
        "cancel": {
          "method": "POST",
          "path": "/kb/agent/stop",
          "body": {
            "sessionId": "live-1"
          }
        }
      }
    ],
    "liveSessions": [
      {
        "sessionId": "live-1",
        "meetingTitle": "Weekly sync",
        "startedAt": "2026-10-26T13:56:08.694Z",
        "lastWrite": "2026-10-26T13:56:08.695Z",
        "captionCount": 2,
        "cancel": null
      }
    ]
  },
  "activity": {
    "unread": 2,
    "items": [
      {
        "id": 2,
        "kind": "knowledge_updated",
        "title": "Ingested 3 notes",
        "detail": null,
        "link": null,
        "createdAt": "2026-10-26 13:56:08"
      },
      {
        "id": 1,
        "kind": "meeting_added",
        "title": "Weekly sync",
        "detail": {
          "meetingId": "m-1"
        },
        "link": "https://example.com/meeting/m-1",
        "createdAt": "2026-10-26 13:56:08"
      }
    ]
  },
  "tokens": {
    "window": "day",
    "windowDays": 1,
    "since": "2026-10-27 00:00:00",
    "totals": {
      "calls": 2,
      "runs": 2,
      "input": 1200,
      "output": 300,
      "cacheRead": 8000,
      "cacheWrite": 400,
      "billable": 2800
    },
    "byModel": [
      {
        "provider": "anthropic",
        "model": "claude-sonnet-5",
        "calls": 1,
        "runs": 1,
        "input": 1200,
        "output": 300,
        "cacheRead": 8000,
        "cacheWrite": 400,
        "billable": 2800
      },
      {
        "provider": "anthropic",
        "model": "claude-haiku-5-5",
        "calls": 1,
        "runs": 1,
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "billable": 0
      }
    ],
    "bySource": [
      {
        "source": "api",
        "calls": 1,
        "runs": 1,
        "input": 1200,
        "output": 300,
        "cacheRead": 8000,
        "cacheWrite": 400,
        "billable": 2800
      },
      {
        "source": "cli",
        "calls": 1,
        "runs": 1,
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "billable": 0
      }
    ],
    "byEndpoint": [
      {
        "endpoint": "/agent/v2/stream",
        "calls": 1,
        "runs": 1,
        "input": 1200,
        "output": 300,
        "cacheRead": 8000,
        "cacheWrite": 400,
        "billable": 2800
      },
      {
        "endpoint": "/kb/loop/agent-run",
        "calls": 1,
        "runs": 1,
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "billable": 0
      }
    ],
    "turnComposition": {
      "turns": 1,
      "avgFirstCallPromptTokens": 8200,
      "avgPrefixTokens": 3500,
      "avgFenceTokens": 400,
      "avgToolResultTokens": 400
    }
  },
  "knowledge": {
    "sources": {
      "total": 1,
      "byKind": [
        {
          "kind": "code",
          "count": 1,
          "lastIndexedAt": "2026-10-26 13:56:08"
        }
      ]
    },
    "meetings": {
      "count": 0
    },
    "pendingReviews": 1,
    "outcomes": {
      "total": 2,
      "terminal": 1,
      "byState": {
        "merged": 1,
        "open": 1
      }
    },
    "codeGraph": [
      {
        "repoId": "example-repo",
        "commitSha": "abc1234",
        "generatedAt": "2026-10-26 09:00:00"
      }
    ],
    "projectMemory": [
      {
        "repoRoot": "/example/repo",
        "facts": 1,
        "active": 1,
        "superseded": 0,
        "lastConfirmedAt": "2026-10-26 22:56:08"
      }
    ]
  },
  "macOnly": {
    "loop": "on this Mac",
    "autoTasks": "on this Mac"
  }
};

// ---- Synthetic project graph, skills and routines for the demo host and tests ----
// Every value is generated; nothing here comes from a real project.

const DEMO_NODE_COUNT = 2500;
const DEMO_CLUSTERS = 8;
const DEMO_EDGES_PER_NODE = 3;

/** Small deterministic PRNG so the demo looks the same on every load. */
function demoRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One node per index; the kind/path mix cycles so every category is produced. */
function demoNode(i: number, cluster: number): CGNode {
  const mod = i % 10;
  const id = `c${cluster}-${i}`;
  if (mod < 6) {
    return { id, title: `fn${i}`, kind: 'function' as CGNodeKind, metadata: { source_file: `src/module${cluster}/file${i % 40}.ts` } };
  }
  if (mod === 6) {
    return { id, title: `doc${i}`, kind: 'docPage' as CGNodeKind, metadata: { source_file: `docs/area${cluster}/page${i}.md` } };
  }
  if (mod === 7) {
    return { id, title: `spec${i}`, kind: 'symbol' as CGNodeKind, metadata: { source_file: `tests/module${cluster}/case${i}.test.ts` } };
  }
  if (mod === 8) {
    return { id, title: `decision${i}`, kind: 'noteDecision' as CGNodeKind, metadata: {} };
  }
  return { id, title: `skill${i}`, kind: 'skill' as CGNodeKind, metadata: {} };
}

/** A ~2500-node project graph in 8 clusters, mostly intra-cluster edges, every category present. */
export function buildDemoProjectGraph(): CGData {
  const rand = demoRng(42);
  const nodes: CGNode[] = [];
  const clusterOf: number[] = [];
  for (let i = 0; i < DEMO_NODE_COUNT; i++) {
    const cluster = Math.floor(rand() * DEMO_CLUSTERS);
    clusterOf.push(cluster);
    nodes.push(demoNode(i, cluster));
  }
  const byCluster: number[][] = Array.from({ length: DEMO_CLUSTERS }, () => []);
  clusterOf.forEach((c, i) => byCluster[c]!.push(i));

  const edges: CGEdge[] = [];
  for (let i = 0; i < DEMO_NODE_COUNT; i++) {
    for (let k = 0; k < DEMO_EDGES_PER_NODE; k++) {
      // Mostly intra-cluster, with a cross-cluster edge about one time in five.
      const crossCluster = rand() < 0.2;
      const pool = crossCluster ? null : byCluster[clusterOf[i]!]!;
      const j = pool ? pool[Math.floor(rand() * pool.length)]! : Math.floor(rand() * DEMO_NODE_COUNT);
      if (j === i) continue;
      edges.push({ fromId: nodes[i]!.id, toId: nodes[j]!.id, kind: 'imports', confidence: 'EXTRACTED' });
    }
  }
  return { nodes, edges, layers: [], tour: [] };
}

export const demoSkills: OsSkill[] = [
  { id: 'skill-brainstorming', name: 'brainstorming', source: 'kit', description: 'Explores intent and design before any creative work begins.' },
  { id: 'skill-writing-plans', name: 'writing-plans', source: 'kit', description: 'Turns a spec into a step-by-step implementation plan with checkpoints.' },
  { id: 'skill-systematic-debugging', name: 'systematic-debugging', source: 'kit', description: 'Reproduce, isolate and fix before proposing any change to behaviour.' },
  { id: 'skill-test-driven', name: 'test-driven-development', source: 'kit', description: 'Writes the failing test first, then the smallest change that passes it.' },
  { id: 'skill-code-review', name: 'code-review', source: 'project', description: 'Reviews a diff for correctness, security and missing edge cases.' },
  { id: 'skill-release-notes', name: 'release-notes', source: 'project', description: 'Summarises merged changes into release notes grouped by area.' },
  { id: 'skill-glossary', name: 'glossary', source: 'project', description: 'Keeps the project terms and their definitions in one place.' },
  { id: 'skill-meeting-summary', name: 'meeting-summary', description: 'Condenses a captured meeting into decisions, tasks and open questions.' },
];

export const demoRoutines: OsRoutine[] = [
  { id: 'routine-regression', title: 'Regression sweep', schedule: 'Every weekday at 09:00', nextRunAt: '2026-10-28T00:00:00Z', lastRunAt: '2026-10-27T00:00:00Z', enabled: true },
  { id: 'routine-docs', title: 'Doc freshness check', schedule: 'Mondays at 08:30', nextRunAt: '2026-11-02T23:30:00Z', lastRunAt: '2026-10-26T23:30:00Z', enabled: true },
  { id: 'routine-graph', title: 'Rebuild code graph', schedule: 'Nightly', nextRunAt: '2026-10-28T02:00:00Z', lastRunAt: '2026-10-27T02:00:00Z', enabled: true },
  { id: 'routine-triage', title: 'Issue triage', schedule: 'Every hour', nextRunAt: null, lastRunAt: '2026-10-20T10:00:00Z', enabled: false },
  { id: 'routine-digest', title: 'Weekly digest', schedule: null, nextRunAt: null, lastRunAt: null, enabled: false },
];
