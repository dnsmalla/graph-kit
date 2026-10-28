# @dnsmalla/graph-kit-web

The Agentic OS **System** view as a React page. The page holds no transport of
its own: the app that hosts it supplies the data through the `OsHost` interface
(`src/host.ts`), so the same page runs in any host that implements it: a native
app bridge, an HTTP client, or the demo. LLM-IDE is the first host.

## The OsHost contract

| Method | Purpose |
|---|---|
| `loadState(range)` | The `OsSnapshot` for `'day'` or `'week'`. Reject with `OsAuthError` when the session is refused. |
| `cancel(request)` | Stops a running item with the cancel request the server declared for it. |
| `watch(onChange, onStatus)` | Starts the change feed. `onChange` = state changed (the page re-fetches, debounced); `onStatus` = feed state. Returns unwatch. |
| `open(target)` | Navigates the host to `loop`, `autoTasks`, `settings`, `library`, `explorer` or `codeGraph`. `false` = nowhere to go. |
| `openFile?(path, line?)` | Optional. Opens a repo-relative file in the host's editor. `false` = not opened. The page never sends absolute paths or paths containing `..`. |
| `loadFile?(path)` | Optional. The file for the code preview as `OsFileContent` (`{ path, text?, truncated?, bytes?, language?, binary? }`), or `null` when it is missing or refused. |
| `copyText?(text)` | Optional. Copies text through the host, tried before `navigator.clipboard` and a hidden-textarea fallback. |
| `loadProjectGraph?()` | Optional. The project's code graph as a `CGData` object (`{ nodes, edges, layers, tour }`). Resolve `null`, or anything without `nodes` and `edges` arrays, when there is no graph. Feeds the brain. |
| `loadSkills?()` | Optional. The skills for the Skills panel (`OsSkill[]`). |
| `loadRoutines?()` | Optional. The scheduled routines for the Routines panel (`OsRoutine[]`). |

The three optional loads run on start, on a project change and on `retry()`.
They do not run on change-feed refreshes, because the graph is expensive to
build. Each is independent: a rejection marks only its own panel as failed and
never sets the page error. A host without a method gets the panel's
"not available in this host" state.

Wire types (`OsSnapshot`, `OsCancel`, ...) come from graph-kit's core
(`typescript/src/system/types.ts`) and are re-exported from `src/index.ts`.

## Layout

The page is the graph. A slim top bar (title, project, Day|Week, live status, the update time,
and two chips: server health, which opens Kits, and "N running", which opens Agents and is hidden
at zero) sits above a stage that fills the rest of the viewport. The stage holds the brain and
its overlays:

- **Top left:** the breadcrumb (`OS › <part>`) with Back, and the 3D | Structure switch on the
  code level.
- **Top centre:** the node search (`/` focuses it). It widens on focus and centres on the graph area.
- **Top right:** the brain toolbar (zoom, reset, pause, colour by Kind or Cluster).
- **Bottom left:** a "Legend" chip (collapsed by default), the node and link counts, and on the OS
  level an "Activity" chip that opens the recent-activity timeline in the drawer.
- **Right:** the details drawer (380 px), an overlay on the stage. Under 760 px wide it is a bottom sheet
  over the lower part of the stage. The stage keeps its full size while the drawer is open.

The drawer shows what is selected, or the level's overview when nothing is:

- A **node** selected in the brain (or from search or the code tree) shows its details: the
  `Selection` card (status, meta table, actions) or, on the code level, the code-node card (path,
  links, Open in Explorer, Preview code).
- A **hub** selected on the OS (one click) shows that hub's overview, with Explore to drill in. A
  drilled-in hub shows its overview by default.
- The **activity** chip shows the timeline. An unknown or empty level shows nothing.

Each drawer can be hidden with Hide; the state is remembered per level, and a selection re-opens
it. Escape hides the drawer first, then goes back a level.

