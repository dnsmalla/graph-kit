import type { CGData } from '../../typescript/src/models';
import type { OsHost } from '../src/host';
import type { OsSnapshot } from '../src/types';
import { buildDemoProjectGraph, DEMO_BROKEN_PATH, demoFilePaths, demoFileText, demoRoutines, demoSkills, fixtureSnapshot } from './fixture';

// The demo graph is built once: it is large and the host returns the same object each time.
let projectGraph: CGData | null = null;
// The paths the demo project has (for the code preview: a path not in it is missing).
let filePaths: Set<string> | null = null;
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
    openFile: (path, line) => {
      console.info('[fixture] openFile', path, line ?? '');
      return true;
    },
    loadFile: async (path) => {
      console.info('[fixture] loadFile', path);
      projectGraph ??= buildDemoProjectGraph();
      filePaths ??= demoFilePaths(projectGraph);
      if (!filePaths.has(path)) return null;
      if (path === DEMO_BROKEN_PATH) throw new Error('The demo host could not read this file.');
      if (/\.png$/i.test(path)) return { path, binary: true, bytes: 18432, language: null };
      const { text, language } = demoFileText(path);
      return { path, text, truncated: false, bytes: new TextEncoder().encode(text).length, language };
    },
  };
}
