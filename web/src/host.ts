// The contract between the System view and the app that hosts it. The page
// holds no transport of its own: a host (e.g. a native app bridge or an HTTP client,
// or the demo fixture) answers these calls with data.
import type { OsCancel, OsLiveStatus, OsRoutine, OsSkill, OsSnapshot } from './types';

export type OsRange = 'day' | 'week';

/** Screens the host can open. The page asks; the host decides what they are. */
export type OsOpenTarget = 'loop' | 'autoTasks' | 'settings' | 'library';

/** Thrown (or rejected) by a host when the session is refused (HTTP 401). */
export class OsAuthError extends Error {
  constructor(message = 'The session was refused.') {
    super(message);
    this.name = 'OsAuthError';
  }
}

export interface OsHost {
  /** The aggregate for one time window. Reject with OsAuthError when the session is refused. */
  loadState(range: OsRange): Promise<OsSnapshot>;
  /** Stops a running item with the cancel request the server declared for it. May reject with OsAuthError. */
  cancel(request: NonNullable<OsCancel>): Promise<void>;
  /**
   * Starts the change feed. `onChange` means "state changed, re-fetch"; `onStatus`
   * reports the feed's state. Returns the unwatch function.
   */
  watch(onChange: () => void, onStatus: (status: OsLiveStatus, detail?: string) => void): () => void;
  /** Navigates the host to one of its screens. false = there is nowhere to go from here. */
  open(target: OsOpenTarget): boolean;
  /** Later steps: the project's code graph, skills and routines. Optional. */
  loadProjectGraph?(): Promise<unknown | null>;
  loadSkills?(): Promise<OsSkill[]>;
  loadRoutines?(): Promise<OsRoutine[]>;
}
