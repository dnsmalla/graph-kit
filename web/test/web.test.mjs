// graph-kit-web tests: `npm test`. The TypeScript sources load through Vite's SSR
// loader (the same pipeline as the build), so no extra test framework is needed.
// Timers are fake and the host is a fake, so the suite never waits on a server.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let server;
let api;

before(async () => {
  server = await createServer({
    root: ROOT,
    configFile: false,
    plugins: [react()],
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const load = (p) => server.ssrLoadModule(p);
  api = {
    controller: await load('/src/controller.ts'),
    host: await load('/src/host.ts'),
    theme: await load('/src/theme.ts'),
    render: await load('/test/support/render.tsx'),
    fixture: await load('/demo/fixture.ts'),
    systemGraph: await load('/src/systemGraph.ts'),
  };
});

after(async () => {
  await server?.close();
});

/** Fake timers: nothing fires until a test calls runTimers(). */
function fakeTimers() {
  const pending = new Set();
  return {
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      pending.add(t);
      return t;
    },
    clearTimer: (t) => pending.delete(t),
    runTimers: (ms) => {
      for (const t of [...pending]) {
        if (ms === undefined || t.ms === ms) {
          pending.delete(t);
          t.fn();
        }
      }
    },
    count: () => pending.size,
    pendingMs: () => [...pending].map((t) => t.ms),
  };
}

const seeded = () => structuredClone(api.fixture.fixtureSnapshot);

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A promise the test settles by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A fake host. `loadState`, `cancel` and `open` may be overridden; the calls are
 * recorded, and `emitChange` / `emitStatus` play the host's change feed.
 */
function fakeHost(overrides = {}) {
  const calls = { loadState: [], cancel: [], open: [], watch: 0, unwatch: 0 };
  let onChange = () => {};
  let onStatus = () => {};
  const host = {
    loadState: (range) => {
      calls.loadState.push(range);
      return overrides.loadState ? overrides.loadState(range) : Promise.resolve(seeded());
    },
    cancel: (request) => {
      calls.cancel.push(request);
      return overrides.cancel ? overrides.cancel(request) : Promise.resolve();
    },
    watch: (change, status) => {
      calls.watch++;
      onChange = change;
      onStatus = status;
      return () => {
        calls.unwatch++;
      };
    },
    open: (target) => {
      calls.open.push(target);
      return overrides.open ? overrides.open(target) : true;
    },
  };
  // The optional data sets exist on the host only when the test supplies them.
  for (const name of ['loadProjectGraph', 'loadSkills', 'loadRoutines']) {
    if (!overrides[name]) continue;
    calls[name] = 0;
    host[name] = () => {
      calls[name]++;
      return overrides[name]();
    };
  }
  return {
    host,
    calls,
    emitChange: () => onChange(),
    emitStatus: (status, detail) => onStatus(status, detail),
  };
}

const applied = [];

function makeController({ host, timers = fakeTimers(), projectName, openFallbackNotice, signedOutNotice } = {}) {
  const t = timers;
  const controller = new api.controller.OsController(
    {
      host,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      applyTheme: (theme) => {
        applied.push(theme);
      },
      openFallbackNotice,
      signedOutNotice,
    },
    { projectName },
  );
  return { controller, timers: t };
}

describe('host contract', () => {
  it('OsAuthError carries its name and is an Error', () => {
    const err = new api.host.OsAuthError();
    assert.equal(err.name, 'OsAuthError');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof api.host.OsAuthError);
  });
});

describe('theme', () => {
  it('applyTheme sets data-theme and falls back to dark for unknown themes', () => {
    const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    assert.equal(api.theme.applyTheme('light', root), 'light');
    assert.equal(root.attrs['data-theme'], 'light');
    assert.equal(api.theme.applyTheme('neon', root), 'dark');
    assert.equal(api.theme.applyTheme(undefined, root), 'dark');
    assert.equal(root.attrs['data-theme'], 'dark');
    assert.deepEqual([...api.theme.THEMES], ['dark', 'light', 'midnight']);
  });
});

