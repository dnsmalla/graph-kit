// The System view's state and behaviour, kept out of React so the same logic
// runs in the app's web view, in the demo and in tests. Everything that talks to
// a server or to native code goes through the OsHost the page was mounted with.
import type { CGData } from '../../typescript/src/models';
import { OsAuthError, type OsHost, type OsOpenTarget, type OsRange } from './host';
import type { OsCancel, OsLiveStatus, OsRoutine, OsSkill, OsSnapshot } from './types';

export const REFRESH_DEBOUNCE_MS = 300;

const DEFAULT_OPEN_NOTICE = 'Open this in the app.';
const DEFAULT_SIGNED_OUT_NOTICE = 'Your session has ended. Sign in again.';

/** Load state of one optional host data set. 'none' = the host cannot supply it (or sent an unusable value). */
export type ExtraStatus = 'idle' | 'loading' | 'ready' | 'none' | 'error';

/** The item the user picked in the brain or the recent list. Same shape as the orbit's pick. */
export type OsSelection = { type: 'core' | 'ring'; id: string; label: string; detail: string };

export type ViewState = {
  projectName: string | null;
  range: OsRange;
  data: OsSnapshot | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  live: OsLiveStatus;
  /** The host refused the session (OsAuthError). The view stops until retry() or start() resumes it. */
  signedOut: boolean;
  /** Key of the running item whose Stop request is in flight, or null. */
  stopping: string | null;
  /** The project's code graph (host.loadProjectGraph). Loaded on start, project change and retry, not on change refreshes. */
  projectGraph: CGData | null;
  projectGraphStatus: ExtraStatus;
  /** Skills (host.loadSkills). null when not loaded or not available; [] when the host has none. */
  skills: OsSkill[] | null;
  skillsStatus: ExtraStatus;
  /** Routines (host.loadRoutines). null when not loaded or not available; [] when there are none. */
  routines: OsRoutine[] | null;
  routinesStatus: ExtraStatus;
  selected: OsSelection | null;
};

export type ControllerDeps = {
  host: OsHost;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  applyTheme: (theme: string | undefined) => void;
  /** The notice shown when open() has nowhere to go. */
  openFallbackNotice?: string;
  /** The notice shown when the host refuses the session. */
  signedOutNotice?: string;
};

export type ControllerInit = { projectName?: string | null };

export type ConfigureInput = { theme?: string; projectName?: string | null };

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAuthError(err: unknown): boolean {
  return err instanceof OsAuthError || (err instanceof Error && err.name === 'OsAuthError');
}

/** A project graph is usable when it is an object with `nodes` and `edges` arrays. */
function isProjectGraph(value: unknown): value is CGData {
  if (!value || typeof value !== 'object') return false;
  const v = value as { nodes?: unknown; edges?: unknown };
  return Array.isArray(v.nodes) && Array.isArray(v.edges);
}

function isSelectionType(value: unknown): value is OsSelection['type'] {
  return value === 'core' || value === 'ring';
}

export class OsController {
  private state: ViewState;
  private readonly listeners = new Set<() => void>();
  private readonly deps: ControllerDeps;
  /** True while the change feed is attached. An explicit flag: the host's unwatch may be anything. */
  private watching = false;
  /** The host's unwatch function while the change feed is running; null when stopped. */
  private unwatch: (() => void) | null = null;
  private refreshTimer: unknown = null;
  private requestSeq = 0;
  /** Set by dispose(). A disposed controller ignores host callbacks and late responses. */
  private disposed = false;
  /** The message of the last failed stop, re-applied after the trailing refresh. */
  private stopError: string | null = null;
  /** Separate sequence numbers for the optional loads, so each one drops only its own stale responses. */
  private graphSeq = 0;
  private skillsSeq = 0;
  private routinesSeq = 0;

  /** The notice the page shows when the host refuses the session. Read-only. */
  readonly signedOutNotice: string;

  constructor(deps: ControllerDeps, init: ControllerInit = {}) {
    this.deps = deps;
    this.signedOutNotice = deps.signedOutNotice ?? DEFAULT_SIGNED_OUT_NOTICE;
    this.state = {
      projectName: init.projectName ?? null,
      range: 'day',
      data: null,
      loading: false,
      error: null,
      notice: null,
      live: 'idle',
      signedOut: false,
      stopping: null,
      projectGraph: null,
      projectGraphStatus: 'idle',
      skills: null,
      skillsStatus: 'idle',
      routines: null,
      routinesStatus: 'idle',
      selected: null,
    };
  }