The canvas does not shrink or move when the drawer opens. The brain reports the part the drawer covers
(`OrbitView.setViewInset({ right, bottom })`, measured from the drawer's box: its right edge on a wide
stage, its top edge as a bottom sheet). The camera stays where it is; the projection's centre glides
(about 200 ms) to the middle of the visible area, so the graph slides instead of jumping. Framing
(`fitCamera`, `fitDistance`) uses the visible area too. A selected node that lands under the drawer
(a click, a search, or a call to `setSelection`) is brought into view: the camera flies to it, keeping
its distance. Picking and the label positions use the same projection, so they follow the glide.
Escape hides the drawer and puts the focus on the breadcrumb (`escapeAction`, `Brain.tsx`).

### Hub overviews

`src/components/HubOverview.tsx` renders one overview per hub from the snapshot and the optional
data sets the controller already holds. Nothing in it fetches.

| Hub | Overview | Sourced from |
|---|---|---|
| Models | Token flow: window, totals, cache share, by model / source / endpoint, per-turn composition | `snapshot.tokens` |
| Kits | System map: server health, Database / Claude CLI / Skills checks, kit cards (click selects the kit's node) | `snapshot.system` |
| Knowledge | Memory and knowledge: Sources, Meetings, Pending reviews, Outcomes, sources by kind, code-graph freshness, Open Library | `snapshot.knowledge` |
| Memory | Project memory: per repo, facts, active, superseded, last confirmed | `snapshot.knowledge.projectMemory` |
| Skills | Searchable skill list with source chip and description (click selects the node) | `loadSkills` |
| Routines | Table (enabled, title, schedule, next and last run); Open Loop, Open Auto Tasks | `loadRoutines` |
| Agents | Running now: chat turns, meeting agents, live captures; Stop wired to `controller.stopItem` | `snapshot.running` |
| Activity | Timeline: kind, title, time ago; a row selects its ring item | `snapshot.activity` |
| Code | Node, community and repo counts, largest clusters, how to explore | the project graph |

The old side cards (System map, Running now, Skills, Token flow, Memory and knowledge, Routines) are
gone; their figures and actions are reached through the hub that owns them.

Category colours are the `--os-cat-*` tokens in `src/os-tokens.css`; the light theme uses darker
shades so each swatch keeps 3:1 against its surface.

### Brain controls

The brain (`OrbitView`, a three.js view) uses three's own `OrbitControls`:

- **Orbit:** left-drag. **Pan:** right-drag, or shift-drag. **Zoom:** wheel or trackpad scroll (zooms to the cursor), and pinch (WebKit `gesturechange`; the page does not zoom). Damping is on. Zoom is limited to 0.3 to 6 layout radii.
- **Auto-rotate:** one turn in about 40 s. It pauses while the user interacts and resumes 4 s after. It is off under reduced motion. The core and the recent ring turn together, the ring slightly faster.
- **Toolbar** (top right of the brain): Zoom in, Zoom out, Reset view, Pause or Play rotation, and Colour by Kind or Cluster.
- **Keyboard** (the canvas has focus, with a visible focus ring): `+` and `-` zoom, `0` resets the view, Space pauses or plays.
- **Picking** is measured on the screen. A hub is picked when the pointer is inside its drawn disc
  (its diameter is 28 to 44 px) and beats any member nearer the pointer; otherwise the nearest point
  whose disc, or 8 px around it, the pointer is inside wins (ties: the larger, then the hub); a labelled
  OS-graph edge is the fallback. The same rule (`choosePick`) serves hover, click and double-click.
- **Click** selects a node. **Double-click** flies the camera to it (about 400 ms) and selects it. `OrbitView.focusNode(id)` flies to any core node or ring item (the search box uses it), and `OrbitView.setSelection(id | null)` highlights the selected node and its direct neighbours: the rest dims to alpha 0.15, the touching edges draw brighter. The highlight writes the existing buffers in place; no geometry is rebuilt.
- **Colour by Kind on the code level** (the default) colours each node by its code-graph kind with the
  native Code graph's palette (`NATIVE_KIND_COLOURS` in `src/orbit/scene.ts`, the same table as
  `CGPalette.swift` `color(for:)`; a test parses the Swift file and fails on any difference). A node
  without a kind keeps its category colour; an unknown kind is grey. The Legend lists the kinds
  present, most frequent first (top 8, with counts).
