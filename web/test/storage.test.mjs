// The Storage hub (10th): the clear state machine (dry run, explicit confirm, a stale preview's
// re-preview, every error path), compact and retention through a fake host, the overview's controls
// with and without host methods, and the recent runs on the Agents hub. `npm test`.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { uniqueCacheDir } from './support/cacheDir.mjs';
import react from '@vitejs/plugin-react';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let server;
let api;

before(async () => {
  server = await createServer({
    root: ROOT,
    configFile: false,
    cacheDir: uniqueCacheDir(),
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
    flow: await load('/src/storageFlow.ts'),
    format: await load('/src/format.ts'),
    render: await load('/test/support/render.tsx'),
    fixture: await load('/demo/fixture.ts'),
  };
});

after(async () => {
  await server?.close();
});

const immediate = { setTimer: () => null, clearTimer: () => {}, applyTheme: () => {} };
const seeded = () => structuredClone(api.fixture.fixtureSnapshot);
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

const DRY = (previewId, scope = 'raw') => ({
  dryRun: true,
  scope,
  beforeDays: null,
  wouldDelete: { agent_runs: 3, agent_tool_events: 7, turn_composition: 2, agent_daily: 0, agent_daily_tools: 0 },
  total: 12,
  previewId,
  expiresAt: '2026-10-28 10:05:00',
});

const REAL = { dryRun: false, scope: 'raw', beforeDays: null, deleted: { agent_runs: 3, agent_tool_events: 7, turn_composition: 2, agent_daily: 0, agent_daily_tools: 0 }, total: 12 };

/** A host whose storage methods are scripted per call: each is a function of the request. */
function storageHost(extra = {}) {
  const calls = { clear: [], compact: 0, settings: 0, retention: [], loadState: 0 };
  const host = {
    loadState: async () => {
      calls.loadState++;
      return seeded();
    },
    cancel: async () => {},
    watch: () => () => {},
    open: () => true,
    ...extra.base,
  };
  if (extra.clear) {
    host.storageClear = (req) => {
      calls.clear.push(structuredClone(req));
      return extra.clear(req, calls.clear.length);
    };
  }
  if (extra.compact) {
    host.storageCompact = () => {
      calls.compact++;
      return extra.compact();
    };
  }
  if (extra.settings) {
    host.storageSettings = () => {
      calls.settings++;
      return extra.settings();
    };
  }
  if (extra.retention) {
    host.setStorageRetention = (days) => {
      calls.retention.push(days);
      return extra.retention(days);
    };
  }
  return { host, calls };
}

function controllerWith(host) {
  return new api.controller.OsController({ host, ...immediate });
}

/** A controller with loaded data, so the overview can render. */
async function loaded(host) {
  const controller = controllerWith(host);
  controller.start();
  await flush();
  return controller;
}

describe('storage flows (pure)', () => {
  it('only the three stale codes re-preview; every other clear failure fails with its message', () => {
    for (const code of ['PREVIEW_EXPIRED', 'PREVIEW_INVALID', 'preview_stale']) {
      assert.ok(api.flow.isStalePreview(code), code);
      const action = api.flow.clearFailure(code, 'x');
      assert.equal(action.action, 'repreview', code);
      assert.match(action.notice, /fresh/i, code);
    }
    assert.equal(api.flow.isStalePreview('busy'), false);
    const busy = api.flow.clearFailure('busy');
    assert.equal(busy.action, 'fail');
    assert.match(busy.message, /busy/);
    const refused = api.flow.clearFailure('PREVIEW_REQUIRED');
    assert.equal(refused.action, 'fail');
    assert.match(refused.message, /preview first/);
    const unknown = api.flow.clearFailure('weird', 'disk gone');
    assert.equal(unknown.action, 'fail');
    assert.match(unknown.message, /disk gone/);
  });

  it('compact has typed messages for busy, disk_space and store_down, and a default', () => {
    const busy = api.flow.compactErrorMessage('busy');
    const disk = api.flow.compactErrorMessage('disk_space');
    const down = api.flow.compactErrorMessage('store_down');
    assert.match(busy, /in progress/);
    assert.match(disk, /disk space/);
    assert.match(down, /not available/);
    assert.equal(new Set([busy, disk, down]).size, 3);
    assert.match(api.flow.compactErrorMessage('boom', 'nope'), /nope/);
  });

  it('the retention rule is a whole number of days from 7 to 365', () => {
    assert.equal(api.flow.retentionError(7), null);
    assert.equal(api.flow.retentionError(365), null);
    assert.equal(api.flow.retentionError(90), null);
    assert.ok(api.flow.retentionError(6));
    assert.ok(api.flow.retentionError(366));
    assert.ok(api.flow.retentionError(7.5));
    assert.ok(api.flow.retentionError(Number.NaN));
    assert.ok(api.flow.retentionError('30'));
  });

  it('confirming moves only a shown preview to clearing; any other state is unchanged', () => {
    const idle = { kind: 'idle' };
    assert.equal(api.flow.confirming(idle), idle);
    const preview = api.flow.previewed('raw', null, DRY('p1'));
    assert.equal(preview.kind, 'confirm');
    assert.equal(api.flow.confirming(preview).kind, 'clearing');
    assert.equal(api.flow.confirming(api.flow.confirming(preview)).kind, 'clearing');
  });

  it('a relative time reads a SQLite-style string as UTC, and the latest timestamp is compared as a time', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    assert.equal(api.format.fmtRelative('2026-10-28 10:00:00', now), '2 hours ago');
    assert.equal(api.format.fmtRelative('2026-10-28T10:00:00Z', now), '2 hours ago');
    assert.equal(api.format.latestTime(['2026-10-28T09:00:00+09:00', '2026-10-28 00:30:00', null]), '2026-10-28 00:30:00');
    assert.equal(api.format.latestTime([null, undefined]), null);
    assert.equal(api.format.latestTime(['not a date']), null);
  });

  it('the count rows and their total cover every table of a clear', () => {
    const counts = DRY('p').wouldDelete;
    assert.equal(api.flow.totalOf(counts), 12);
    assert.deepEqual(api.flow.countRows(counts).map((r) => r.key), [
      'agent_runs',
      'agent_tool_events',
      'turn_composition',
      'agent_daily',
      'agent_daily_tools',
    ]);
  });
});