describe('controller: start, refresh and change feed', () => {
  it('start watches once, loads the state, and forwards the feed status', async () => {
    const fake = fakeHost();
    const { controller } = makeController({ host: fake.host });
    controller.start();
    controller.start();
    await flush();
    assert.equal(fake.calls.watch, 1, 'one feed per view');
    assert.deepEqual(fake.calls.loadState, ['day']);
    assert.ok(controller.getSnapshot().data, 'the first load fills the view');
    fake.emitStatus('reconnecting', 'Too many System views are open; retrying later');
    assert.equal(controller.getSnapshot().live, 'reconnecting');
    assert.equal(controller.getSnapshot().notice, 'Too many System views are open; retrying later');
    fake.emitStatus('live');
    assert.equal(controller.getSnapshot().notice, null);
    controller.dispose();
  });

  it('dispose unwatches the feed and cancels a pending refresh', () => {
    const fake = fakeHost();
    const { controller, timers } = makeController({ host: fake.host });
    controller.start();
    fake.emitChange();
    assert.equal(timers.count(), 1);
    controller.dispose();
    assert.equal(fake.calls.unwatch, 1);
    assert.equal(timers.count(), 0, 'the pending refresh is cancelled');
  });

  it('a change re-fetches once, debounced to 300 ms', async () => {
    const fake = fakeHost();
    const { controller, timers } = makeController({ host: fake.host });
    controller.start();
    await flush();
    const before = fake.calls.loadState.length;
    fake.emitChange();
    fake.emitChange();
    assert.deepEqual(timers.pendingMs(), [300], 'a burst leaves one pending refresh');
    timers.runTimers(300);
    await flush();
    assert.equal(fake.calls.loadState.length, before + 1, 'one debounced refresh');
    controller.dispose();
  });

  it('notifyChange schedules the same debounced refresh', async () => {
    const fake = fakeHost();
    const { controller, timers } = makeController({ host: fake.host });
    controller.start();
    await flush();
    const before = fake.calls.loadState.length;
    controller.notifyChange();
    timers.runTimers(300);
    await flush();
    assert.equal(fake.calls.loadState.length, before + 1);
    controller.dispose();
  });

  it('setRange re-fetches for the new window and ignores the same window', async () => {
    const fake = fakeHost();
    const { controller } = makeController({ host: fake.host });
    controller.start();
    await flush();
    controller.setRange('day');
    assert.equal(fake.calls.loadState.length, 1, 'same window: no refetch');
    controller.setRange('week');
    await flush();
    assert.deepEqual(fake.calls.loadState, ['day', 'week']);
    assert.equal(controller.getSnapshot().range, 'week');
    controller.dispose();
  });

  it('drops a stale response that arrives after a newer one', async () => {
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    const fake = fakeHost({ loadState: () => queue.shift().promise });
    const { controller } = makeController({ host: fake.host });
    const a = controller.refresh();
    const b = controller.refresh();
    const fresh = seeded();
    fresh.generatedAt = '2026-10-27T10:00:00.000Z';
    second.resolve(fresh);
    await b;
    first.resolve(seeded());
    await a;
    assert.equal(controller.getSnapshot().data.generatedAt, fresh.generatedAt, 'the newest answer wins');
    controller.dispose();
  });

  it('shows a load failure as an error and keeps going', async () => {
    const fake = fakeHost({ loadState: () => Promise.reject(new Error('boom')) });
    const { controller } = makeController({ host: fake.host });
    await controller.refresh();
    assert.equal(controller.getSnapshot().error, 'Could not load the System view: boom');
    assert.equal(controller.getSnapshot().loading, false);
    assert.equal(controller.getSnapshot().signedOut, false);
  });
});

describe('controller: configure', () => {
  it('applies the theme and the project, and fetches on a real project change only', async () => {
    const fake = fakeHost();
    const { controller } = makeController({ host: fake.host, projectName: 'A' });
    controller.start();
    await flush();
    const before = fake.calls.loadState.length;

    controller.configure({ theme: 'light', projectName: 'A' });
    await flush();
    assert.equal(fake.calls.loadState.length, before, 'same project: no refetch');
    assert.equal(applied.at(-1), 'light');

    controller.configure({ theme: 'midnight', projectName: 'B' });
    await flush();
    assert.equal(fake.calls.loadState.length, before + 1, 'new project: refetch');
    assert.equal(controller.getSnapshot().projectName, 'B');
    assert.equal(applied.at(-1), 'midnight');
    controller.dispose();
  });

  it('a configure with only a project keeps the theme; one with only a theme keeps the project', () => {
    const { controller } = makeController({ host: fakeHost().host, projectName: 'A' });
    const themes = applied.length;
    controller.configure({ projectName: 'B' });
    assert.equal(applied.length, themes, 'no theme given: none applied');
    controller.configure({ theme: 'light' });
    assert.equal(controller.getSnapshot().projectName, 'B', 'no project given: the project stays');
    assert.equal(applied.at(-1), 'light');
  });

  it('the initial project is shown before the first load', () => {
    const { controller } = makeController({ host: fakeHost().host, projectName: 'Demo project' });
    assert.equal(controller.getSnapshot().projectName, 'Demo project');
  });
});