- **Colour by Cluster** colours each node by its community (largest first) from the ten `--os-cluster-1..10` tokens (`src/os-tokens.css`, darker in the light theme). Switching is in place too.
- **Search:** a type-ahead box above the brain matches core node labels and ids (case-insensitive, the top 8). Up and Down move, Enter chooses (it flies to the node and selects it), Escape clears.

The render loop runs only while something moves (auto-rotation, damping, a focus flight). A still view does not request frames.

`OrbitPanel` takes `selectedId`, `colorBy` with `onColorByChange`, and an imperative `ref` (`OrbitPanelHandle.focusNode`). The fake-renderer tests in `test/orbit.test.mjs` cover the controls, the loop and the selection without WebGL.

`src/systemGraph.ts` is the only module that calls the pure core, in two parts so a
change refresh never redraws the project: `computeCore(project)` (memoised on the
project's identity) and `computeRing(snapshot)` (memoised on the ring's ids, times,
labels and kinds). The core is capped at 4000 nodes and the ring at 24 items.

The core is the Rust crate `rust/os-graph`, run as **embedded WASM**. The page is a
`file://` document in a macOS WKWebView loaded as one classic script, so it cannot
fetch a `.wasm` file. `src/wasm/bytes.ts` holds the module as base64 and
`src/wasm/index.ts` instantiates it synchronously (`initSync`) on first call, then
wraps `buildSystemGraph` and `orbitLayout` (JSON in, JSON out, a core error thrown).
`src/wasm/pkg/` is the wasm-bindgen glue, built with `--target web
--omit-default-module-path`, so it has no `import.meta.url` and Vite emits no
separate asset. The generated files are committed; CI checks them against a fresh build.

To rebuild after a change to `rust/os-graph`, from the graph-kit root:

```sh
scripts/build-os-wasm.sh          # regenerates src/wasm/pkg/ and src/wasm/bytes.ts
scripts/build-os-wasm.sh --check  # builds into a temp dir and diffs against the committed files
```

`--check` is skipped (exit 0, with a message) when the local rustc differs from the one
recorded in `bytes.ts`: wasm output is only reproducible with the same toolchain and platform
(CI checks the glue and types with `--glue-only` and the bytes by running the tests). The
`wasm-bindgen` CLI must match the `wasm-bindgen` version in `rust/Cargo.lock` (0.2.129).

### The OS as a graph

The brain opens on the whole OS: one centre per part (Code, Knowledge, Memory, Skills, Models,
Agents, Routines, Kits) with that part's members around it. The core builds it
(`build_os_view_json`, see `rust/os-graph/src/viz.rs`); `src/wasm/index.ts` wraps it as
`buildOsView`, `vizLayout` and `codeSummary`, and `src/systemGraph.ts` memoises the view
(`computeOsView`, keyed on the core's identity and the content of the snapshot parts the view
reads, so an activity-only refresh keeps it) and each graph's layout (`computeVizLayout`).

- **Click a hub** to select it (its overview in the drawer, with an Explore button). **Double-click** a
  hub, press Enter, or press Explore to open its part. The breadcrumb reads `OS › <part>`; `OS`
  and Back return, and Escape returns from a part (not while typing in a field). The OS returns
  with that hub selected. Code is the part whose graph is the project's own (the code brain).
- **Live refreshes keep the camera**: a refresh of the same level (same node ids) keeps the pose
  and the layout (`computeVizLayout` is keyed by content). After a refresh the navigation is
  reconciled with the new OS view (`OsController.reconcile`): a part that is gone returns to the
  OS, and a selected node that is no longer drawn is cleared.
- **Readable levels**: the OS places its hubs on a ring with their members on a shell around
  each (`hub_layout` in `rust/os-graph/src/orbit.rs`); the camera frames the hubs. Small graphs
  (under 200 nodes) draw points in pixels. Labels: the labelled nodes, the hovered or selected
  node, and the largest members of each part when the camera is close; `pickLabels` keeps only
  the labels whose boxes miss a 64 px occupancy grid, in priority order.