describe('the Clear flow through the controller', () => {
  it('a dry run shows the counts, then a confirm sends the previewId and refreshes', async () => {
    const { host, calls } = storageHost({
      clear: (req, n) => (req.dryRun ? DRY('p1', req.scope) : REAL),
    });
    const controller = await loaded(host);
    await controller.storageClearPreview('raw', null);
    let s = controller.getSnapshot().storage;
    assert.equal(s.clear.kind, 'confirm');
    assert.equal(s.clear.preview.previewId, 'p1');
    assert.equal(calls.clear.length, 1);
    assert.deepEqual(calls.clear[0], { scope: 'raw', dryRun: true });
    const before = calls.loadState;
    await controller.storageClearConfirm();
    s = controller.getSnapshot().storage;
    assert.equal(s.clear.kind, 'cleared');
    assert.equal(s.clear.total, 12);
    assert.deepEqual(calls.clear[1], { scope: 'raw', dryRun: false, previewId: 'p1' });
    assert.ok(calls.loadState > before, 'the page re-fetches after a clear');
  });

  it('beforeDays is sent only when it is set', async () => {
    const { host, calls } = storageHost({ clear: (req) => (req.dryRun ? { ...DRY('p9', 'all'), beforeDays: 30 } : REAL) });
    const controller = await loaded(host);
    await controller.storageClearPreview('all', 30);
    assert.equal(calls.clear[0].beforeDays, 30);
    assert.equal(calls.clear[0].scope, 'all');
    assert.ok(!('beforeDays' in calls.clear[0]) || calls.clear[0].beforeDays === 30);
  });

  it('a confirm with no shown preview sends nothing', async () => {
    const { host, calls } = storageHost({ clear: () => REAL });
    const controller = await loaded(host);
    await controller.storageClearConfirm();
    assert.equal(calls.clear.length, 0);
    assert.equal(controller.getSnapshot().storage.clear.kind, 'idle');
  });

  it('cancel returns the flow to idle and sends nothing more', async () => {
    const { host, calls } = storageHost({ clear: (req) => DRY('p1', req.scope) });
    const controller = await loaded(host);
    await controller.storageClearPreview('raw', null);
    controller.storageClearCancel();
    assert.equal(controller.getSnapshot().storage.clear.kind, 'idle');
    await controller.storageClearConfirm();
    assert.equal(calls.clear.length, 1, 'only the preview was sent');
  });

  for (const code of ['PREVIEW_EXPIRED', 'PREVIEW_INVALID', 'preview_stale']) {
    it(`a ${code} on confirm re-previews once, with a notice, and never clears without a second confirm`, async () => {
      const { host, calls } = storageHost({
        clear: (req, n) => {
          if (n === 1) return DRY('p1');
          if (n === 2) throw new api.host.OsStorageError(code, code);
          return DRY('p2');
        },
      });
      const controller = await loaded(host);
      await controller.storageClearPreview('raw', null);
      await controller.storageClearConfirm();
      const s = controller.getSnapshot().storage;
      assert.equal(s.clear.kind, 'confirm', 'back at a shown preview');
      assert.equal(s.clear.preview.previewId, 'p2', 'the fresh preview');
      assert.match(s.clear.notice, /fresh/i);
      assert.equal(calls.clear.filter((r) => !r.dryRun).length, 1, 'no real clear was sent after the stale one');
      assert.equal(calls.clear.length, 3, 'preview, the stale clear, one re-preview');
    });
  }

  it('a re-preview that also fails shows that failure, and stops', async () => {
    const { host, calls } = storageHost({
      clear: (req, n) => {
        if (n === 1) return DRY('p1');
        if (n === 2) throw new api.host.OsStorageError('PREVIEW_EXPIRED', 'expired');
        throw new api.host.OsStorageError('store_down', 'store down');
      },
    });
    const controller = await loaded(host);
    await controller.storageClearPreview('raw', null);
    await controller.storageClearConfirm();
    const s = controller.getSnapshot().storage;
    assert.equal(s.clear.kind, 'failed');
    assert.match(s.clear.message, /not available/);
    assert.equal(calls.clear.length, 3, 'one re-preview only');
  });

  it('a real clear that fails with a typed store error shows it and does not refresh as cleared', async () => {
    const { host } = storageHost({
      clear: (req) => {
        if (req.dryRun) return DRY('p1');
        throw new api.host.OsStorageError('store_down', 'store down');
      },
    });
    const controller = await loaded(host);
    await controller.storageClearPreview('raw', null);
    await controller.storageClearConfirm();
    const s = controller.getSnapshot().storage;
    assert.equal(s.clear.kind, 'failed');
    assert.match(s.clear.message, /not available/);
  });

  it('a busy store on the preview fails with the busy message', async () => {
    const { host } = storageHost({ clear: () => { throw new api.host.OsStorageError('busy', 'busy'); } });
    const controller = await loaded(host);
    await controller.storageClearPreview('all', null);
    const s = controller.getSnapshot().storage;
    assert.equal(s.clear.kind, 'failed');
    assert.match(s.clear.message, /busy/);
  });

  it('an unknown failure carries the host message', async () => {
    const { host } = storageHost({ clear: () => { throw new Error('the disk went away'); } });
    const controller = await loaded(host);
    await controller.storageClearPreview('raw', null);
    assert.match(controller.getSnapshot().storage.clear.message, /disk went away/);
  });

  it('a refused session during a clear signs the view out', async () => {
    const { host } = storageHost({
      clear: (req) => {
        if (req.dryRun) return DRY('p1');
        throw new api.host.OsAuthError();
      },
    });
    const controller = await loaded(host);
    await controller.storageClearPreview('raw', null);
    await controller.storageClearConfirm();
    assert.equal(controller.getSnapshot().signedOut, true);
  });

  it('without host.storageClear the page offers no clear and sends nothing', async () => {
    const { host } = storageHost({});
    const controller = await loaded(host);
    assert.equal(controller.getSnapshot().storage.canClear, false);
    await controller.storageClearPreview('raw', null);
    assert.equal(controller.getSnapshot().storage.clear.kind, 'idle');
  });
});

