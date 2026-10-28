// The page is the graph: the top bar, the stage, the details drawer and the hub overviews.
// Rendered with the server renderer over the fixture; the controller is driven directly.
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
    render: await load('/test/support/render.tsx'),
    fixture: await load('/demo/fixture.ts'),
    hubOverview: await load('/src/components/HubOverview.tsx'),
  };
});

after(async () => {
  await server?.close();
});

const seeded = () => structuredClone(api.fixture.fixtureSnapshot);
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function fakeHost(overrides = {}) {
  const calls = { cancel: [], open: [] };
  const host = {
    loadState: () => Promise.resolve(overrides.snapshot ?? seeded()),
    cancel: (request) => {
      calls.cancel.push(request);
      return Promise.resolve();
    },
    watch: () => () => {},
    open: (target) => {
      calls.open.push(target);
      return true;
    },
    loadProjectGraph: () => Promise.resolve(api.fixture.buildDemoProjectGraph()),
    loadSkills: () => Promise.resolve(api.fixture.demoSkills),
    loadRoutines: () => Promise.resolve(api.fixture.demoRoutines),
  };
  return { host, calls };
}

async function started(snapshot = seeded()) {
  const fake = fakeHost({ snapshot });
  const controller = new api.controller.OsController(
    {
      host: fake.host,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t),
      applyTheme: () => {},
    },
    { projectName: 'Demo project' },
  );
  controller.start();
  await flush();
  return { controller, calls: fake.calls, html: () => api.render.renderApp(controller) };
}

describe('the top bar', () => {
  it('shows the title, project, the Day|Week control, the status and the health chip', async () => {
    const { controller, html } = await started();
    const out = html();
    assert.ok(out.includes('os-top'));
    assert.ok(out.includes('Demo project'));
    assert.ok(out.includes('>Day<') && out.includes('>Week<'));
    assert.ok(/Healthy|Degraded/.test(out), 'the health chip reads Healthy or Degraded');
    assert.ok(out.includes('Updated '), 'the update time is shown');
    controller.dispose();
  });

  it('shows the running chip only when something runs', async () => {
    const busy = await started();
    assert.match(busy.html(), /\d+<!-- --> running/);
    busy.controller.dispose();

    const idle = seeded();
    idle.running = { chatTurns: [], meetingAgentRuns: [], liveSessions: [] };
    const quiet = await started(idle);
    assert.doesNotMatch(quiet.html(), /running<\/button>/);
    quiet.controller.dispose();
  });

  it('the health and running chips move the page to Kits and Agents', async () => {
    const { controller } = await started();
    controller.drill('kits');
    assert.equal(controller.getSnapshot().view.hub, 'kits');
    controller.back();
    controller.drill('agents');
    assert.equal(controller.getSnapshot().view.hub, 'agents');
    controller.dispose();
  });
});

describe('the stage at the OS level', () => {
  it('has no columns, no cards and no stray headings; the breadcrumb names the level', async () => {
    const { controller, html } = await started();
    const out = html();
    assert.ok(!out.includes('os-col'), 'no columns');
    assert.ok(!out.includes('card-title'), 'no cards');
    assert.ok(!out.includes('THE WHOLE OS') && !out.includes('The whole OS'), 'no stray headings');
    assert.match(out, /<span class="os-crumb os-crumb-current"[^>]*>OS<\/span>/);
    assert.ok(!out.includes('os-drawer"'), 'nothing selected: no drawer');
    assert.match(out, /Activity · <!-- -->\d+/, 'the activity chip is in the bottom-left overlay');
    controller.dispose();
  });

  it('the activity chip opens the timeline in the drawer', async () => {
    const { controller, html } = await started();
    controller.toggleActivity();
    const out = html();
    assert.ok(out.includes('os-drawer'), 'the drawer is open');
    assert.ok(out.includes('Recent activity') || out.includes('os-recent-list'), 'the timeline is listed');
    controller.dispose();
  });
});