describe('controller: stopItem', () => {
  it('sends the running item\'s declared cancel request exactly, then refreshes', async () => {
    const state = seeded();
    const cancel = state.running.chatTurns[0].cancel;
    const fake = fakeHost();
    const { controller } = makeController({ host: fake.host });
    controller.start();
    await flush();
    await controller.stopItem(cancel, 'chat-chat-1');
    await flush();
    assert.deepEqual(fake.calls.cancel, [cancel]);
    assert.equal(fake.calls.loadState.length, 2, 'refreshes after the stop');
    assert.equal(controller.getSnapshot().stopping, null);
    controller.dispose();
  });

  it('refuses a cancel request that is not a POST to an absolute path', async () => {
    const fake = fakeHost();
    const { controller } = makeController({ host: fake.host });
    await controller.stopItem({ method: 'GET', path: '/x' }, 'k');
    assert.equal(fake.calls.cancel.length, 0, 'the host is never asked');
    assert.equal(controller.getSnapshot().stopping, null);
  });

  it('shows a failed stop as an error and clears the stopping key', async () => {
    const fake = fakeHost({ cancel: () => Promise.reject(new Error('conflict')) });
    const { controller } = makeController({ host: fake.host });
    await controller.stopItem({ method: 'POST', path: '/kb/agent/stop', body: { sessionId: 's1' } }, 'agent-s1');
    assert.equal(fake.calls.cancel.length, 1);
    assert.equal(fake.calls.loadState.length, 1, 'the view still refreshes after a failed stop');
    assert.equal(controller.getSnapshot().stopping, null);
    assert.match(controller.getSnapshot().error, /Could not stop it/, 'the stop error survives the trailing refresh');
  });

  it('ignores a second stop while one is in flight', async () => {
    const pending = deferred();
    const fake = fakeHost({ cancel: () => pending.promise });
    const { controller } = makeController({ host: fake.host });
    const cancel = { method: 'POST', path: '/agent/v2/cancel', body: { chatSessionId: 'c1' } };
    const first = controller.stopItem(cancel, 'chat-c1');
    await controller.stopItem(cancel, 'chat-c2');
    assert.equal(controller.getSnapshot().stopping, 'chat-c1');
    assert.equal(fake.calls.cancel.length, 1);
    pending.resolve();
    await first;
    controller.dispose();
  });
});

describe('controller: sign-out', () => {
  it('an auth error from loadState marks the view signed out, with no retry scheduled', async () => {
    const fake = fakeHost({ loadState: () => Promise.reject(new api.host.OsAuthError()) });
    const { controller, timers } = makeController({ host: fake.host });
    controller.start();
    await flush();
    const snap = controller.getSnapshot();
    assert.equal(snap.signedOut, true);
    assert.equal(snap.live, 'stopped');
    assert.equal(fake.calls.unwatch, 1, 'the feed stops');
    assert.equal(timers.count(), 0, 'no retry is scheduled after a sign-out');
    controller.dispose();
  });

  it('an auth error from cancel also signs out', async () => {
    const fake = fakeHost({ cancel: () => Promise.reject(new api.host.OsAuthError()) });
    const { controller } = makeController({ host: fake.host });
    await controller.stopItem({ method: 'POST', path: '/agent/v2/cancel', body: { chatSessionId: 'c1' } }, 'k');
    assert.equal(controller.getSnapshot().signedOut, true);
    assert.equal(controller.getSnapshot().stopping, null);
  });

  it('starting again after a sign-out resumes the view with fresh data', async () => {
    let refusing = true;
    const fake = fakeHost({
      loadState: () => (refusing ? Promise.reject(new api.host.OsAuthError()) : Promise.resolve(seeded())),
    });
    const { controller } = makeController({ host: fake.host });
    controller.start();
    await flush();
    assert.equal(controller.getSnapshot().signedOut, true);

    refusing = false;
    controller.start();
    await flush();
    const snap = controller.getSnapshot();
    assert.equal(snap.signedOut, false);
    assert.ok(snap.data, 'data loads after the new session');
    assert.equal(fake.calls.watch, 2, 'the feed is watched again');
    controller.dispose();
  });
});

