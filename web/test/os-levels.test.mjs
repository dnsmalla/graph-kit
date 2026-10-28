// The OS as a graph (K7): the core's OS view through the page's wrappers, the memoised OS view,
// the controller's navigation (drill, back, camera memory, side-panel nodes), the OS-level
// rendering and the details card. `npm test`. Timers are fake and the host is a fake.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { uniqueCacheDir } from './support/cacheDir.mjs';
import react from '@vitejs/plugin-react';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB_NAMES = ['activity', 'agents', 'kits', 'knowledge', 'memory', 'models', 'routines', 'skills'];

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
  api = {
    wasm: await server.ssrLoadModule('/src/wasm/index.ts'),
    systemGraph: await server.ssrLoadModule('/src/systemGraph.ts'),
    controller: await server.ssrLoadModule('/src/controller.ts'),
    host: await server.ssrLoadModule('/src/host.ts'),
    format: await server.ssrLoadModule('/src/format.ts'),
    search: await server.ssrLoadModule('/src/orbit/search.ts'),
    render: await server.ssrLoadModule('/test/support/render.tsx'),
    fixture: await server.ssrLoadModule('/demo/fixture.ts'),
    viz: await server.ssrLoadModule('/src/viz.ts'),
  };
});

after(async () => {
  await server?.close();
});

const seeded = () => structuredClone(api.fixture.fixtureSnapshot);
const project = () => api.fixture.buildDemoProjectGraph();

/** The OS view of the fixture, built the way the page builds it. */
function fixtureView() {
  const core = api.systemGraph.computeCore(project(), { maxCoreNodes: 4000 });
  const code = api.wasm.codeSummary(core.graph, 6);
  return {
    core,
    view: api.wasm.buildOsView({ snapshot: seeded(), skills: api.fixture.demoSkills, routines: api.fixture.demoRoutines, code }),
  };
}

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
  };
}

function fakeHost(overrides = {}) {
  return {
    loadState: () => Promise.resolve(overrides.snapshot ?? seeded()),
    cancel: () => Promise.resolve(),
    watch: () => () => {},
    open: () => true,
    ...overrides.host,
  };
}