  // Arrow properties so React's useSyncExternalStore can take them unbound.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ViewState => this.state;

  /** Starts the change feed and loads the state. A no-op once started; see retry() after a sign-out. */
  start(): void {
    if (this.disposed || this.watching) return;
    this.attachFeed();
    void this.refresh();
    this.loadExtras();
  }

  /**
   * Resumes the view after the host refreshed its session: clears the sign-out,
   * re-watches the change feed and reloads the state and the optional data sets.
   */
  retry(): void {
    if (this.disposed) return;
    this.set({ signedOut: false, error: null });
    if (this.watching) {
      void this.refresh();
      this.loadExtras();
      return;
    }
    this.start();
  }

  /**
   * Theme and project. A theme is applied when given; a project change clears the
   * project's data and re-fetches once the view has started (start() does the first fetch).
   */
  configure(cfg: ConfigureInput): void {
    if (this.disposed) return;
    if (!cfg || typeof cfg !== 'object') return;
    if (cfg.theme !== undefined) this.deps.applyTheme(cfg.theme);
    const projectName = cfg.projectName === undefined ? this.state.projectName : cfg.projectName;
    const projectChanged = projectName !== this.state.projectName;
    this.set({ projectName, error: null });
    if (!projectChanged) return;
    this.set({
      selected: null,
      projectGraph: null,
      projectGraphStatus: 'idle',
      skills: null,
      skillsStatus: 'idle',
      routines: null,
      routinesStatus: 'idle',
    });
    if (this.watching) {
      void this.refresh();
      this.loadExtras();
    }
  }

  /** Selects a brain or ring item, or clears the selection with null. */
  select(item: OsSelection | null): void {
    if (this.disposed) return;
    if (item === null) {
      this.set({ selected: null });
      return;
    }
    if (!item || typeof item !== 'object' || !isSelectionType(item.type)) return;
    this.set({ selected: { type: item.type, id: item.id, label: item.label, detail: item.detail } });
  }

  /** The host saw a change: state changed, re-fetch once the burst settles. */
  notifyChange(): void {
    this.scheduleRefresh();
  }

  setRange(range: OsRange): void {
    if (this.disposed || range === this.state.range) return;
    this.set({ range });
    void this.refresh();
  }

  /** Loads the state for the current range. Stale responses are dropped. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const seq = ++this.requestSeq;
    this.set({ loading: true });
    try {
      const data = await this.deps.host.loadState(this.state.range);
      if (this.disposed || seq !== this.requestSeq) return;
      const wasSignedOut = this.state.signedOut;
      this.set({ data, loading: false, error: null, signedOut: false });
      // A refresh that clears a sign-out also re-establishes the feed the sign-out stopped.
      if (wasSignedOut && !this.watching) this.attachFeed();
    } catch (err) {
      if (this.disposed || seq !== this.requestSeq) return;
      if (isAuthError(err)) {
        this.handleAuthError();
        return;
      }
      this.set({ loading: false, error: `Could not load the System view: ${describe(err)}` });
    }
  }

  /** Stops a running item with its declared cancel request, then refreshes. */
  async stopItem(cancel: OsCancel, key: string): Promise<void> {
    if (this.disposed || !cancel || this.state.stopping !== null) return;
    this.stopError = null;
    this.set({ stopping: key, error: null });
    try {
      if (cancel.method !== 'POST' || typeof cancel.path !== 'string' || !cancel.path.startsWith('/')) {
        throw new Error('Unsupported cancel request');
      }
      await this.deps.host.cancel(cancel);
    } catch (err) {
      if (isAuthError(err)) {
        this.handleAuthError();
        return;
      }
      this.stopError = `Could not stop it: ${describe(err)}`;
      this.set({ error: this.stopError });
    } finally {
      this.set({ stopping: null });
    }
    if (this.disposed) return;
    await this.refresh();
    // The trailing refresh clears `error`; a failed stop must stay visible.
    if (this.stopError !== null && !this.disposed && !this.state.signedOut) {
      this.set({ error: this.stopError });
    }
  }

