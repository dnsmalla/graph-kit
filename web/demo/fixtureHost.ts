import type { CGData } from '../../typescript/src/models';
import type { OsHost } from '../src/host';
import { buildDemoProjectGraph, demoRoutines, demoSkills, fixtureSnapshot } from './fixture';

// The demo graph is built once: it is large and the host returns the same object each time.
let projectGraph: CGData | null = null;

/** A host that serves the fixture snapshot, graph, skills and routines. Used by `npm run dev` only. */
export function createFixtureHost(): OsHost {
  return {
    loadState: async () => structuredClone(fixtureSnapshot),
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