describe('the drawer and the hub overviews', () => {
  it('a drilled hub shows its overview in the drawer by default (Models: token flow)', async () => {
    const { controller, html } = await started();
    controller.drill('models');
    const out = html();
    assert.ok(out.includes('os-drawer'));
    assert.ok(out.includes('Token flow'));
    assert.ok(out.includes('Window:'));
    assert.ok(out.includes('Billable'));
    assert.ok(out.includes('By model'));
    controller.dispose();
  });

  it('a single click on a hub node shows its overview at the OS level; Explore drills in', async () => {
    const { controller, html } = await started();
    controller.select({ type: 'viz', id: 'hub:kits', label: 'Kits', detail: 'hub' });
    const out = html();
    assert.ok(out.includes('os-drawer'));
    assert.ok(out.includes('System map'), 'the kits overview is in the drawer');
    assert.ok(out.includes('Explore'), 'the hub offers Explore at the OS level');
    controller.drill('kits');
    assert.equal(controller.getSnapshot().view.hub, 'kits');
    controller.dispose();
  });

  it('Kits overview lists the health checks and the kits', async () => {
    const { controller, html } = await started();
    controller.drill('kits');
    const out = html();
    assert.ok(out.includes('Health checks'));
    assert.ok(out.includes('Database') && out.includes('Claude CLI') && out.includes('Skills'));
    for (const kit of seeded().system.kits) assert.ok(out.includes(kit.id), `kit ${kit.id} is listed`);
    controller.dispose();
  });

  it('Knowledge has the Open Library button; Memory lists the project memory repos', async () => {
    const { controller, html } = await started();
    controller.drill('knowledge');
    assert.ok(html().includes('Open Library'));
    controller.drill('memory');
    const memory = html();
    assert.ok(memory.includes('Project memory'));
    for (const repo of seeded().knowledge.projectMemory) assert.ok(memory.includes(repo.repoRoot.split('/').pop()));
    controller.dispose();
  });

  it('Routines overview is a table with the schedule, next and last run', async () => {
    const { controller, html } = await started();
    controller.drill('routines');
    const out = html();
    assert.ok(out.includes('<table'));
    assert.ok(out.includes('Next run') && out.includes('Last run'));
    assert.ok(out.includes('Open Loop') && out.includes('Open Auto Tasks'));
    controller.dispose();
  });

  it('Skills overview lists skills with a search field, and the search matches name, source and description', async () => {
    const { controller, html } = await started();
    controller.drill('skills');
    assert.ok(html().includes('aria-label="Search skills"'));
    const skill = api.fixture.demoSkills[0];
    assert.ok(api.hubOverview.skillMatches(skill, skill.name.slice(0, 3)));
    assert.ok(!api.hubOverview.skillMatches(skill, 'zzzz-no-such-skill'));
    controller.dispose();
  });

  it('Code overview counts the nodes and lists the largest clusters', async () => {
    const { controller, html } = await started();
    controller.drill('code');
    await flush();
    const out = html();
    assert.ok(out.includes('Largest clusters') || out.includes('No code graph yet'));
    assert.ok(out.includes('Nodes') && out.includes('Communities') && out.includes('Repos'));
    controller.dispose();
  });

  it('a drawer hidden on one level stays hidden there and returns when a node is selected', async () => {
    const { controller, html } = await started();
    controller.drill('models');
    controller.setDrawerOpen(false);
    const hidden = html();
    assert.ok(!hidden.includes('<aside class="os-drawer"'), 'the drawer is hidden');
    assert.ok(hidden.includes('os-drawer-tab'), 'a tab brings it back');
    controller.select({ type: 'viz', id: 'hub:models', label: 'Models', detail: 'hub' });
    assert.ok(html().includes('<aside class="os-drawer"'), 'selecting reopens it');
    controller.dispose();
  });

  it('the drawer state is per level: hiding Models does not hide Kits', async () => {
    const { controller } = await started();
    controller.drill('models');
    controller.setDrawerOpen(false);
    controller.back();
    controller.drill('kits');
    assert.equal(controller.getSnapshot().drawerClosed['hub:kits'], undefined);
    controller.dispose();
  });
});

describe('the agents overview and its Stop', () => {
  it('Stop sends the running item\'s declared cancel request through the controller', async () => {
    const { controller, calls, html } = await started();
    controller.drill('agents');
    assert.ok(html().includes('aria-label="Stop chat turn"'));
    const turn = seeded().running.chatTurns[0];
    await controller.stopItem(turn.cancel, `chat-${turn.chatSessionId}`);
    assert.equal(calls.cancel.length, 1);
    assert.deepEqual(calls.cancel[0].path, turn.cancel.path);
    controller.dispose();
  });

  it('with nothing running the agents overview says so', async () => {
    const idle = seeded();
    idle.running = { chatTurns: [], meetingAgentRuns: [], liveSessions: [] };
    const { controller, html } = await started(idle);
    controller.drill('agents');
    assert.ok(html().includes('Nothing is running'));
    controller.dispose();
  });
});

describe('drawer keyboard behaviour (controller level)', () => {
  it('setDrawerOpen(false) on a level with nothing selected hides the drawer; select re-opens it', async () => {
    const { controller } = await started();
    controller.toggleActivity();
    controller.setDrawerOpen(false);
    assert.equal(controller.getSnapshot().drawerClosed.os, true);
    controller.select({ type: 'ring', id: 'activity:1', label: 'x', detail: 'y' });
    assert.equal(controller.getSnapshot().drawerClosed.os, undefined);
    controller.dispose();
  });
});
