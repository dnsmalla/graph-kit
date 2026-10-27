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
| `open(target)` | Navigates the host to `loop`, `autoTasks`, `settings` or `library`. `false` = nowhere to go. |
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

The page is an "Agentic OS" stage. A header (title, project, Day/Week, live
status) sits above three columns, and the brain is the centre:

- **Left:** System map, Running now, Skills (a card deck, count in the header).
- **Centre:** the project brain (`OrbitPanel`, a three.js view). The selected
  item is overlaid bottom-left. Below the brain are a colour legend and a
  "Recent" list of the latest five activity items (each row selects its ring
  item, so the list works without WebGL).
- **Right:** Token flow, Memory and knowledge, Routines (the Open Loop and Open
  Auto Tasks buttons sit in its header).

Below 1100px the columns stack: the brain first, then the left and right
panels. Category colours are the `--os-cat-*` tokens in `src/os-tokens.css`; the
light theme uses darker shades so each swatch keeps 3:1 against its surface.

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
separate asset. The generated files are committed (CI has no Rust).

To rebuild after a change to `rust/os-graph`, from the graph-kit root:

```sh
scripts/build-os-wasm.sh          # regenerates src/wasm/pkg/ and src/wasm/bytes.ts
scripts/build-os-wasm.sh --check  # builds into a temp dir and diffs against the committed files
```

`--check` is skipped (exit 0, with a message) when the local rustc differs from the one
recorded in `bytes.ts`: wasm output is only reproducible with the same toolchain. The
`wasm-bindgen` CLI must match the `wasm-bindgen` version in `rust/Cargo.lock` (0.2.129).

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