describe('compact and retention through the controller', () => {
  it('compact reports the bytes freed and refreshes', async () => {
    const { host, calls } = storageHost({
      compact: async () => ({ ok: true, mode: 'incremental', pagesFreed: 40, bytesBefore: 9000, bytesAfter: 5000, ms: 12 }),
    });
    const controller = await loaded(host);
    await controller.storageCompact();
    const s = controller.getSnapshot().storage;
    assert.equal(s.compact.kind, 'done');
    assert.equal(s.compact.freedBytes, 4000);
    assert.equal(s.compact.mode, 'incremental');
    assert.equal(calls.compact, 1);
  });

  for (const [code, pattern] of [
    ['busy', /in progress/],
    ['disk_space', /disk space/],
    ['store_down', /not available/],
  ]) {
    it(`compact fails with the ${code} message`, async () => {
      const { host } = storageHost({
        compact: async () => {
          throw new api.host.OsStorageError(code, code);
        },
      });
      const controller = await loaded(host);
      await controller.storageCompact();
      const s = controller.getSnapshot().storage;
      assert.equal(s.compact.kind, 'failed');
      assert.equal(s.compact.code, code);
      assert.match(s.compact.message, pattern);
    });
  }

  it('a plain Error with a string code is read the same way as an OsStorageError', async () => {
    const { host } = storageHost({
      compact: async () => {
        throw Object.assign(new Error('full'), { code: 'disk_space' });
      },
    });
    const controller = await loaded(host);
    await controller.storageCompact();
    const s = controller.getSnapshot().storage;
    assert.equal(s.compact.code, 'disk_space');
    assert.match(s.compact.message, /disk space/);
  });

  it('compact without host.storageCompact does nothing', async () => {
    const { host } = storageHost({});
    const controller = await loaded(host);
    await controller.storageCompact();
    assert.equal(controller.getSnapshot().storage.compact.kind, 'idle');
  });

  it('the retention setting loads from the host, and an out-of-range value is refused without a call', async () => {
    const { host, calls } = storageHost({
      settings: async () => ({ retentionDays: 45 }),
      retention: async (days) => ({ retentionDays: days }),
    });
    const controller = await loaded(host);
    controller.loadExtras();
    await flush();
    assert.equal(controller.getSnapshot().storage.retentionDays, 45);
    await controller.setStorageRetention(3);
    assert.equal(calls.retention.length, 0);
    assert.equal(controller.getSnapshot().storage.retention.status, 'error');
    await controller.setStorageRetention(120);
    assert.deepEqual(calls.retention, [120]);
    assert.equal(controller.getSnapshot().storage.retentionDays, 120);
    assert.equal(controller.getSnapshot().storage.retention.status, 'saved');
  });

  it('a retention the host refuses shows the failure', async () => {
    const { host } = storageHost({ retention: async () => { throw new Error('nope'); } });
    const controller = await loaded(host);
    await controller.setStorageRetention(30);
    const r = controller.getSnapshot().storage.retention;
    assert.equal(r.status, 'error');
    assert.match(r.message, /nope/);
  });
});

