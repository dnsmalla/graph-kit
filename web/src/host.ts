// The contract between the System view and the app that hosts it. The page
// holds no transport of its own: a host (e.g. a native app bridge or an HTTP client,
// or the demo fixture) answers these calls with data.
import type {
  OsCancel,
  OsClearResult,
  OsCompactResult,
  OsLiveStatus,
  OsRoutine,
  OsSkill,
  OsSnapshot,
  OsStorageSettings,
} from './types';

export type OsRange = 'day' | 'week';

/** Screens the host can open. The page asks; the host decides what they are. */
export type OsOpenTarget = 'loop' | 'autoTasks' | 'settings' | 'library' | 'explorer' | 'codeGraph';

/** Thrown (or rejected) by a host when the session is refused (HTTP 401). */
export class OsAuthError extends Error {
  constructor(message = 'The session was refused.') {
    super(message);
    this.name = 'OsAuthError';
  }
}

/**
 * A project file as the host reads it, for the code preview. Text files carry `text` (the host
 * may cut it: `truncated`); binary files carry `binary` and no text. `bytes` is the file's size.
 */
export interface OsFileContent {
  path: string;
  text?: string;
  truncated?: boolean;
  bytes?: number;
  language?: string | null;
  binary?: boolean;
}

/**
 * A storage call that the server refused or failed. `code` is the server's error code: for a clear,
 * PREVIEW_EXPIRED, PREVIEW_INVALID, preview_stale (the page re-previews); for a compact, busy,
 * disk_space or store_down. Hosts throw this (or any Error with a `code` string).
 */
export class OsStorageError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = 'OsStorageError';
    this.code = code;
  }
}

/** A clear request (POST /kb/agent-history/clear). A real clear (dryRun false) needs the previewId of its dry run. */
export interface OsClearRequest {
  scope: 'raw' | 'all';
  /** Only rows older than this many days; omitted for all rows. */
  beforeDays?: number;
  dryRun: boolean;
  previewId?: string;
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
  /**
   * The project's code graph as a CGData object ({ nodes, edges, layers, tour }). Optional.
   * Resolve null (or anything without `nodes` and `edges` arrays) when there is no graph.
   * Called on start, on a project change and on retry; not on change-feed refreshes.
   * A rejection only marks the graph as failed; the rest of the page still loads.
   */
  loadProjectGraph?(): Promise<unknown | null>;
  /**
   * Opens a project file in the host's code explorer, at `line` when given. Optional. false = the
   * host could not open it; the page then says so. The page never calls it for a file it has not shown.
   */
  openFile?(path: string, line?: number): boolean;
  /**
   * Copies text with the host's own clipboard. Optional; tried first when present. true = copied;
   * false (or a throw) = the page tries its own routes (the async clipboard API, then a textarea).
   */
  copyText?(text: string): boolean;
  /**
   * The content of a project file for the code preview. Optional. Resolve null when the file is not
   * there (the page shows it as missing). A rejection marks the preview as failed; OsAuthError signs out.
   */
  loadFile?(path: string): Promise<OsFileContent | null>;
  /** Skills for the Skills panel. Optional. Called on the same occasions as loadProjectGraph. */
  loadSkills?(): Promise<OsSkill[]>;
  /** Scheduled routines for the Routines panel. Optional. Called on the same occasions as loadProjectGraph. */
  loadRoutines?(): Promise<OsRoutine[]>;
  /**
   * Dry run (`dryRun: true`, the counts and a previewId) or real clear (`dryRun: false` with the
   * previewId). Optional: without it the page offers no Clear. Rejects with OsStorageError (see its code).
   */
  storageClear?(req: OsClearRequest): Promise<OsClearResult>;
  /** Compacts the agent store (POST /kb/agent-history/compact). Optional. Rejects with OsStorageError: busy, disk_space or store_down. */
  storageCompact?(): Promise<OsCompactResult>;
  /** The storage settings (GET /kb/agent-history/settings). Optional. */
  storageSettings?(): Promise<OsStorageSettings>;
  /** Sets the raw-row retention in days, 7 to 365 (PUT /kb/agent-history/settings). Optional. Resolves the stored value. */
  setStorageRetention?(days: number): Promise<OsStorageSettings>;
}
