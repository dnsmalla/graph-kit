import type { OsHost } from '../src/host';
import { fixtureSnapshot } from './fixture';

/** A host that serves the fixture snapshot. Used by `npm run dev` only. */
export function createFixtureHost(): OsHost {
  return {
    loadState: async () => structuredClone(fixtureSnapshot),
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