describe('controller: open', () => {
  it('asks the host to open a screen', () => {
    const fake = fakeHost();
    const { controller } = makeController({ host: fake.host });
    controller.open('autoTasks');
    assert.deepEqual(fake.calls.open, ['autoTasks']);
    assert.equal(controller.getSnapshot().notice, null);
  });

  it('falls back to a notice when the host has nowhere to go', () => {
    const fake = fakeHost({ open: () => false });
    const { controller } = makeController({ host: fake.host });
    controller.open('loop');
    assert.equal(controller.getSnapshot().notice, 'Open this in the app.');
  });

  it('uses the configured fallback notice', () => {
    const fake = fakeHost({ open: () => false });
    const { controller } = makeController({ host: fake.host, openFallbackNotice: 'Open this in the LLM-IDE app.' });
    controller.open('loop');
    assert.equal(controller.getSnapshot().notice, 'Open this in the LLM-IDE app.');
  });
});

describe('rendering', () => {
  async function renderSeeded(state) {
    const fake = fakeHost({ loadState: () => Promise.resolve(state) });
    const { controller } = makeController({ host: fake.host, projectName: 'Demo project' });
    controller.start();
    await flush();
    return { html: api.render.renderApp(controller), controller };
  }

  it('shows the loading text before the first load', () => {
    const { controller } = makeController({ host: fakeHost().host });
    const html = api.render.renderApp(controller);
    assert.ok(html.includes('Loading the System view'));
    assert.ok(!html.includes('os-grid'));
    controller.dispose();
  });

  it('renders every section with the fixture', async () => {
    const { html, controller } = await renderSeeded(seeded());
    for (const heading of [
      'System map',
      'Running now',
      'Skills',
      'Project brain',
      'Recent',
      'Token flow',
      'Memory and knowledge',
      'Routines',
    ]) {
      assert.ok(html.includes(heading), `section "${heading}" is rendered`);
    }
    assert.ok(html.includes('Demo project'));
    assert.ok(html.includes('aria-label="Stop chat turn"'), 'chat turn has a Stop button');
    assert.ok(html.includes('aria-label="Stop meeting agent"'), 'meeting agent has a Stop button');
    assert.ok(html.includes('Stop it in the Mac app'), 'live capture has no Stop (cancel is null)');
    assert.ok(html.includes('Open Loop') && html.includes('Open Auto Tasks'));
    assert.ok(html.includes('aria-pressed="true"'), 'the day toggle is pressed');
    controller.dispose();
  });

  it('shows the empty states on a fresh install', async () => {
    const empty = seeded();
    empty.running = { chatTurns: [], meetingAgentRuns: [], liveSessions: [] };
    empty.activity = { unread: 0, items: [] };
    empty.tokens.totals = { calls: 0, runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billable: 0 };
    empty.tokens.byModel = [];
    empty.tokens.bySource = [];
    empty.tokens.byEndpoint = [];
    empty.tokens.turnComposition = {
      turns: 0,
      avgFirstCallPromptTokens: null,
      avgPrefixTokens: null,
      avgFenceTokens: null,
      avgToolResultTokens: null,
    };
    empty.knowledge = {
      sources: { total: 0, byKind: [] },
      meetings: { count: 0 },
      pendingReviews: 0,
      outcomes: { total: 0, terminal: 0, byState: {} },
      codeGraph: [],
      projectMemory: [],
    };
    const { html, controller } = await renderSeeded(empty);
    assert.ok(html.includes('Nothing is running'));
    assert.ok(html.includes('No activity yet'));
    assert.ok(html.includes('No model calls in this window'));
    assert.ok(html.includes('Nothing indexed yet'));
    assert.ok(html.includes('Open Library'));
    controller.dispose();
  });

  it('renders the sign-out banner after a refused session', async () => {
    const fake = fakeHost({ loadState: () => Promise.reject(new api.host.OsAuthError()) });
    const { controller } = makeController({ host: fake.host });
    controller.start();
    await flush();
    const html = api.render.renderApp(controller);
    assert.ok(html.includes('Your session has ended. Sign in again.'), 'the default notice is shown');
    assert.ok(!html.includes('LLM-IDE'), 'the default notice names no host');
    controller.dispose();
  });

  it('renders a configured signed-out notice', async () => {
    const fake = fakeHost({ loadState: () => Promise.reject(new api.host.OsAuthError()) });
    const { controller } = makeController({ host: fake.host, signedOutNotice: 'Sign in to the host app.' });
    assert.equal(controller.signedOutNotice, 'Sign in to the host app.');
    controller.start();
    await flush();
    assert.ok(api.render.renderApp(controller).includes('Sign in to the host app.'));
    controller.dispose();
  });
});