  /**
   * Loads the project graph, skills and routines. Each is independent: a failure
   * or a missing host method sets only that data set's status, never the page error.
   * Not called by change-feed refreshes (the graph is expensive to build).
   */
  loadExtras(): void {
    void this.loadProjectGraph();
    void this.loadSkills();
    void this.loadRoutines();
  }

  /** Asks the host to navigate to one of its screens. */
  open(target: OsOpenTarget): void {
    if (this.disposed) return;
    if (!this.deps.host.open(target)) {
      this.set({ notice: this.deps.openFallbackNotice ?? DEFAULT_OPEN_NOTICE });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.requestSeq++;
    this.graphSeq++;
    this.skillsSeq++;
    this.routinesSeq++;
    this.stopWatching();
    this.cancelRefresh();
  }

  private async loadProjectGraph(): Promise<void> {
    const host = this.deps.host;
    const load = host.loadProjectGraph;
    if (typeof load !== 'function') {
      this.set({ projectGraph: null, projectGraphStatus: 'none' });
      return;
    }
    const seq = ++this.graphSeq;
    this.set({ projectGraphStatus: 'loading' });
    try {
      const raw: unknown = await load.call(host);
      if (this.disposed || seq !== this.graphSeq) return;
      if (isProjectGraph(raw)) this.set({ projectGraph: raw, projectGraphStatus: 'ready' });
      else this.set({ projectGraph: null, projectGraphStatus: 'none' });
    } catch {
      if (this.disposed || seq !== this.graphSeq) return;
      this.set({ projectGraph: null, projectGraphStatus: 'error' });
    }
  }

  private async loadSkills(): Promise<void> {
    const host = this.deps.host;
    const load = host.loadSkills;
    if (typeof load !== 'function') {
      this.set({ skills: null, skillsStatus: 'none' });
      return;
    }
    const seq = ++this.skillsSeq;
    this.set({ skillsStatus: 'loading' });
    try {
      const raw: unknown = await load.call(host);
      if (this.disposed || seq !== this.skillsSeq) return;
      if (Array.isArray(raw)) this.set({ skills: raw as OsSkill[], skillsStatus: 'ready' });
      else this.set({ skills: null, skillsStatus: 'none' });
    } catch {
      if (this.disposed || seq !== this.skillsSeq) return;
      this.set({ skills: null, skillsStatus: 'error' });
    }
  }

  private async loadRoutines(): Promise<void> {
    const host = this.deps.host;
    const load = host.loadRoutines;
    if (typeof load !== 'function') {
      this.set({ routines: null, routinesStatus: 'none' });
      return;
    }
    const seq = ++this.routinesSeq;
    this.set({ routinesStatus: 'loading' });
    try {
      const raw: unknown = await load.call(host);
      if (this.disposed || seq !== this.routinesSeq) return;
      if (Array.isArray(raw)) this.set({ routines: raw as OsRoutine[], routinesStatus: 'ready' });
      else this.set({ routines: null, routinesStatus: 'none' });
    } catch {
      if (this.disposed || seq !== this.routinesSeq) return;
      this.set({ routines: null, routinesStatus: 'error' });
    }
  }

  /** Attaches the host's change feed. Callers check `watching` first. */
  private attachFeed(): void {
    this.watching = true;
    this.unwatch = this.deps.host.watch(
      () => this.notifyChange(),
      (live, detail) => this.set({ live, notice: detail ?? null }),
    );
  }

  private stopWatching(): void {
    const unwatch = this.unwatch;
    this.unwatch = null;
    this.watching = false;
    unwatch?.();
  }

  private handleAuthError(): void {
    // Anything still in flight was sent before the refusal; it must not clear the sign-out.
    this.requestSeq++;
    this.stopWatching();
    this.cancelRefresh();
    this.set({
      signedOut: true,
      live: 'stopped',
      loading: false,
      error: null,
    });
  }

  /** Any change means "state changed": re-fetch once the burst settles. */
  private scheduleRefresh(): void {
    if (this.disposed) return;
    this.cancelRefresh();
    this.refreshTimer = this.deps.setTimer(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private cancelRefresh(): void {
    if (this.refreshTimer !== null) {
      this.deps.clearTimer(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private set(patch: Partial<ViewState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
