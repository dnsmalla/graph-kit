// The System view's state and behaviour, kept out of React so the same logic
// runs in the app's web view, in the demo and in tests. Everything that talks to
// a server or to native code goes through the OsHost the page was mounted with.
import type { CGData } from '../../typescript/src/models';
import { copyToClipboard } from './clipboard';
import { isRepoPath } from './fileTree';
import { OsAuthError, type OsFileContent, type OsHost, type OsOpenTarget, type OsRange } from './host';
import type { OsCancel, OsLiveStatus, OsRoutine, OsSkill, OsSnapshot } from './types';
import { HUB_TITLES, isHubKey, levelKey, type CameraPose, type OsView, type ViewLevel } from './viz';

export const REFRESH_DEBOUNCE_MS = 300;

const DEFAULT_OPEN_NOTICE = 'Open this in the app.';
const DEFAULT_SIGNED_OUT_NOTICE = 'Your session has ended. Sign in again.';
const NO_OPEN_FILE_NOTICE = 'Opening files in Explorer needs the app.';
const NO_PREVIEW_MESSAGE = 'Code preview needs the app.';
const OUTSIDE_REPO_NOTICE = 'This file is outside the project, so the app cannot open or preview it.';

/** The most text of a file the page keeps for the preview (characters; the host may cut it sooner). */
export const FILE_PREVIEW_MAX_CHARS = 256 * 1024;

/** The code brain's two views: the 3D brain, or the file structure beside it. */
export type CodeTab = 'brain' | 'structure';

/** Load state of a file preview. 'idle' = asked for nothing yet; 'missing' = the host has no such file. */
export type FilePreviewStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error';

/** A file's content as the preview shows it. A binary file has no text. */
export type FileContent = {
  text: string | null;
  binary: boolean;
  bytes: number | null;
  truncated: boolean;
  language: string | null;
};

/** The code preview of one file. `path` is the file asked for; `content` is set when status is 'ready'. */
export type FilePreview = {
  path: string;
  status: FilePreviewStatus;
  content?: FileContent;
  /** Why the preview failed (status 'error'). */
  message?: string;
};

/** Load state of one optional host data set. 'none' = the host cannot supply it (or sent an unusable value). */
export type ExtraStatus = 'idle' | 'loading' | 'ready' | 'none' | 'error';

/**
 * The item the user picked: a project node (core), an activity item (ring) or a node of the OS
 * graph (viz). `detail` is the category, the activity kind or the node kind.
 */
export type OsSelection = { type: 'core' | 'ring' | 'viz'; id: string; label: string; detail: string };

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
  /** Where the brain is: the whole OS, or one part. Starts at the OS. */
  view: ViewLevel;
  /** Bumped when a side panel asks the brain to fly to the selected node (see openNode). */
  focusSeq: number;
  /** The code preview (host.loadFile) of the file last asked for. null until a preview is requested. */
  filePreview: FilePreview | null;
  /** The code brain's view: the 3D brain (default) or the file structure. */
  codeTab: CodeTab;
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

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Reduces a host's project graph to the shape the layout reads. Nodes without a
 * string id are dropped, duplicate ids keep the first node, and edges need string
 * endpoints (fromId / toId). Missing titles, kinds and metadata get safe defaults.
 * Returns null when the value has no `nodes` and `edges` arrays at all.
 */