describe('controller: project graph, skills, routines and selection', () => {
  const graph = () => api.fixture.buildDemoProjectGraph();

  it('loads the graph, skills and routines once on start, and not on a change refresh', async () => {
    const fake = fakeHost({
      loadProjectGraph: () => Promise.resolve(graph()),
      loadSkills: () => Promise.resolve(api.fixture.demoSkills),
      loadRoutines: () => Promise.resolve(api.fixture.demoRoutines),
    });
    const { controller, timers } = makeController({ host: fake.host, projectName: 'Demo' });
    controller.start();
    await flush();
    const state = controller.getSnapshot();
    assert.equal(fake.calls.loadProjectGraph, 1);
    assert.equal(fake.calls.loadSkills, 1);
    assert.equal(fake.calls.loadRoutines, 1);
    assert.equal(state.projectGraphStatus, 'ready');
    assert.equal(state.skills.length, 8);
    assert.equal(state.routines.length, 5);

    fake.emitChange();
    timers.runTimers(300);
    await flush();
    assert.equal(fake.calls.loadState.length, 2, 'the snapshot is re-fetched');
    assert.equal(fake.calls.loadProjectGraph, 1, 'the graph is not reloaded on a change');
    assert.equal(fake.calls.loadSkills, 1);
    assert.equal(fake.calls.loadRoutines, 1);
    controller.dispose();
  });

  it('reloads them on a real project change and on retry, not on a same-project configure', async () => {
    const fake = fakeHost({
      loadProjectGraph: () => Promise.resolve(graph()),
      loadSkills: () => Promise.resolve([]),
      loadRoutines: () => Promise.resolve([]),
    });
    const { controller } = makeController({ host: fake.host, projectName: 'A' });
    controller.start();
    await flush();
    controller.configure({ projectName: 'A' });
    await flush();
    assert.equal(fake.calls.loadProjectGraph, 1);
    controller.configure({ projectName: 'B' });
    await flush();
    assert.equal(fake.calls.loadProjectGraph, 2);
    assert.equal(fake.calls.loadSkills, 2);
    assert.equal(fake.calls.loadRoutines, 2);
    controller.retry();
    await flush();
    assert.equal(fake.calls.loadProjectGraph, 3);
    assert.equal(fake.calls.loadRoutines, 3);
    controller.dispose();
  });

  it('a host without the optional methods gives status none and null, and no page error', async () => {
    const { controller } = makeController({ host: fakeHost().host });
    controller.start();
    await flush();
    const state = controller.getSnapshot();
    assert.equal(state.projectGraphStatus, 'none');
    assert.equal(state.skillsStatus, 'none');
    assert.equal(state.routinesStatus, 'none');
    assert.equal(state.skills, null);
    assert.equal(state.routines, null);
    assert.equal(state.error, null);
    controller.dispose();
  });

  it('an invalid graph shape is treated as no graph', async () => {
    for (const bad of [null, undefined, 'graph', {}, { nodes: 'x', edges: [] }, { nodes: [] }]) {
      const fake = fakeHost({ loadProjectGraph: () => Promise.resolve(bad) });
      const { controller } = makeController({ host: fake.host });
      controller.start();
      await flush();
      assert.equal(controller.getSnapshot().projectGraphStatus, 'none', `shape ${JSON.stringify(bad)}`);
      assert.equal(controller.getSnapshot().projectGraph, null);
      controller.dispose();
    }
    const ok = fakeHost({ loadProjectGraph: () => Promise.resolve({ nodes: [], edges: [] }) });
    const { controller } = makeController({ host: ok.host });
    controller.start();
    await flush();
    assert.equal(controller.getSnapshot().projectGraphStatus, 'ready', 'an empty but well-formed graph is ready');
    controller.dispose();
  });

  it('a failing loadSkills sets only its own status and never the page error', async () => {
    const fake = fakeHost({
      loadProjectGraph: () => Promise.resolve(graph()),
      loadSkills: () => Promise.reject(new Error('skills down')),
      loadRoutines: () => Promise.resolve(api.fixture.demoRoutines),
    });
    const { controller } = makeController({ host: fake.host });
    controller.start();
    await flush();
    const state = controller.getSnapshot();
    assert.equal(state.skillsStatus, 'error');
    assert.equal(state.skills, null);
    assert.equal(state.error, null);
    assert.ok(state.data, 'the snapshot still loads');
    assert.equal(state.routinesStatus, 'ready');
    assert.equal(state.projectGraphStatus, 'ready');
    controller.dispose();
  });

  it('a failing loadProjectGraph sets only the graph status', async () => {
    const fake = fakeHost({ loadProjectGraph: () => Promise.reject(new Error('graph down')) });
    const { controller } = makeController({ host: fake.host });
    controller.start();
    await flush();
    assert.equal(controller.getSnapshot().projectGraphStatus, 'error');
    assert.equal(controller.getSnapshot().projectGraph, null);
    assert.equal(controller.getSnapshot().error, null);
    controller.dispose();
  });

  it('drops a stale graph that lands after a newer project loaded', async () => {
    const pending = [];
    const fake = fakeHost({
      loadProjectGraph: () => {
        const d = deferred();
        pending.push(d);
        return d.promise;
      },
    });
    const { controller } = makeController({ host: fake.host, projectName: 'A' });
    controller.start();
    controller.configure({ projectName: 'B' });
    const first = graph();
    const second = { nodes: [], edges: [] };
    pending[1].resolve(second);
    await flush();
    pending[0].resolve(first);
    await flush();
    assert.equal(controller.getSnapshot().projectGraph, second, 'the newer project wins');
    assert.equal(controller.getSnapshot().projectGraphStatus, 'ready');
    controller.dispose();
  });

  it('dispose drops late graph, skill and routine responses', async () => {
    const d = deferred();
    const r = deferred();
    const fake = fakeHost({
      loadProjectGraph: () => d.promise,
      loadSkills: () => r.promise,
      loadRoutines: () => r.promise,
    });
    const { controller } = makeController({ host: fake.host });
    controller.start();
    const before = controller.getSnapshot();
    controller.dispose();
    d.resolve(graph());
    r.resolve([]);
    await flush();
    assert.equal(controller.getSnapshot(), before, 'the state is unchanged after dispose');
    assert.equal(controller.getSnapshot().projectGraph, null);
  });

  it('select sets a copy of the item, clears it with null, and refuses a bad type', () => {
    const { controller } = makeController({ host: fakeHost().host });
    const item = { type: 'ring', id: 'activity:7', label: 'Chat turn', detail: 'chat_turn' };
    controller.select(item);
    assert.deepEqual(controller.getSnapshot().selected, item);
    assert.notEqual(controller.getSnapshot().selected, item, 'the state holds a copy');
    controller.select({ type: 'bogus', id: 'x', label: 'x', detail: 'x' });
    assert.deepEqual(controller.getSnapshot().selected, item, 'a bad type leaves the selection alone');
    controller.select(null);
    assert.equal(controller.getSnapshot().selected, null);
    controller.dispose();
  });

  it('a project change clears the selection and the previous project data', async () => {
    const fake = fakeHost({ loadProjectGraph: () => Promise.resolve(graph()) });
    const { controller } = makeController({ host: fake.host, projectName: 'A' });
    controller.start();
    await flush();
    controller.select({ type: 'core', id: 'c1-1', label: 'fn1', detail: 'code' });
    controller.configure({ projectName: 'B' });
    assert.equal(controller.getSnapshot().selected, null);
    assert.equal(controller.getSnapshot().projectGraph, null);
    controller.dispose();
  });
});

