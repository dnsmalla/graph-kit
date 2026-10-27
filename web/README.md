# @dnsmalla/graph-kit-web

The Agentic OS **System** view as a React page. The page holds no transport of
its own: the app that hosts it supplies the data through the `OsHost` interface
(`src/host.ts`), so the same page runs in the LLM-IDE Mac app, in a dev browser
and in the demo.

## The OsHost contract

| Method | Purpose |
|---|---|
| `loadState(range)` | The `OsSnapshot` for `'day'` or `'week'`. Reject with `OsAuthError` when the session is refused. |
| `cancel(request)` | Stops a running item with the cancel request the server declared for it. |
| `watch(onChange, onStatus)` | Starts the change feed. `onChange` = state changed (the page re-fetches, debounced); `onStatus` = feed state. Returns unwatch. |
| `open(target)` | Navigates the host to `loop`, `autoTasks`, `settings` or `library`. `false` = nowhere to go. |
| `loadProjectGraph?`, `loadSkills?`, `loadRoutines?` | Reserved for later steps. Optional. |

Wire types (`OsSnapshot`, `OsCancel`, ...) come from graph-kit's core
(`typescript/src/system/types.ts`) and are re-exported from `src/index.ts`.

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
});

view.configure({ theme: 'light', projectName: 'Other project' });
view.notifyChange(); // for hosts that push changes without a watch callback
view.dispose();
```

The host should load its own token sheet after the page's default
`theme.css` (the page's own `styles.css` reads only `--tok-*` variables) to
override the default colours.

## Scripts

- `npm run dev`: serves the demo (`demo/`) with the fixture host.
- `npm run type-check`: `tsc --noEmit`.
- `npm test`: the page's tests (fake host, fake timers, SSR render).
- `npx vite build --config vite.config.ts --outDir <dir>`: builds the demo.
