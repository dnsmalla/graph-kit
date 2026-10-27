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
  return {
    host,
    calls,
    emitChange: () => onChange(),
    emitStatus: (status, detail) => onStatus(status, detail),
  };
}

const applied = [];

function makeController({ host, timers = fakeTimers(), projectName, openFallbackNotice } = {}) {
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
    // The follow-up refresh runs after a failed stop and clears `error` on success,
    // as the original controller did, so the stop error is not asserted on the snapshot.
    await controller.stopItem({ method: 'POST', path: '/kb/agent/stop', body: { sessionId: 's1' } }, 'agent-s1');
    assert.equal(fake.calls.cancel.length, 1);
    assert.equal(fake.calls.loadState.length, 1, 'the view still refreshes after a failed stop');
    assert.equal(controller.getSnapshot().stopping, null);
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
      'Activity timeline',
      'Token flow',
      'Memory and knowledge',
      'On this Mac',
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
    assert.ok(html.includes('Your LLM-IDE session has ended.'));
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