export function sanitizeProjectGraph(value: unknown): CGData | null {
  if (!isObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
  const seen = new Set<string>();
  const nodes: CGData['nodes'] = [];
  for (const raw of value.nodes) {
    if (!isObject(raw) || !isId(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    nodes.push({
      ...(raw as unknown as CGData['nodes'][number]),
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : raw.id,
      kind: (typeof raw.kind === 'string' ? raw.kind : 'other') as CGData['nodes'][number]['kind'],
      metadata: isObject(raw.metadata) ? (raw.metadata as CGData['nodes'][number]['metadata']) : {},
    });
  }
  const edges: CGData['edges'] = [];
  for (const raw of value.edges) {
    if (!isObject(raw) || !isId(raw.fromId) || !isId(raw.toId)) continue;
    edges.push(raw as unknown as CGData['edges'][number]);
  }
  return { ...(value as object), nodes, edges } as unknown as CGData;
}

/** Skills with a string id and a name, first occurrence per id. */
export function sanitizeSkills(value: unknown[]): OsSkill[] {
  const seen = new Set<string>();
  const out: OsSkill[] = [];
  for (const raw of value) {
    if (!isObject(raw) || !isId(raw.id) || typeof raw.name !== 'string' || seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push(raw as unknown as OsSkill);
  }
  return out;
}

/** Routines with a string id and a title, first occurrence per id. */
export function sanitizeRoutines(value: unknown[]): OsRoutine[] {
  const seen = new Set<string>();
  const out: OsRoutine[] = [];
  for (const raw of value) {
    if (!isObject(raw) || !isId(raw.id) || typeof raw.title !== 'string' || seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push(raw as unknown as OsRoutine);
  }
  return out;
}

/** Activity rows without an id are dropped (the recent list and the ring key on it), first occurrence per id kept. */
function sanitizeSnapshot(raw: OsSnapshot): OsSnapshot {
  const activity: unknown = (raw as { activity?: unknown }).activity;
  const items: unknown = isObject(activity) ? activity.items : undefined;
  if (!isObject(activity) || !Array.isArray(items)) {
    return { ...raw, activity: { ...(isObject(activity) ? activity : {}), items: [] } } as unknown as OsSnapshot;
  }
  const seen = new Set<string | number>();
  const kept: unknown[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const id = item.id;
    if ((typeof id !== 'string' && typeof id !== 'number') || seen.has(id)) continue;
    seen.add(id);
    kept.push(item);
  }
  return { ...raw, activity: { ...activity, items: kept } } as unknown as OsSnapshot;
}

/**
 * A host's file content reduced to what the preview shows: a text file's text (cut to
 * FILE_PREVIEW_MAX_CHARS, with `truncated` set when it was), or a binary file with its size.
 * Null when the value is not a file object at all.
 */
export function sanitizeFile(value: unknown): FileContent | null {
  if (!isObject(value)) return null;
  const file = value as Partial<OsFileContent> & Obj;
  if (typeof file.path !== 'string') return null;
  const bytes = typeof file.bytes === 'number' && Number.isFinite(file.bytes) && file.bytes >= 0 ? file.bytes : null;
  const language = typeof file.language === 'string' && file.language.length > 0 ? file.language : null;
  if (file.binary === true) return { text: null, binary: true, bytes, truncated: false, language };
  const raw = typeof file.text === 'string' ? file.text : '';
  const cut = raw.length > FILE_PREVIEW_MAX_CHARS;
  return {
    text: cut ? raw.slice(0, FILE_PREVIEW_MAX_CHARS) : raw,
    binary: false,
    bytes,
    truncated: cut || file.truncated === true,
    language,
  };
}

function isSelectionType(value: unknown): value is OsSelection['type'] {
  return value === 'core' || value === 'ring' || value === 'viz';
}

/** A camera pose with six finite numbers, or null for anything else. */
function sanitizeCamera(value: unknown): CameraPose | null {
  if (!isObject(value)) return null;
  const { position, target } = value;
  if (!Array.isArray(position) || !Array.isArray(target) || position.length !== 3 || target.length !== 3) return null;
  const nums = [...position, ...target];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return { position: [position[0], position[1], position[2]], target: [target[0], target[1], target[2]] } as CameraPose;
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
  /** The latest code-preview request; an older response is dropped. */
  private fileSeq = 0;
  /** The camera each level was left at, by levelKey: returning to a level puts the camera back. */
  private readonly cameras = new Map<string, CameraPose>();
  /** Reads the mounted brain's camera. Navigation uses it when the caller gives no pose. */
  private cameraSource: (() => CameraPose | null) | null = null;

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
      view: { level: 'os' },
      focusSeq: 0,
      filePreview: null,
      codeTab: 'brain',
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
    // A new project has its own graph and remembered views: the brain starts again at the OS.
    this.cameras.clear();
    this.fileSeq++;
    this.set({
      view: { level: 'os' },
      selected: null,
      projectGraph: null,
      projectGraphStatus: 'idle',
      skills: null,
      skillsStatus: 'idle',
      routines: null,
      routinesStatus: 'idle',
      filePreview: null,
    });
    if (this.watching) {
      void this.refresh();
      this.loadExtras();
    }
  }

  /**
   * Opens one part of the OS in the brain. `code` opens the project's own graph; any other hub
   * opens its graph. The selection clears. `camera` is the pose the level being left had: it is
   * remembered, so going back returns to it. An unknown hub is ignored.
   */
  drill(hub: string, camera?: CameraPose | null): void {
    if (this.disposed || !isHubKey(hub)) return;
    if (this.state.view.level === 'hub' && this.state.view.hub === hub) return;
    this.leaving(camera);
    this.set({ view: { level: 'hub', hub }, selected: null });
  }

  /**
   * Back to the OS view from a part. The part's node is selected there, so the OS shows where
   * the user came from. A no-op on the OS itself.
   */
  back(camera?: CameraPose | null): void {
    if (this.disposed) return;
    const view = this.state.view;
    if (view.level !== 'hub') return;
    this.leaving(camera);
    const hub = view.hub;
    this.set({
      view: { level: 'os' },
      selected: { type: 'viz', id: `hub:${hub}`, label: HUB_TITLES[hub], detail: 'hub' },
    });
  }

  /**
   * Brings the navigation back in line with a freshly built OS view (after a refresh). A part the
   * view no longer has sends the brain back to the OS. A selected OS-graph node that is no longer
   * drawn at the level it is on is cleared. The code brain has no OS graph and is left alone.
   */
  reconcile(os: OsView): void {
    if (this.disposed) return;
    const view = this.state.view;
    if (view.level === 'hub' && view.hub !== 'code' && !os.hubs[view.hub]) this.back();
    const selected = this.state.selected;
    if (selected === null || selected.type !== 'viz') return;
    const now = this.state.view;
    if (now.level === 'hub' && now.hub === 'code') return;
    const graph = now.level === 'os' ? os.os : os.hubs[now.hub];
    if (!graph || !graph.nodes.some((node) => node.id === selected.id)) this.select(null);
  }

  /** Remembers the camera for the level the brain is on now (a null pose is ignored). */
  rememberCamera(camera: CameraPose | null): void {
    const pose = sanitizeCamera(camera);
    if (pose) this.cameras.set(levelKey(this.state.view), pose);
  }

  /**
   * The mounted brain registers how to read its camera (null to unregister). Navigation calls it
   * for the level it leaves, so a caller that has no brain at hand still remembers the view.
   */
  setCameraSource(source: (() => CameraPose | null) | null): void {
    this.cameraSource = source;
  }

  /** Remembers the camera of the level being left: the given pose, or the brain's when none is given. */
  private leaving(camera: CameraPose | null | undefined): void {
    this.rememberCamera(camera !== undefined ? camera : (this.cameraSource?.() ?? null));
  }

  /** The camera remembered for a level, or null when the level has none yet (it is then framed). */
  cameraFor(view: ViewLevel): CameraPose | null {
    return this.cameras.get(levelKey(view)) ?? null;
  }

  /**
   * A side panel's click: opens the hub that holds `node` and selects the node there (the brain
   * flies to it). `label` is the name the panel shows for it.
   */
  openNode(hub: string, node: { id: string; label: string; detail: string }, camera?: CameraPose | null): void {
    if (this.disposed || !isHubKey(hub)) return;
    this.leaving(camera);
    this.set({
      view: { level: 'hub', hub },
      selected: { type: 'viz', id: node.id, label: node.label, detail: node.detail },
      focusSeq: this.state.focusSeq + 1,
    });
  }

  /**
   * Opens the project's code brain on one of its nodes and selects it as a code (core) node, so the
   * brain flies to it. Used by the code node's links and by a code cluster's "Explore in code".
   */
  openCodeNode(node: { id: string; label: string; detail: string }, camera?: CameraPose | null): void {
    if (this.disposed) return;
    this.leaving(camera);
    this.set({
      view: { level: 'hub', hub: 'code' },
      selected: { type: 'core', id: node.id, label: node.label, detail: node.detail },
      focusSeq: this.state.focusSeq + 1,
    });
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
      const raw = await this.deps.host.loadState(this.state.range);
      if (this.disposed || seq !== this.requestSeq) return;
      const data = sanitizeSnapshot(raw);
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
   * A refused session (OsAuthError) signs the view out, as for the state load.
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

  /** Switches the code brain between the 3D brain and the file structure. */
  setCodeTab(tab: CodeTab): void {
    if (this.disposed || tab === this.state.codeTab) return;
    this.set({ codeTab: tab });
  }

  /**
   * Opens a project file in the host's code explorer, at `line` when given. A host without the
   * method, or one that refuses, gets a notice instead.
   */
  openFile(path: string, line?: number): void {
    if (this.disposed || !isId(path)) return;
    if (!isRepoPath(path)) {
      this.set({ notice: OUTSIDE_REPO_NOTICE });
      return;
    }
    const host = this.deps.host;
    const open = host.openFile;
    if (typeof open !== 'function') {
      this.set({ notice: NO_OPEN_FILE_NOTICE });
      return;
    }
    let opened: boolean;
    try {
      opened = line === undefined ? open.call(host, path) : open.call(host, path, line);
    } catch (err) {
      this.set({ notice: `Could not open the file: ${describe(err)}` });
      return;
    }
    if (!opened) this.set({ notice: `Could not open ${path} in the app.` });
  }

  /** Copies text through the host (when it can), else the page's clipboard routes. False when nothing copied it. */
  copyText(text: string): Promise<boolean> {
    return copyToClipboard(text, this.deps.host);
  }

  /**
   * Loads the code preview of one file (host.loadFile). Only the latest request may set the
   * preview: an older response that arrives late is dropped, as is any response after dispose().
   * A missing file (the host answers null) is 'missing'; a host without the method is an 'error'.
   */
  async loadFilePreview(path: string): Promise<void> {
    if (this.disposed || !isId(path)) return;
    if (!isRepoPath(path)) {
      this.fileSeq++;
      this.set({ filePreview: { path, status: 'error', message: OUTSIDE_REPO_NOTICE } });
      return;
    }
    const seq = ++this.fileSeq;
    const host = this.deps.host;
    const load = host.loadFile;
    if (typeof load !== 'function') {
      this.set({ filePreview: { path, status: 'error', message: NO_PREVIEW_MESSAGE } });
      return;
    }
    this.set({ filePreview: { path, status: 'loading' } });
    try {
      const raw: unknown = await load.call(host, path);
      if (this.disposed || seq !== this.fileSeq) return;
      if (raw === null) {
        this.set({ filePreview: { path, status: 'missing' } });
        return;
      }
      const content = sanitizeFile(raw);
      if (content) this.set({ filePreview: { path, status: 'ready', content } });
      else this.set({ filePreview: { path, status: 'error', message: 'The host sent a file the page cannot read.' } });
    } catch (err) {
      if (this.disposed) return;
      if (isAuthError(err)) {
        this.handleAuthError();
        return;
      }
      if (seq !== this.fileSeq) return;
      this.set({ filePreview: { path, status: 'error', message: `Could not load the file: ${describe(err)}` } });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.requestSeq++;
    this.graphSeq++;
    this.skillsSeq++;
    this.routinesSeq++;
    this.fileSeq++;
    this.stopWatching();
    this.cancelRefresh();
  }

  /** Sets the project graph and drops a core selection whose node is not in it any more. */
  private applyGraph(graph: CGData | null, status: ExtraStatus): void {
    const selected = this.state.selected;
    const gone =
      selected !== null &&
      selected.type === 'core' &&
      (graph === null || !graph.nodes.some((node) => node.id === selected.id));
    this.set(gone ? { projectGraph: graph, projectGraphStatus: status, selected: null } : { projectGraph: graph, projectGraphStatus: status });
  }

  private async loadProjectGraph(): Promise<void> {
    const host = this.deps.host;
    const load = host.loadProjectGraph;
    const seq = ++this.graphSeq;
    if (typeof load !== 'function') {
      this.applyGraph(null, 'none');
      return;
    }
    this.set({ projectGraphStatus: 'loading' });
    try {
      const raw: unknown = await load.call(host);
      if (this.disposed) return;
      if (seq !== this.graphSeq) return;
      const graph = sanitizeProjectGraph(raw);
      if (graph) this.applyGraph(graph, 'ready');
      else this.applyGraph(null, 'none');
    } catch (err) {
      if (this.disposed) return;
      if (isAuthError(err)) {
        this.handleAuthError();
        return;
      }
      if (seq !== this.graphSeq) return;
      this.applyGraph(null, 'error');
    }
  }

  private async loadSkills(): Promise<void> {
    const host = this.deps.host;
    const load = host.loadSkills;
    const seq = ++this.skillsSeq;
    if (typeof load !== 'function') {
      this.set({ skills: null, skillsStatus: 'none' });
      return;
    }
    this.set({ skillsStatus: 'loading' });
    try {
      const raw: unknown = await load.call(host);
      if (this.disposed) return;
      if (seq !== this.skillsSeq) return;
      if (Array.isArray(raw)) this.set({ skills: sanitizeSkills(raw), skillsStatus: 'ready' });
      else this.set({ skills: null, skillsStatus: 'none' });
    } catch (err) {
      if (this.disposed) return;
      if (isAuthError(err)) {
        this.handleAuthError();
        return;
      }
      if (seq !== this.skillsSeq) return;
      this.set({ skills: null, skillsStatus: 'error' });
    }
  }

  private async loadRoutines(): Promise<void> {
    const host = this.deps.host;
    const load = host.loadRoutines;
    const seq = ++this.routinesSeq;
    if (typeof load !== 'function') {
      this.set({ routines: null, routinesStatus: 'none' });
      return;
    }
    this.set({ routinesStatus: 'loading' });
    try {
      const raw: unknown = await load.call(host);
      if (this.disposed) return;
      if (seq !== this.routinesSeq) return;
      if (Array.isArray(raw)) this.set({ routines: sanitizeRoutines(raw), routinesStatus: 'ready' });
      else this.set({ routines: null, routinesStatus: 'none' });
    } catch (err) {
      if (this.disposed) return;
      if (isAuthError(err)) {
        this.handleAuthError();
        return;
      }
      if (seq !== this.routinesSeq) return;
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