describe('rendering: the Agentic OS layout', () => {
  async function renderWith(overrides, snapshot = seeded()) {
    const fake = fakeHost({ loadState: () => Promise.resolve(snapshot), ...overrides });
    const { controller } = makeController({ host: fake.host, projectName: 'Demo project' });
    controller.start();
    await flush();
    return { html: api.render.renderApp(controller), controller };
  }

  const graphOverrides = {
    loadProjectGraph: () => Promise.resolve(api.fixture.buildDemoProjectGraph()),
    loadSkills: () => Promise.resolve(api.fixture.demoSkills),
    loadRoutines: () => Promise.resolve(api.fixture.demoRoutines),
  };

  it('lays the page out as three columns with the brain in the middle', async () => {
    const { html, controller } = await renderWith(graphOverrides);
    const left = html.indexOf('os-col-left');
    const centre = html.indexOf('os-centre');
    const right = html.indexOf('os-col-right');
    assert.ok(left > 0 && centre > left && right > centre, 'DOM order is left, centre, right');
    assert.ok(html.indexOf('System map') < centre, 'the system map is in the left column');
    assert.ok(html.indexOf('Token flow') > centre, 'token flow is in the right column');
    assert.ok(html.indexOf('Routines') > centre, 'routines are in the right column');
    controller.dispose();
  });

  it('renders skills and routines with their data, and the header buttons', async () => {
    const { html, controller } = await renderWith(graphOverrides);
    assert.ok(html.includes(api.fixture.demoSkills[0].name));
    assert.ok(html.includes(api.fixture.demoSkills[0].description));
    assert.ok(html.includes('>8<'), 'the skill count sits in the header');
    assert.ok(html.includes('Regression sweep'));
    assert.ok(html.includes('Every weekday at 09:00'));
    assert.ok(html.includes('Open Loop') && html.includes('Open Auto Tasks'));
    controller.dispose();
  });

  it('shows the empty and not-available states for skills and routines', async () => {
    const none = await renderWith({});
    assert.ok(none.html.includes('Skills are not available in this host.'));
    assert.ok(none.html.includes('Routines are not available in this host.'));
    assert.ok(none.html.includes('Open Loop'), 'the Loop button stays even without routines');
    none.controller.dispose();

    const empty = await renderWith({ loadSkills: () => Promise.resolve([]), loadRoutines: () => Promise.resolve([]) });
    assert.ok(empty.html.includes('No skills yet.'));
    assert.ok(empty.html.includes('No routines yet.'));
    empty.controller.dispose();
  });

  it('shows the loading text over the brain while the graph loads, and the error when it fails', async () => {
    const pending = deferred();
    const loading = await renderWith({ loadProjectGraph: () => pending.promise });
    assert.ok(loading.html.includes('Loading the project graph'));
    loading.controller.dispose();

    const failed = await renderWith({ loadProjectGraph: () => Promise.reject(new Error('down')) });
    assert.ok(failed.html.includes('Could not load the project graph.'));
    failed.controller.dispose();
  });

  it('the recent list shows at most five items', async () => {
    const snap = seeded();
    const template = snap.activity.items[0];
    snap.activity.items = Array.from({ length: 12 }, (_, i) => ({ ...template, id: 500 - i, title: `Item ${i}` }));
    const { html, controller } = await renderWith({}, snap);
    const rows = html.split('class="os-recent-item"').length - 1;
    assert.equal(rows, 5);
    assert.ok(html.includes('Item 0') && !html.includes('Item 5'));
    controller.dispose();
  });

  it('the recent list and the selection both render for a ring item', async () => {
    const snap = seeded();
    const { html, controller } = await renderWith(graphOverrides, snap);
    const first = snap.activity.items[0];
    controller.select({ type: 'ring', id: `activity:${first.id}`, label: first.title, detail: first.kind });
    const after = api.render.renderApp(controller);
    assert.ok(after.includes('os-selection'));
    assert.ok(after.includes(first.title));
    assert.ok(after.includes('>Close<'));
    controller.dispose();
  });

  it('leaves no OnThisMac or Activity sections behind', async () => {
    const { html, controller } = await renderWith(graphOverrides);
    assert.ok(!html.includes('sec-mac'));
    assert.ok(!html.includes('sec-activity'));
    assert.ok(!html.includes('Activity timeline'));
    assert.ok(!html.includes('On this Mac'));
    controller.dispose();
  });
});