- **Each level remembers its camera**: leaving a level records its pose, and returning puts the
  camera back. The brain registers how to read its camera with the controller
  (`setCameraSource`), so every navigation records the level it leaves.
- **Select a node** for its details in the drawer: a status chip, a meta table (numbers with
  separators, dates relative, arrays as counts, nested objects as key: value lines) and the actions
  its kind offers: Explore on a hub, Open Auto Tasks (routines), Open Settings (kits, features,
  checks), Open Library (source kinds), and Stop for a running chat turn or meeting agent.
- **Overview rows** open their node: a kit, routine, skill, knowledge row or memory repo opens its
  part and selects the node there.
- **Colour**: a point takes its kind's colour; a status tints its ring (ok green, warn amber, running
  blue with a pulse, unknown and off have no ring, and an off node is dimmed). The status is never
  colour alone: the tooltip, the drawer's status chip and the Legend's status row say the word (OK,
  Warning, Off, Running, Unknown). Hubs are larger and brighter.
- **Pulse**: running nodes pulse at about 20 frames a second; only their ring alpha is written, and
  only their range is uploaded. With nothing running or moving the loop is idle (no frames are queued). Labels are HTML
  over the canvas for the labelled nodes only. A labelled edge shows its label on hover.

The code brain is unchanged: `computeCore` and `computeRing` draw it. The OS graph's types are
in `src/viz.ts` (not in `typescript/src/system/types.ts`).

### Code node details

In the code level, selecting a node opens the details drawer on the right of the stage:

- kind, category, cluster, degree and the file path (with Copy);
- **Depends on** / **Used by** from the project graph's dependency edges (imports, calls,
  inherits, implements, references, dependsOn), and **Contains** for contains/defines edges;
  each item selects and flies to that node;
- **Open in Explorer** (`openFile`) and **Preview code** (`loadFile`): numbered lines, 2,000 at a
  time with "Show more", truncated and binary notices, Retry on a failed load (no automatic retry);
- paths outside the repo (absolute, `~`, drive letters, `..`) are marked and get no Open or Preview.

A **3D | Structure** switch shows the code as a file tree built from node paths: folders first,
counts and category dots per row, a filter, keyboard navigation (tree pattern), and selection kept
in sync with the 3D view.

## Mounting

```ts
import { mountOsView, OsAuthError, type OsHost } from '@dnsmalla/graph-kit-web';

const host: OsHost = {
  loadState: async (range) => fetchStateSomehow(range), // throw OsAuthError on 401
  cancel: async (request) => { /* POST request.path with request.body */ },
  watch: (onChange, onStatus) => subscribeToChanges(onChange, onStatus), // returns unwatch
  open: (target) => navigateSomehow(target),
};

const view = mountOsView(document.getElementById('root')!, host, {
  theme: 'dark',                 // dark | light | midnight
  projectName: 'My project',
  openFallbackNotice: 'Open this in the app.',
  signedOutNotice: 'Your session has ended. Sign in again.', // the default
});

// Optional data sets: omit a method and its panel shows "not available in this host".
// const host: OsHost = { ...above, loadProjectGraph: async () => readGraphJson(), loadSkills: ..., loadRoutines: ... };

view.configure({ theme: 'light', projectName: 'Other project' });
view.notifyChange(); // for hosts that push changes without a watch callback
view.retry();        // after the host refreshed a refused session: re-watch and reload
view.dispose();
```

The host should load its own token sheet after the page's default
`theme.css` and `os-tokens.css` (the page's own `styles.css` reads only `--tok-*` variables) to
override the default colours.

## Scripts

- `npm run dev`: serves the demo (`demo/`) with the fixture host.
- `npm run type-check`: `tsc --noEmit`.
- `npm test`: the page's tests (fake host, fake timers, SSR render), and `test/wasm.test.mjs`, which runs every parity golden through the embedded core.
- `npx vite build --config vite.config.ts --outDir <dir>`: builds the demo.