describe('the Storage overview and the Agents runs', () => {
  it('shows the groups and the controls the host supports', async () => {
    const { host } = storageHost({
      clear: (req) => (req.dryRun ? DRY('p1') : REAL),
      compact: async () => ({ ok: true, mode: 'full', pagesFreed: 1, bytesBefore: 2, bytesAfter: 1, ms: 1 }),
      retention: async (d) => ({ retentionDays: d }),
    });
    const controller = await loaded(host);
    const html = api.render.renderHub(controller, 'storage');
    assert.match(html, /Agent history/);
    assert.match(html, /Search index/);
    assert.match(html, /Clear raw history/);
    assert.match(html, /Clear all agent history/);
    assert.match(html, /Compact store/);
    assert.match(html, /Save retention/);
  });

  it('hides Clear, Compact and retention when the host has none of them', async () => {
    const controller = await loaded(storageHost({}).host);
    const html = api.render.renderHub(controller, 'storage');
    assert.match(html, /Agent history/);
    assert.doesNotMatch(html, /Clear raw history/);
    assert.doesNotMatch(html, /Compact store/);
    assert.doesNotMatch(html, /Save retention/);
    assert.match(html, /Only the agent history can be cleared or compacted here/);
  });

  it('a clear preview renders its counts and the confirm; a failure renders its message as an alert', async () => {
    const { host } = storageHost({
      clear: (req, n) => {
        if (req.dryRun) return DRY('p1');
        throw new api.host.OsStorageError('busy', 'busy');
      },
    });
    const controller = await loaded(host);
    await controller.storageClearPreview('raw', null);
    const preview = api.render.renderHub(controller, 'storage');
    assert.match(preview, /Would delete/);
    assert.match(preview, /Delete 12 rows/);
    assert.match(preview, /Agent runs/);
    await controller.storageClearConfirm();
    const failed = api.render.renderHub(controller, 'storage');
    assert.match(failed, /role="alert"/);
    assert.match(failed, /busy/);
  });

  it('with no storage report the hub says so and offers nothing', async () => {
    const base = {
      loadState: async () => ({ ...seeded(), storage: null }),
    };
    const controller = new api.controller.OsController({
      host: { cancel: async () => {}, watch: () => () => {}, open: () => true, ...base, storageClear: async () => DRY('p') },
      ...immediate,
    });
    controller.start();
    await flush();
    const html = api.render.renderHub(controller, 'storage');
    assert.match(html, /storage report is not available/);
    assert.doesNotMatch(html, /Clear raw history/);
  });

  it('the Agents hub lists the recent runs with a status chip, duration and tokens', async () => {
    const controller = await loaded(storageHost({}).host);
    const html = api.render.renderHub(controller, 'agents');
    assert.match(html, /Recent runs/);
    assert.match(html, /Chat run/);
    assert.match(html, /run-chip-ok[^>]*>Done</);
    assert.match(html, /run-chip-error[^>]*>Error</);
    assert.match(html, /5 s/);
    assert.match(html, /5,400 tokens/);
    assert.match(html, /CLI_FAILED/);
    // No prompt or message text: the rows carry codes only.
    assert.doesNotMatch(html, /prompt/i);
  });
});