describe('system view: memoisation and caps', () => {
  it('returns the same view for the same snapshot activity and project', () => {
    const s = seeded();
    const p = api.fixture.buildDemoProjectGraph();
    const first = api.systemGraph.computeSystemView(s, p);
    assert.equal(api.systemGraph.computeSystemView(s, p), first, 'same inputs, same object');
    assert.notEqual(api.systemGraph.computeSystemView({ ...s, activity: { ...s.activity } }, p), first, 'new activity recomputes');
    assert.notEqual(api.systemGraph.computeSystemView(s, { ...p }), first, 'new project recomputes');
  });

  it('caps the ring at 24 items and the core at 4000 nodes, and never raises a cap', () => {
    const s = seeded();
    const template = s.activity.items[0];
    s.activity.items = Array.from({ length: 30 }, (_, i) => ({ ...template, id: 900 - i }));
    const p = api.fixture.buildDemoProjectGraph();
    assert.equal(api.systemGraph.computeSystemView(s, p).graph.ring.length, 24);
    assert.equal(api.systemGraph.computeSystemView(s, p, { maxRingItems: 50 }).graph.ring.length, 24, 'a larger request is capped');
    const small = api.systemGraph.computeSystemView(s, p, { maxCoreNodes: 100 });
    assert.ok(small.graph.core.length <= 100);
  });

  it('an empty input gives an empty view with a layout', () => {
    const view = api.systemGraph.computeSystemView(null, null);
    assert.equal(view.graph.core.length, 0);
    assert.equal(view.graph.ring.length, 0);
    assert.equal(view.layout.core.size, 0);
  });
});

