import type { CGData } from '../../typescript/src/models';
import type { OsHost } from '../src/host';
import type { OsSnapshot } from '../src/types';
import { buildDemoProjectGraph, demoRoutines, demoSkills, fixtureSnapshot } from './fixture';

// The demo graph is built once: it is large and the host returns the same object each time.
let projectGraph: CGData | null = null;
// Live-refresh simulation: each bump adds billable tokens to the first model, so the next state load
// differs the way a running chat's numbers do (the OS view rebuilds; its layout must not move).
let liveTicks = 0;

/** Demo hook: changes the served state, as a live chat turn would, for the next refresh. */
export function bumpFixtureLive(): void {
  liveTicks++;
}

function liveState(): OsSnapshot {
  const snap = structuredClone(fixtureSnapshot);
  const first = snap.tokens?.byModel?.[0];
  if (first && liveTicks > 0) first.billable = (first.billable ?? 0) + liveTicks * 100;
  return snap;
}

/** A host that serves the fixture snapshot, graph, skills and routines. Used by `npm run dev` only. */
export function createFixtureHost(): OsHost {
  return {
    loadState: async () => liveState(),
    loadProjectGraph: async () => {
      projectGraph ??= buildDemoProjectGraph();
      return projectGraph;
    },
    loadSkills: async () => demoSkills.map((skill) => ({ ...skill })),
    loadRoutines: async () => demoRoutines.map((routine) => ({ ...routine })),
    cancel: async (request) => {
      console.info('[fixture] cancel', request);
    },
    watch: (_onChange, onStatus) => {
      onStatus('live');
      return () => {};
    },
    open: (target) => {
      console.info('[fixture] open', target);
      return true;
    },
  };
}