function makeController({ host = fakeHost(), projectName = 'Demo project' } = {}) {
  const timers = fakeTimers();
  const controller = new api.controller.OsController(
    {
      host,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      applyTheme: () => {},
    },
    { projectName },
  );
  return { controller, timers };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('wasm wrappers: buildOsView, vizLayout, codeSummary', () => {
  it('buildOsView with no input gives the OS graph as one centre per hub, and a graph per hub but code', () => {
    const out = api.wasm.buildOsView({ snapshot: null, skills: [], routines: [], code: null });
    assert.equal(out.os.level, 'os');
    assert.equal(out.os.nodes.length, 9, 'nine hub centres');
    assert.ok(out.os.nodes.every((n) => n.kind === 'hub' && n.drill), 'every centre opens its hub');
    assert.deepEqual(Object.keys(out.hubs).sort(), HUB_NAMES, 'every hub but code has a graph');
    for (const name of HUB_NAMES) assert.equal(out.hubs[name].nodes.length, 1, `${name} with no data is its centre only`);
  });

  it('buildOsView of the fixture populates every hub with its own members and ids', () => {
    const { view } = fixtureView();
    assert.ok(view.os.nodes.some((n) => n.id === 'hub:code' && n.drill === 'code'));
    for (const name of HUB_NAMES) {
      assert.ok(view.hubs[name].nodes.length > 1, `${name} has members`);
      assert.equal(view.hubs[name].nodes[0].id, `hub:${name}`);
    }
    assert.ok(view.hubs.kits.nodes.some((n) => n.id === 'kit:agent-kit' && n.kind === 'kit'));
    assert.ok(view.hubs.routines.nodes.some((n) => n.id === 'routine:routine-regression' && n.kind === 'routine'));
    assert.ok(view.hubs.skills.nodes.some((n) => n.id === 'skill:skill-brainstorming' && n.kind === 'skill'));
    assert.ok(view.hubs.models.nodes.some((n) => n.kind === 'model'));
    assert.ok(view.os.edges.some((e) => e.label === 'indexed code graphs'), 'the knowledge to code edge is labelled');
  });

  it('vizLayout places every node of a VizGraph with finite coordinates', () => {
    const { view } = fixtureView();
    const layout = api.wasm.vizLayout(view.os, { seed: 1 });
    const unique = new Set(view.os.nodes.map((n) => n.id));
    assert.equal(layout.core.size, unique.size);
    for (const [, p] of layout.core) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
    assert.ok(layout.bounds.radius > 0);
  });

  it('codeSummary totals the project graph and keeps the top communities', () => {
    const { core } = fixtureView();
    const summary = api.wasm.codeSummary(core.graph, 1);
    assert.equal(summary.totalNodes, core.graph.core.length);
    assert.ok(summary.communities.length <= 1);
    assert.ok(summary.communityCount >= 1);
  });

  it('a core error is thrown with the wrapper name, not returned', () => {
    assert.throws(() => api.wasm.vizLayout(null, {}), /vizLayout: viz: must not be null/);
    assert.throws(() => api.wasm.codeSummary(null, 3), /codeSummary/);
  });
});

describe('the memoised OS view and layout', () => {
  it('returns the same view while the inputs that matter are unchanged, even as new objects', () => {
    const core = api.systemGraph.computeCore(project(), { maxCoreNodes: 4000 });
    const skills = api.fixture.demoSkills;
    const routines = api.fixture.demoRoutines;
    const a = api.systemGraph.computeOsView(seeded(), skills, routines, core);
    const b = api.systemGraph.computeOsView(seeded(), skills, routines, core);
    assert.equal(a, b, 'a fresh copy of the same snapshot content is the same view');
  });

  it('ignores the activity: a change refresh that only adds activity keeps the view', () => {
    const core = api.systemGraph.computeCore(project(), { maxCoreNodes: 4000 });
    const skills = api.fixture.demoSkills;
    const routines = api.fixture.demoRoutines;
    const base = seeded();
    const a = api.systemGraph.computeOsView(base, skills, routines, core);
    const next = seeded();
    next.activity.items = [{ ...next.activity.items[0], id: 999, title: 'New' }, ...next.activity.items];
    assert.equal(api.systemGraph.computeOsView(next, skills, routines, core), a);
  });

  it('recomputes when a part changes (a running item) or when skills, routines or the core change', () => {
    const core = api.systemGraph.computeCore(project(), { maxCoreNodes: 4000 });
    const skills = api.fixture.demoSkills;
    const routines = api.fixture.demoRoutines;
    const a = api.systemGraph.computeOsView(seeded(), skills, routines, core);
    const running = seeded();
    running.running.chatTurns = [];
    running.running.meetingAgentRuns = [];
    running.running.liveSessions = [];
    const b = api.systemGraph.computeOsView(running, skills, routines, core);
    assert.notEqual(a, b);
    assert.equal(b.hubs.agents.nodes.length, 1, 'nothing running now');
    assert.notEqual(api.systemGraph.computeOsView(seeded(), skills.slice(), routines, core), a, 'new skills array');
    assert.notEqual(api.systemGraph.computeOsView(seeded(), skills, routines.slice(), core), a, 'new routines array');
    const emptyCore = api.systemGraph.EMPTY_CORE_VIEW;
    assert.notEqual(api.systemGraph.computeOsView(seeded(), skills, routines, emptyCore), a, 'a different core');
  });

  it('computeVizLayout is keyed by content: a refresh that rebuilds the same graph keeps the positions', () => {
    const { view } = fixtureView();
    const first = api.systemGraph.computeVizLayout(view.os);
    assert.equal(api.systemGraph.computeVizLayout(view.os), first);
    const copy = structuredClone(view.os);
    assert.equal(api.systemGraph.computeVizLayout(copy), first, 'the same content is the same layout object');
    const grown = structuredClone(view.os);
    grown.nodes.push({ ...grown.nodes[grown.nodes.length - 1], id: 'extra:node', label: 'extra', kind: 'activity', group: 0 });
    const next = api.systemGraph.computeVizLayout(grown);
    assert.notEqual(next, first, 'a changed node set is laid out again');
    assert.ok(next.core.has('extra:node'), 'and the new node is placed');
  });

  it('drawOs reports loading without calling the core, and vizForLevel picks a level or nothing', () => {
    const { core, view } = fixtureView();
    const loading = api.systemGraph.drawOs(seeded(), null, null, core, { loading: true });
    assert.equal(loading.loading, true);
    assert.equal(loading.view, null);
    const drawn = api.systemGraph.drawOs(seeded(), api.fixture.demoSkills, api.fixture.demoRoutines, core);
    assert.equal(drawn.failed, false);
    assert.equal(drawn.loading, false);
    assert.equal(api.systemGraph.vizForLevel(drawn.view, 'os').graph.level, 'os');
    assert.equal(api.systemGraph.vizForLevel(drawn.view, 'models').graph.level, 'models');
    assert.ok(api.systemGraph.vizForLevel(drawn.view, 'models').layout.core.size > 0);
    assert.equal(api.systemGraph.vizForLevel(view, 'code'), null, 'code is the project graph, not a VizGraph');
    assert.equal(api.systemGraph.vizForLevel(view, 'nope'), null);
  });
});

describe('controller: navigation between the OS, its parts and the code brain', () => {
  it('starts on the OS', () => {
    const { controller } = makeController();
    assert.deepEqual(controller.getSnapshot().view, { level: 'os' });
    assert.equal(controller.getSnapshot().focusSeq, 0);
  });

  it('drills into a hub, clears the selection, and ignores an unknown or repeated hub', () => {
    const { controller } = makeController();
    controller.select({ type: 'viz', id: 'hub:models', label: 'Models', detail: 'hub' });
    controller.drill('models');
    assert.deepEqual(controller.getSnapshot().view, { level: 'hub', hub: 'models' });
    assert.equal(controller.getSnapshot().selected, null);
    const before = controller.getSnapshot();
    controller.drill('models');
    controller.drill('not-a-hub');
    assert.equal(controller.getSnapshot(), before, 'no state change for a repeat or an unknown hub');
  });

  it('drills into the code brain through the code hub', () => {
    const { controller } = makeController();
    controller.drill('code');
    assert.deepEqual(controller.getSnapshot().view, { level: 'hub', hub: 'code' });
  });

  it('back returns to the OS with the hub node selected; back on the OS does nothing', () => {
    const { controller } = makeController();
    controller.drill('routines');
    controller.back();
    assert.deepEqual(controller.getSnapshot().view, { level: 'os' });
    assert.deepEqual(controller.getSnapshot().selected, { type: 'viz', id: 'hub:routines', label: 'Routines', detail: 'hub' });
    const before = controller.getSnapshot();
    controller.back();
    assert.equal(controller.getSnapshot(), before);
  });

  it('remembers the camera of the level it leaves and restores it when it returns', () => {
    const { controller } = makeController();
    const osPose = { position: [0, 10, 300], target: [0, 0, 0] };
    const modelsPose = { position: [5, 5, 80], target: [1, 0, 0] };
    controller.setCameraSource(() => osPose);
    controller.drill('models');
    assert.deepEqual(controller.cameraFor({ level: 'os' }), osPose, 'the OS camera is kept when leaving it');
    controller.setCameraSource(() => modelsPose);
    controller.back();
    assert.deepEqual(controller.cameraFor({ level: 'hub', hub: 'models' }), modelsPose, 'the models camera is kept');
    assert.equal(controller.cameraFor({ level: 'hub', hub: 'skills' }), null, 'a level never visited has no pose');
  });

  it('an explicit camera wins over the brain; a bad pose is never remembered', () => {
    const { controller } = makeController();
    controller.setCameraSource(() => ({ position: [1, 1, 1], target: [0, 0, 0] }));
    const explicit = { position: [9, 9, 9], target: [0, 0, 0] };
    controller.drill('kits', explicit);
    assert.deepEqual(controller.cameraFor({ level: 'os' }), explicit);
    controller.back({ position: [NaN, 0, 0], target: [0, 0, 0] });
    assert.deepEqual(controller.cameraFor({ level: 'hub', hub: 'kits' }), null, 'a non-finite pose is ignored');
    controller.setCameraSource(null);
  });

  it('openNode drills into the node hub, selects the node and asks the brain to fly to it', () => {
    const { controller } = makeController();
    const focusBefore = controller.getSnapshot().focusSeq;
    controller.openNode('routines', { id: 'routine:routine-regression', label: 'Regression sweep', detail: 'routine' });
    const state = controller.getSnapshot();
    assert.deepEqual(state.view, { level: 'hub', hub: 'routines' });
    assert.deepEqual(state.selected, { type: 'viz', id: 'routine:routine-regression', label: 'Regression sweep', detail: 'routine' });
    assert.equal(state.focusSeq, focusBefore + 1);
    controller.openNode('nope', { id: 'x', label: 'x', detail: 'x' });
    assert.equal(controller.getSnapshot().focusSeq, focusBefore + 1, 'an unknown hub opens nothing');
  });

  it('selects an OS-graph node and rejects an unknown selection type', () => {
    const { controller } = makeController();
    controller.select({ type: 'viz', id: 'model:anthropic/claude-sonnet-5', label: 'claude-sonnet-5', detail: 'model' });
    assert.equal(controller.getSnapshot().selected.type, 'viz');
    controller.select({ type: 'edge', id: 'a>b', label: 'x', detail: 'y' });
    assert.equal(controller.getSnapshot().selected.id, 'model:anthropic/claude-sonnet-5', 'an edge is not a selection');
  });

  it('a new project starts again at the OS and forgets the remembered cameras', () => {
    const { controller } = makeController({ projectName: 'A' });
    controller.setCameraSource(() => ({ position: [1, 2, 3], target: [0, 0, 0] }));
    controller.drill('models');
    controller.setCameraSource(null);
    assert.ok(controller.cameraFor({ level: 'os' }));
    controller.configure({ projectName: 'B' });
    assert.deepEqual(controller.getSnapshot().view, { level: 'os' });
    assert.equal(controller.cameraFor({ level: 'os' }), null);
  });

  it('a disposed controller ignores navigation', () => {
    const { controller } = makeController();
    controller.dispose();
    const before = controller.getSnapshot();
    controller.drill('models');
    controller.back();
    assert.equal(controller.getSnapshot(), before);
  });
});

describe('the details card (Selection)', () => {
  // Built in a hook: the file's server is only up once the top-level before() has run.
  let view;
  before(() => {
    ({ view } = fixtureView());
  });
  const node = (id) => ({ type: 'viz', id, label: id, detail: 'x' });
  const find = (hub, id) => view.hubs[hub].nodes.find((n) => n.id === id);
  const labelled = (hub, id) => ({ type: 'viz', id, label: find(hub, id).label, detail: find(hub, id).kind });

  it('a routine offers Open Auto Tasks and shows its schedule', () => {
    const html = api.render.renderSelection(labelled('routines', 'routine:routine-regression'), { viz: view.hubs.routines });
    assert.match(html, />Open Auto Tasks</);
    assert.match(html, /Every weekday at 09:00/);
    assert.match(html, /Schedule/);
    assert.doesNotMatch(html, /Stop/);
  });

  it('a kit or a feature offers Open Settings and a status chip', () => {
    const kit = api.render.renderSelection(labelled('kits', 'kit:agent-kit'), { viz: view.hubs.kits });
    assert.match(kit, />Open Settings</);
    assert.match(kit, /os-chip-ok/);
    assert.match(kit, />OK</);
    const feature = api.render.renderSelection(labelled('kits', 'feature:auto_tasks'), { viz: view.hubs.kits });
    assert.match(feature, />Open Settings</);
  });

  it('a source kind offers Open Library', () => {
    const html = api.render.renderSelection(labelled('knowledge', 'source:code'), { viz: view.hubs.knowledge });
    assert.match(html, />Open Library</);
  });

  it('a hub offers Explore with its part name', () => {
    const html = api.render.renderSelection(labelled('models', 'hub:models'), { viz: view.hubs.models });
    // React's server output puts a comment between the two text runs: "Explore <!-- -->Models".
    assert.match(html, />Explore (<!-- -->)?Models</);
    assert.match(html, /Part of the OS/);
  });

  it('a running chat turn offers Stop with its declared cancel, and no screen to open', () => {
    const html = api.render.renderSelection(labelled('agents', 'chatTurn:chat-1'), {
      viz: view.hubs.agents,
      running: seeded().running,
    });
    assert.match(html, /aria-label="Stop Chat chat-1"/);
    assert.doesNotMatch(html, /Open /);
    const stopping = api.render.renderSelection(labelled('agents', 'chatTurn:chat-1'), {
      viz: view.hubs.agents,
      running: seeded().running,
      stopping: 'chat-chat-1',
    });
    assert.match(stopping, />Stopping…</);
  });

  it('a live session has no stop: it says it ends with its capture client', () => {
    const html = api.render.renderSelection(labelled('agents', 'liveSession:live-1'), {
      viz: view.hubs.agents,
      running: seeded().running,
    });
    assert.match(html, /Ends when its capture client stops/);
    assert.doesNotMatch(html, /aria-label="Stop/);
  });

  it('formats the meta: numbers with separators, arrays as counts, nested objects as lines', () => {
    const models = { ...view.hubs.models };
    const modelNode = models.nodes.find((n) => n.kind === 'model');
    const html = api.render.renderSelection(
      { type: 'viz', id: modelNode.id, label: modelNode.label, detail: 'model' },
      { viz: { ...models, nodes: [{ ...modelNode, meta: { billable: 2800, requires: ['a', 'b'], usage: { calls: 3, cacheRead: 8000 } } }] } },
    );
    assert.match(html, />2,800</);
    assert.match(html, />2 items</);
    assert.match(html, /Usage/);
    assert.match(html, /Cache read<!-- -->:<\/span> <!-- -->8,000/);
  });

  it('a node the drawn graph no longer has says so, and still shows the label', () => {
    const html = api.render.renderSelection({ type: 'viz', id: 'gone', label: 'Gone', detail: 'routine' }, { viz: view.hubs.routines });
    assert.match(html, /Gone/);
    assert.match(html, /Not in this view any more\./);
  });

  it('a project node and an activity item keep their own cards', () => {
    const core = api.render.renderSelection({ type: 'core', id: 'c1', label: 'fn1', detail: 'code' });
    assert.match(core, /Category/);
    const ring = api.render.renderSelection({ type: 'ring', id: 'activity:9', label: 'Ingested', detail: 'knowledge_updated' });
    assert.match(ring, /Recent activity/);
  });
});

describe('format helpers for the details card', () => {
  const NOW = Date.parse('2026-10-27T12:00:00Z');

  it('relative times read as words, and a far date reads as the date', () => {
    assert.equal(api.format.fmtRelative('2026-10-27T11:55:00Z', NOW), '5 minutes ago');
    assert.equal(api.format.fmtRelative('2026-10-27T14:00:00Z', NOW), 'in 2 hours');
    assert.equal(api.format.fmtRelative('2026-10-27T11:59:50Z', NOW), 'just now');
    assert.equal(api.format.fmtRelative(null, NOW), '—');
  });

  it('keys become sentences and the meta rows follow the value rules', () => {
    assert.equal(api.format.humanKey('lastRunAt'), 'Last run at');
    assert.equal(api.format.humanKey('snake_case_key'), 'Snake case key');
    const rows = api.format.metaRows({ enabled: true, billable: 1234, empty: null, list: ['x'], nested: { a: 1 } }, NOW);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.equal(byKey.Enabled.value, 'Yes');
    assert.equal(byKey.Billable.value, '1,234');
    assert.equal(byKey.Empty.value, '—');
    assert.equal(byKey.List.value, '1 item');
    assert.equal(byKey.Nested.lines[0].key, 'A');
  });
});

describe('search over the OS graph', () => {
  it('finds nodes by label, prefix first, and matches nothing for an empty query', () => {
    const { view } = fixtureView();
    assert.deepEqual(api.search.searchVizNodes(view.os, ''), []);
    const hits = api.search.searchVizNodes(view.os, 'mod');
    assert.ok(hits.length > 0);
    assert.ok(hits.every((h) => h.label.toLowerCase().includes('mod') || h.id.toLowerCase().includes('mod')));
    assert.equal(api.search.searchVizNodes(null, 'mod').length, 0);
  });

  it('keeps the project-graph search as it was', () => {
    const core = api.systemGraph.computeCore(project(), { maxCoreNodes: 4000 });
    assert.ok(api.search.searchCoreNodes(core.graph, 'fn1').length > 0);
  });
});

describe('navigation after a refresh and the drill guard', () => {
  const os = () => api.wasm.buildOsView({ snapshot: seeded(), skills: api.fixture.demoSkills, routines: api.fixture.demoRoutines, code: null });

  it('a part the refreshed OS no longer has sends the brain back to the OS', () => {
    const { controller } = makeController();
    controller.drill('models');
    const gone = { ...os(), hubs: { ...os().hubs } };
    delete gone.hubs.models;
    controller.reconcile(gone);
    assert.deepEqual(controller.getSnapshot().view, { level: 'os' });
    assert.deepEqual(controller.getSnapshot().selected, { type: 'viz', id: 'hub:models', label: 'Models', detail: 'hub' });
  });

  it('a selected OS node that is no longer drawn is cleared; a present one is kept', () => {
    const { controller } = makeController();
    const view = os();
    controller.select({ type: 'viz', id: 'hub:models', label: 'Models', detail: 'hub' });
    controller.reconcile(view);
    assert.equal(controller.getSnapshot().selected?.id, 'hub:models', 'still drawn: kept');
    controller.drill('models');
    controller.select({ type: 'viz', id: 'model:gone', label: 'gone', detail: 'model' });
    controller.reconcile(view);
    assert.equal(controller.getSnapshot().selected, null, 'not in the models graph any more: cleared');
  });

  it('the code brain is left alone by the reconcile, and a core selection is not a viz one', () => {
    const { controller } = makeController();
    controller.drill('code');
    controller.select({ type: 'core', id: 'x', label: 'x', detail: 'code' });
    controller.reconcile(os());
    assert.deepEqual(controller.getSnapshot().view, { level: 'hub', hub: 'code' });
    assert.equal(controller.getSnapshot().selected?.type, 'core');
  });

  it('the drill guard swallows only the trailing pick of the same hub, and only for a moment', () => {
    const guard = { id: 'hub:models', until: 1000 };
    assert.equal(api.viz.swallowsPick(guard, 'hub:models', 900), true);
    assert.equal(api.viz.swallowsPick(guard, 'hub:models', 1000), false, 'after the window');
    assert.equal(api.viz.swallowsPick(guard, 'model:a/one', 900), false, 'another node is not swallowed');
    assert.equal(api.viz.swallowsPick(null, 'hub:models', 900), false);
    assert.equal(api.viz.DRILL_GUARD_MS, 350);
  });
});