describe('controller: lifecycle guards and sign-out recovery', () => {
  it('a late change after dispose schedules no refresh and loads nothing', async () => {
    const fake = fakeHost();
    const { controller, timers } = makeController({ host: fake.host });
    controller.start();
    await flush();
    controller.dispose();
    const loads = fake.calls.loadState.length;
    fake.emitChange();
    controller.notifyChange();
    assert.equal(timers.count(), 0, 'no refresh is scheduled');
    timers.runTimers();
    await flush();
    assert.equal(fake.calls.loadState.length, loads, 'nothing is loaded after dispose');
  });

  it('an in-flight response that lands after dispose leaves the state unchanged', async () => {
    const pending = deferred();
    const fake = fakeHost({ loadState: () => pending.promise });
    const { controller } = makeController({ host: fake.host });
    const refreshing = controller.refresh();
    controller.dispose();
    const before = controller.getSnapshot();
    pending.resolve(seeded());
    await refreshing;
    assert.equal(controller.getSnapshot(), before, 'no set() after dispose');
    assert.equal(controller.getSnapshot().data, null);
  });

  it('a stop that finishes after dispose does not refresh', async () => {
    const pending = deferred();
    const fake = fakeHost({ cancel: () => pending.promise });
    const { controller } = makeController({ host: fake.host });
    const stopping = controller.stopItem({ method: 'POST', path: '/agent/v2/cancel', body: {} }, 'k');
    controller.dispose();
    pending.resolve();
    await stopping;
    assert.equal(fake.calls.loadState.length, 0, 'no trailing refresh after dispose');
  });

  it('a slower pre-401 success cannot clear the sign-out', async () => {
    const slow = deferred();
    const fake = fakeHost({
      loadState: () => slow.promise,
      cancel: () => Promise.reject(new api.host.OsAuthError()),
    });
    const { controller } = makeController({ host: fake.host });
    const refreshing = controller.refresh();
    await controller.stopItem({ method: 'POST', path: '/agent/v2/cancel', body: {} }, 'k');
    assert.equal(controller.getSnapshot().signedOut, true);
    slow.resolve(seeded());
    await refreshing;
    const snap = controller.getSnapshot();
    assert.equal(snap.signedOut, true, 'the stale success does not clear the sign-out');
    assert.equal(snap.loading, false);
    controller.dispose();
  });

  it('a 401 while already signed out still sets loading to false', async () => {
    const fake = fakeHost({ loadState: () => Promise.reject(new api.host.OsAuthError()) });
    const { controller } = makeController({ host: fake.host });
    await controller.refresh();
    await controller.refresh();
    assert.equal(controller.getSnapshot().signedOut, true);
    assert.equal(controller.getSnapshot().loading, false);
    controller.dispose();
  });

  it('retry() re-watches the feed, clears the sign-out and reloads', async () => {
    let refusing = true;
    const fake = fakeHost({
      loadState: () => (refusing ? Promise.reject(new api.host.OsAuthError()) : Promise.resolve(seeded())),
    });
    const { controller } = makeController({ host: fake.host });
    controller.start();
    await flush();
    assert.equal(controller.getSnapshot().signedOut, true);
    assert.equal(fake.calls.unwatch, 1, 'the feed stopped with the sign-out');

    refusing = false;
    controller.retry();
    await flush();
    const snap = controller.getSnapshot();
    assert.equal(snap.signedOut, false);
    assert.ok(snap.data, 'data loads after retry');
    assert.equal(fake.calls.watch, 2, 'the feed is watched again');
    controller.dispose();
  });

  it('a refresh that clears a sign-out re-establishes the feed', async () => {
    let refusing = true;
    const fake = fakeHost({
      loadState: () => (refusing ? Promise.reject(new api.host.OsAuthError()) : Promise.resolve(seeded())),
    });
    const { controller } = makeController({ host: fake.host });
    controller.start();
    await flush();
    refusing = false;
    await controller.refresh();
    assert.equal(controller.getSnapshot().signedOut, false);
    assert.equal(fake.calls.watch, 2, 'the feed is back after the host recovered');
    controller.dispose();
  });

  it('a watch that returns no unwatch function is still watched once', async () => {
    let watches = 0;
    const host = {
      loadState: () => Promise.resolve(seeded()),
      cancel: () => Promise.resolve(),
      watch: () => {
        watches++;
        return undefined;
      },
      open: () => true,
    };
    const { controller } = makeController({ host });
    controller.start();
    controller.start();
    await flush();
    assert.equal(watches, 1, 'one feed per view, even without an unwatch function');
    controller.dispose();
  });
});

describe('styles', () => {
  it('uses only --tok-* colours (no literal colours in styles.css)', () => {
    const css = readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
    const literal = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    assert.deepEqual(literal, []);
  });

  it('keeps the default token sheet in step with the source of truth', () => {
    const theme = readFileSync(path.join(ROOT, 'src/theme.css'), 'utf8');
    assert.ok(theme.includes('--tok-color-accent:'));
    assert.ok(theme.includes(':root[data-theme="light"]'));
  });
});
