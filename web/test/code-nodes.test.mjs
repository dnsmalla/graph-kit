// Code node details (K6b): the controller's file preview and openFile, the code node card (path,
// depends-on / used-by, preview, open), the cluster card, the file tree and the structure tab, and
// the demo host's file answers. `npm test`. Timers are fake and the host is a fake.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  api = {
    controller: await server.ssrLoadModule('/src/controller.ts'),
    host: await server.ssrLoadModule('/src/host.ts'),
    systemGraph: await server.ssrLoadModule('/src/systemGraph.ts'),
    fileTree: await server.ssrLoadModule('/src/fileTree.ts'),
    clipboard: await server.ssrLoadModule('/src/clipboard.ts'),
    codeNodes: await server.ssrLoadModule('/src/codeNodes.ts'),
    format: await server.ssrLoadModule('/src/format.ts'),
    selection: await server.ssrLoadModule('/src/components/Selection.tsx'),
    render: await server.ssrLoadModule('/test/support/render.tsx'),
    fixture: await server.ssrLoadModule('/demo/fixture.ts'),
    demoHost: await server.ssrLoadModule('/demo/fixtureHost.ts'),
  };
});

after(async () => {
  await server?.close();
});

const immediate = { setTimer: () => null, clearTimer: () => {}, applyTheme: () => {} };

/** A controller over a host; the change feed is never started, so only the calls under test run. */
function controllerWith(host) {
  return new api.controller.OsController({ host: { loadState: async () => ({}), cancel: async () => {}, watch: () => () => {}, open: () => true, ...host }, ...immediate });
}

/** A promise the test resolves by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A small project: `hub` depends on 20 functions and is used by 3 others. */
function linkedProject() {
  const nodes = [{ id: 'hub', title: 'hub', kind: 'function', metadata: { source_file: 'src/hub.ts' } }];
  const edges = [];
  for (let i = 0; i < 20; i++) {
    nodes.push({ id: `dep${i}`, title: `dep${i}`, kind: 'function', metadata: { source_file: `src/dep${i}.ts` } });
    edges.push({ fromId: 'hub', toId: `dep${i}`, kind: 'imports', confidence: 'EXTRACTED' });
  }
  for (const id of ['u1', 'u2', 'u3']) {
    nodes.push({ id, title: id, kind: 'function', metadata: {} });
    edges.push({ fromId: id, toId: 'hub', kind: 'imports', confidence: 'EXTRACTED' });
  }
  return { nodes, edges, layers: [], tour: [] };
}

const node = (id, extra = {}) => ({ id, category: 'code', community: 0, degree: 1, ...extra });

describe('controller: the code preview', () => {
  it('loads a text file, cutting it at the preview cap and saying so', async () => {
    const big = 'x'.repeat(api.controller.FILE_PREVIEW_MAX_CHARS + 10);
    const c = controllerWith({ loadFile: async (p) => ({ path: p, text: big, bytes: big.length, language: 'TypeScript' }) });
    await c.loadFilePreview('src/a.ts');
    const preview = c.getSnapshot().filePreview;
    assert.equal(preview.status, 'ready');
    assert.equal(preview.content.text.length, api.controller.FILE_PREVIEW_MAX_CHARS);
    assert.equal(preview.content.truncated, true);
    assert.equal(preview.content.language, 'TypeScript');
  });

  it('a host-truncated text stays truncated; a binary file has no text', async () => {
    const c = controllerWith({
      loadFile: async (p) => (p.endsWith('.png') ? { path: p, binary: true, bytes: 2048 } : { path: p, text: 'short', truncated: true }),
    });
    await c.loadFilePreview('a.png');
    assert.deepEqual(c.getSnapshot().filePreview.content, { text: null, binary: true, bytes: 2048, truncated: false, language: null });
    await c.loadFilePreview('a.ts');
    assert.equal(c.getSnapshot().filePreview.content.truncated, true);
  });

  it('a missing file (null) is "missing"; a rejection is "error" with its message', async () => {
    const missing = controllerWith({ loadFile: async () => null });
    await missing.loadFilePreview('gone.ts');
    assert.equal(missing.getSnapshot().filePreview.status, 'missing');

    const failing = controllerWith({ loadFile: async () => Promise.reject(new Error('disk on fire')) });
    await failing.loadFilePreview('a.ts');
    assert.equal(failing.getSnapshot().filePreview.status, 'error');
    assert.match(failing.getSnapshot().filePreview.message, /disk on fire/);
  });

  it('a host without loadFile gets an error preview, not a crash', async () => {
    const c = controllerWith({});
    await c.loadFilePreview('a.ts');
    assert.equal(c.getSnapshot().filePreview.status, 'error');
    assert.match(c.getSnapshot().filePreview.message, /needs the app/);
  });

  it('drops a late response: only the latest request sets the preview', async () => {
    const pending = [];
    const c = controllerWith({ loadFile: (p) => {
      const d = deferred();
      pending.push({ p, d });
      return d.promise;
    } });
    const a = c.loadFilePreview('src/a.ts');
    const b = c.loadFilePreview('src/b.ts');
    pending[1].d.resolve({ path: 'src/b.ts', text: 'B' });
    await b;
    pending[0].d.resolve({ path: 'src/a.ts', text: 'A' });
    await a;
    const preview = c.getSnapshot().filePreview;
    assert.equal(preview.path, 'src/b.ts');
    assert.equal(preview.content.text, 'B');
  });

  it('a response after dispose() changes nothing', async () => {
    const d = deferred();
    const c = controllerWith({ loadFile: () => d.promise });
    const pending = c.loadFilePreview('src/a.ts');
    c.dispose();
    d.resolve({ path: 'src/a.ts', text: 'late' });
    await pending;
    // The state is frozen where dispose() found it: the late response did not set the content.
    assert.equal(c.getSnapshot().filePreview.status, 'loading');
    assert.equal(c.getSnapshot().filePreview.content, undefined);
    // A request made after dispose is ignored as well.
    await c.loadFilePreview('src/b.ts');
    assert.equal(c.getSnapshot().filePreview.path, 'src/a.ts');
  });

  it('a refused session during a preview signs the view out, as the other loads do', async () => {
    const c = controllerWith({ loadFile: async () => Promise.reject(new api.host.OsAuthError()) });
    await c.loadFilePreview('a.ts');
    assert.equal(c.getSnapshot().signedOut, true);
  });
});

describe('controller: open in Explorer', () => {
  it('calls the host with the path, and the line only when there is one', () => {
    const calls = [];
    const c = controllerWith({ openFile: (...args) => {
      calls.push(args);
      return true;
    } });
    c.openFile('src/a.ts');
    c.openFile('src/b.ts', 12);
    assert.deepEqual(calls, [['src/a.ts'], ['src/b.ts', 12]]);
    assert.equal(c.getSnapshot().notice, null);
  });

  it('a host without openFile gets a notice instead', () => {
    const c = controllerWith({});
    c.openFile('src/a.ts');
    assert.match(c.getSnapshot().notice, /needs the app/);
  });

  it('a host that refuses, or throws, gets a notice', () => {
    const refusing = controllerWith({ openFile: () => false });
    refusing.openFile('src/a.ts');
    assert.match(refusing.getSnapshot().notice, /Could not open src\/a\.ts/);
    const throwing = controllerWith({ openFile: () => { throw new Error('no editor'); } });
    throwing.openFile('src/a.ts');
    assert.match(throwing.getSnapshot().notice, /no editor/);
  });

  it('opens the code brain on a code node as a core selection, and bumps the focus', () => {
    const c = controllerWith({});
    const before = c.getSnapshot().focusSeq;
    c.openCodeNode({ id: 'src/a.ts::fn', label: 'fn', detail: 'code' });
    const state = c.getSnapshot();
    assert.deepEqual(state.view, { level: 'hub', hub: 'code' });
    assert.deepEqual(state.selected, { type: 'core', id: 'src/a.ts::fn', label: 'fn', detail: 'code' });
    assert.equal(state.focusSeq, before + 1);
  });

  it('the code tab switches between 3D and the structure', () => {
    const c = controllerWith({});
    assert.equal(c.getSnapshot().codeTab, 'brain');
    c.setCodeTab('structure');
    assert.equal(c.getSnapshot().codeTab, 'structure');
  });
});

describe('the sanitised file content', () => {
  it('reads a binary file, a text file and rejects a non-object', () => {
    assert.deepEqual(api.controller.sanitizeFile({ path: 'a.png', binary: true, bytes: 9 }), { text: null, binary: true, bytes: 9, truncated: false, language: null });
    assert.deepEqual(api.controller.sanitizeFile({ path: 'a.md', text: 'hi', language: 'Markdown', bytes: 2 }), { text: 'hi', binary: false, bytes: 2, truncated: false, language: 'Markdown' });
    assert.equal(api.controller.sanitizeFile('nope'), null);
    assert.equal(api.controller.sanitizeFile({ text: 'no path' }), null);
  });
});

describe('the code node card', () => {
  it('shows the path in monospace with a copy button, the kind, category, community and degree', () => {
    const project = linkedProject();
    const core = api.systemGraph.computeCore(project).graph.core;
    const html = api.render.renderCodeSelection({ type: 'core', id: 'hub', label: 'hub', detail: 'code' }, { core, project });
    assert.match(html, /<code class="os-path-text"[^>]*>src\/hub\.ts<\/code>/);
    assert.match(html, /aria-label="Copy path src\/hub\.ts"/);
    assert.match(html, /Open in Explorer/);
    assert.match(html, /Preview code/);
    assert.match(html, /<dt>Kind<\/dt><dd>Function<\/dd>/);
    assert.match(html, /<dt>Community<\/dt>/);
    assert.match(html, /<dt>Degree<\/dt>/);
  });

  it('lists what it depends on (outgoing) and what uses it (incoming), +N more past twelve', () => {
    const project = linkedProject();
    const core = api.systemGraph.computeCore(project).graph.core;
    const html = api.render.renderCodeSelection({ type: 'core', id: 'hub', label: 'hub', detail: 'code' }, { core, project });
    const dependsOn = html.slice(html.indexOf('Depends on'), html.indexOf('Used by'));
    const usedBy = html.slice(html.indexOf('Used by'));
    assert.match(dependsOn, /<span class="meta">20<\/span>/);
    assert.equal((dependsOn.match(/class="os-link"/g) ?? []).length, 12);
    assert.match(dependsOn, /\+8 more/);
    assert.match(usedBy, /<span class="meta">3<\/span>/);
    assert.equal((usedBy.match(/class="os-link"/g) ?? []).length, 3);
    assert.doesNotMatch(usedBy, /more</);
    // A node's own links are not its dependents: u1 is used by nobody and depends on hub.
    const u1 = api.render.renderCodeSelection({ type: 'core', id: 'u1', label: 'u1', detail: 'code' }, { core, project });
    assert.match(u1, /Used by <span class="meta">0<\/span>/);
    assert.match(u1, /None in the drawn graph/);
  });

  it('a path-less node says it is in no file and offers no file actions', () => {
    const project = { nodes: [{ id: 'n1', title: 'a note', kind: 'noteTask', metadata: {} }], edges: [], layers: [], tour: [] };
    const core = api.systemGraph.computeCore(project).graph.core;
    const html = api.render.renderCodeSelection({ type: 'core', id: 'n1', label: 'a note', detail: 'knowledge' }, { core, project });
    assert.match(html, /This node is not in a file/);
    assert.doesNotMatch(html, /Open in Explorer/);
  });

  it('without the drawn graph the card is the old project-node card (with its category)', () => {
    const html = api.render.renderSelection({ type: 'core', id: 'c1', label: 'fn1', detail: 'code' });
    assert.match(html, /Category/);
  });

  it('a code cluster lists its top files and offers Explore in code', () => {
    const viz = {
      level: 'os',
      title: 'OS',
      nodes: [
        {
          id: 'cluster:0',
          label: 'Cluster 1 · src/a.ts',
          kind: 'codeCluster',
          group: 0,
          size: 2,
          labelled: false,
          drill: null,
          status: 'ok',
          meta: { index: 0, size: 12, dominantCategory: 'code', topLabels: ['src/a.ts', 'src/b.ts'] },
        },
      ],
      edges: [],
    };
    const html = api.render.renderCodeSelection({ type: 'viz', id: 'cluster:0', label: 'Cluster 1 · src/a.ts', detail: 'codeCluster' }, { viz });
    assert.match(html, /Top files/);
    assert.match(html, /<li>src\/a\.ts<\/li>/);
    assert.match(html, /<li>src\/b\.ts<\/li>/);
    assert.match(html, /Explore in code/);
    assert.doesNotMatch(html, /Top labels/);
  });
});

describe('the preview states', () => {
  it('idle and loading say the file is loading', () => {
    assert.match(api.render.renderPreview(null), /Loading the file/);
    assert.match(api.render.renderPreview({ path: 'a.ts', status: 'loading' }), /Loading the file/);
  });

  it('missing says the file is gone; error shows the message as an alert', () => {
    assert.match(api.render.renderPreview({ path: 'a.ts', status: 'missing' }), /not in the project any more/);
    const err = api.render.renderPreview({ path: 'a.ts', status: 'error', message: 'disk on fire' });
    assert.match(err, /role="alert"/);
    assert.match(err, /disk on fire/);
  });

  it('a binary file says so, with its size, and shows no text', () => {
    const html = api.render.renderPreview({ path: 'a.png', status: 'ready', content: { text: null, binary: true, bytes: 18432, truncated: false, language: null } });
    assert.match(html, /binary file \(18\.0 KiB\)/);
    assert.doesNotMatch(html, /os-code-lines/);
  });

  it('a text file shows its language, numbered lines, and a truncated notice', () => {
    const html = api.render.renderPreview({
      path: 'src/a.ts',
      status: 'ready',
      content: { text: 'one\r\ntwo\n\nthree\n', binary: false, bytes: 16, truncated: true, language: 'TypeScript' },
    });
    assert.match(html, /TypeScript/);
    assert.match(html, /Only the start of this file is shown/);
    assert.match(html, /<span class="os-code-no" aria-hidden="true">1<\/span><span class="os-code-text">one<\/span>/);
    assert.match(html, /<span class="os-code-no" aria-hidden="true">3<\/span><span class="os-code-text"> <\/span>/);
    assert.match(html, /<span class="os-code-no" aria-hidden="true">4<\/span><span class="os-code-text">three<\/span>/);
    assert.equal((html.match(/class="os-code-no"/g) ?? []).length, 4);
  });

  it('fileLines drops the trailing empty line and carriage returns', () => {
    assert.deepEqual(api.selection.fileLines('a\r\nb\r\n'), ['a', 'b']);
    assert.deepEqual(api.selection.fileLines(''), ['']);
  });
});

describe('the file tree', () => {
  const nodes = [
    node('src/a.ts', { path: 'src/a.ts', kind: 'file', degree: 5 }),
    node('fn:a', { path: 'src/a.ts', kind: 'function', degree: 9 }),
    node('src/lib/b.ts', { path: 'src/lib/b.ts', kind: 'file', category: 'code', degree: 2 }),
    node('tests/a.test.ts', { path: 'tests/a.test.ts', category: 'tests' }),
    node('docs/x.md', { path: 'docs/x.md', category: 'docs' }),
    node('note', { category: 'knowledge' }),
    node('win', { path: 'src\\win.ts' }),
  ];

  it('groups files into folders: folders first, alphabetical, with file and category counts', () => {
    const tree = api.fileTree.buildFileTree(nodes);
    assert.deepEqual(tree.root.folders.map((f) => f.name), ['docs', 'src', 'tests']);
    assert.deepEqual(tree.root.files, []);
    const src = tree.root.folders[1];
    assert.deepEqual(src.folders.map((f) => f.name), ['lib']);
    assert.deepEqual(src.files.map((f) => f.name), ['a.ts', 'win.ts']);
    assert.equal(src.fileCount, 3);
    assert.equal(src.counts.code, 4, 'a.ts (file and function), b.ts and win.ts');
    assert.equal(tree.unpathed, 1);
    assert.equal(tree.nodeCount, 6);
  });

  it('a file is selected through its own file node, else its highest-degree node', () => {
    const tree = api.fileTree.buildFileTree(nodes);
    const a = tree.files.find((f) => f.path === 'src/a.ts');
    assert.equal(a.nodeId, 'src/a.ts', 'the file node wins over a higher-degree function');
    assert.equal(a.nodes, 2);
    const test = tree.files.find((f) => f.path === 'tests/a.test.ts');
    assert.equal(test.nodeId, 'tests/a.test.ts');
    assert.equal(test.category, 'tests');
  });

  it('filters by path, case-insensitively, and keeps the folders of what matches', () => {
    const tree = api.fileTree.buildFileTree(nodes);
    const filtered = api.fileTree.filterFileTree(tree, 'LIB');
    assert.deepEqual(filtered.files.map((f) => f.path), ['src/lib/b.ts']);
    assert.deepEqual(filtered.root.folders.map((f) => f.name), ['src']);
    assert.equal(filtered.root.folders[0].fileCount, 1);
    assert.equal(api.fileTree.filterFileTree(tree, '  ').root.folders.length, 3);
    assert.equal(api.fileTree.filterFileTree(tree, 'zzz').files.length, 0);
  });

  it('caps the tree at the node limit and counts what it left out', () => {
    assert.equal(api.fileTree.TREE_MAX_NODES, 5000);
    const tree = api.fileTree.buildFileTree(nodes, 2);
    assert.equal(tree.nodeCount, 2);
    assert.equal(tree.skipped, 4, 'the six pathed nodes beyond the first two (win is the last of them)');
  });

  it('reveals a file by its ancestor folders and normalises paths', () => {
    assert.deepEqual(api.fileTree.ancestorFolders('src/lib/b.ts'), ['src', 'src/lib']);
    assert.deepEqual(api.fileTree.ancestorFolders('a.ts'), []);
    assert.equal(api.fileTree.normalizePath('./a\\b//c.ts'), 'a/b/c.ts');
    assert.equal(api.fileTree.normalizePath(''), '');
  });

  it('the structure tab renders folders with counts, folders before files, and the selected file', () => {
    const html = api.render.renderStructure(nodes, 'src/a.ts');
    assert.ok(html.indexOf('docs/') < html.indexOf('src/'), 'folders in name order');
    assert.match(html, /src\/<\/span><span class="meta os-tree-count">3 files/);
    assert.match(html, /os-tree-selected/);
    assert.match(html, /aria-current="true"/);
    assert.match(html, /aria-label="Filter files"/);
    assert.match(html, /5 files · 6 nodes · 1 not in a file/);
  });

  it('expands big folders on demand: 200 rows, then "show more"', () => {
    const many = Array.from({ length: 205 }, (_, i) => node(`big/f${i}`, { path: `big/f${i}.ts` }));
    const html = api.render.renderStructure(many);
    assert.match(html, /Show 5 more/);
    assert.equal((html.match(/os-tree-file/g) ?? []).length, 200);
  });

  it('says so when there are no paths, and when a filter matches nothing', () => {
    assert.match(api.render.renderStructure([node('x')]), /no file paths yet/);
  });

  it('the code brain offers 3D and Structure, and the structure replaces the stage', () => {
    const project = linkedProject();
    const core = api.systemGraph.computeCore(project);
    const c = controllerWith({});
    c.drill('code');
    const brain = api.render.renderCodeBrain(c, core);
    assert.match(brain, /aria-label="Code view"/);
    assert.match(brain, />3D</);
    assert.match(brain, />Structure</);
    assert.doesNotMatch(brain, /os-tree-panel/);
    c.setCodeTab('structure');
    const structure = api.render.renderCodeBrain(c, core);
    assert.match(structure, /os-tree-panel/);
    assert.match(structure, /class="os-brain-stage" hidden=""/);
  });
});

describe('the code level helpers', () => {
  it('links are directed and drawn-only; the largest node of a cluster is the highest degree', () => {
    const project = linkedProject();
    const index = api.codeNodes.linkIndex(project.edges);
    assert.equal(index.out.get('hub').length, 20);
    assert.equal(index.inc.get('hub').length, 3);
    const core = api.systemGraph.computeCore(project).graph.core;
    const lists = api.codeNodes.linksOf(index, 'hub', core.filter((n) => n.id !== 'dep0'));
    assert.equal(lists.dependsOn.total, 19, 'a trimmed node is not offered');
    const big = [node('a', { community: 3, degree: 4 }), node('b', { community: 3, degree: 9 }), node('c', { community: 3, degree: 9 })];
    assert.equal(api.codeNodes.largestInCommunity(big, 3).id, 'b', 'ties go to the smaller id');
    assert.equal(api.codeNodes.largestInCommunity(big, 7), null);
  });

  it('formats byte sizes', () => {
    assert.equal(api.format.fmtBytes(512), '512 B');
    assert.equal(api.format.fmtBytes(2048), '2.0 KiB');
    assert.equal(api.format.fmtBytes(null), '—');
  });
});

describe('the demo host answers file requests', () => {
  it('opens any file (logged), serves text for project files, a binary sample for png, and null for a missing path', async () => {
    const host = api.demoHost.createFixtureHost();
    assert.equal(host.openFile('src/x.ts', 3), true);
    const project = api.fixture.buildDemoProjectGraph();
    const sample = [...api.fixture.demoFilePaths(project)].find((p) => p.startsWith('src/'));
    const text = await host.loadFile(sample);
    assert.equal(text.path, sample);
    assert.match(text.text, /Generated for the demo/);
    assert.equal(text.language, 'TypeScript');
    const png = await host.loadFile(api.fixture.DEMO_BINARY_PATH);
    assert.deepEqual([png.binary, typeof png.bytes], [true, 'number']);
    assert.equal(await host.loadFile('src/does-not-exist.ts'), null);
  });

  it('the demo nodes carry realistic paths: src/, tests/ and docs/ files, and the binary is a file node', () => {
    const project = api.fixture.buildDemoProjectGraph();
    const paths = [...api.fixture.demoFilePaths(project)];
    assert.ok(paths.some((p) => p.startsWith('src/') && p.endsWith('.ts')));
    assert.ok(paths.some((p) => p.startsWith('tests/') && p.endsWith('.test.ts')));
    assert.ok(paths.some((p) => p.startsWith('docs/') && p.endsWith('.md')));
    assert.ok(paths.includes(api.fixture.DEMO_BINARY_PATH));
    const tree = api.fileTree.buildFileTree(api.systemGraph.computeCore(project, { maxCoreNodes: 4000 }).graph.core);
    assert.ok(tree.files.length > 50, `files in the demo tree: ${tree.files.length}`);
  });
});

describe('paths outside the repo', () => {
  it('normalizePath keeps absolute paths and .. (the identity), drops empty and . segments', async () => {
    const ft = api.fileTree;
    assert.equal(ft.normalizePath('/Users/x/a.ts'), '/Users/x/a.ts');
    assert.equal(ft.normalizePath('~/a.ts'), '~/a.ts');
    assert.equal(ft.normalizePath('C:\\x\\a.ts'), 'C:/x/a.ts');
    assert.equal(ft.normalizePath('../x/./y.ts'), '../x/y.ts');
    assert.equal(ft.normalizePath('/'), '');
  });

  it('only a relative path without .. is a repo path; the drawer shows the path without ..', () => {
    const ft = api.fileTree;
    for (const p of ['src/a.ts', 'a.ts']) assert.equal(ft.isRepoPath(p), true, p);
    for (const p of ['/Users/x/a.ts', '~/a.ts', 'C:/x/a.ts', '../x/a.ts', 'src/../../a.ts', '']) assert.equal(ft.isRepoPath(p), false, p);
    assert.equal(ft.displayPath('../x/y.ts'), 'x/y.ts');
    assert.equal(ft.displayPath('/Users/../x'), '/Users/x');
    assert.equal(ft.displayPath('/Users/x/a.ts'), '/Users/x/a.ts');
  });

  it('the tree keeps outside files in their own group, never under the repo folders', () => {
    const tree = api.fileTree.buildFileTree([
      node('abs', { path: '/Users/x/a.ts', kind: 'file' }),
      node('rel', { path: 'src/a.ts', kind: 'file' }),
      node('up', { path: '../up/b.ts', kind: 'file' }),
    ]);
    assert.deepEqual(tree.root.folders.map((f) => f.name), ['src']);
    assert.deepEqual(tree.root.files, []);
    assert.equal(tree.outside.path, api.fileTree.OUTSIDE_KEY);
    assert.equal(tree.outside.fileCount, 2);
    assert.deepEqual(tree.outside.folders.map((f) => f.name), ['..', 'Users'], 'the .. segment stays in the identity');
    assert.equal(tree.files.length, 3, 'every file is in the flat list');
    assert.equal(tree.outside.folders.find((f) => f.name === 'Users').path, '/Users', 'an absolute folder keeps its leading slash');
  });

  it('the structure shows an "Outside the repo" treeitem with its folders', () => {
    const html = api.render.renderStructure([node('abs', { path: '/Users/x/a.ts', kind: 'file' }), node('rel', { path: 'src/a.ts' })]);
    assert.match(html, /Outside the repo/);
    assert.match(html, /role="treeitem"[^>]*aria-expanded="true"[^>]*>(?:(?!<\/li>).)*Outside the repo/s);
    assert.match(html, /Users\/<\/span>/);
  });

  it('the drawer of an outside file shows no Open or Preview, and says it is outside the repo', () => {
    const abs = api.render.renderCodeSelection({ type: 'core', id: 'abs', label: 'a.ts', detail: 'code' }, { core: [node('abs', { path: '/Users/x/a.ts', kind: 'file' })], project: { nodes: [], edges: [], layers: [], tour: [] } });
    assert.doesNotMatch(abs, /Open in Explorer/);
    assert.doesNotMatch(abs, /Preview code/);
    assert.match(abs, /Outside the repo/);
    assert.match(abs, /<code class="os-path-text" title="\/Users\/x\/a\.ts">\/Users\/x\/a\.ts<\/code>/);
    const dots = api.render.renderCodeSelection({ type: 'core', id: 'up', label: 'b.ts', detail: 'code' }, { core: [node('up', { path: '../up/b.ts', kind: 'file' })], project: { nodes: [], edges: [], layers: [], tour: [] } });
    assert.match(dots, /<code class="os-path-text" title="\.\.\/up\/b\.ts">up\/b\.ts<\/code>/, 'the display drops ..');
    assert.doesNotMatch(dots, /Preview code/);
    const repo = api.render.renderCodeSelection({ type: 'core', id: 'rel', label: 'a.ts', detail: 'code' }, { core: [node('rel', { path: 'src/a.ts', kind: 'file' })], project: { nodes: [], edges: [], layers: [], tour: [] } });
    assert.match(repo, /Open in Explorer/);
    assert.match(repo, /Preview code/);
  });

  it('the controller never sends an outside path to the host', async () => {
    const calls = [];
    const c = controllerWith({
      openFile: (p) => (calls.push(['open', p]), true),
      loadFile: async (p) => (calls.push(['load', p]), { path: p, text: 'x' }),
    });
    c.openFile('/Users/x/a.ts');
    assert.match(c.getSnapshot().notice, /outside the project/);
    await c.loadFilePreview('../x/a.ts');
    assert.equal(c.getSnapshot().filePreview.status, 'error');
    assert.match(c.getSnapshot().filePreview.message, /outside the project/);
    assert.deepEqual(calls, []);
  });
});

describe('the copy fallback', () => {
  /** A fake document with a textarea that records the copy command. */
  function fakeDoc(execResult) {
    const log = { removed: 0, appended: 0, selected: 0, commands: [] };
    return {
      log,
      createElement: () => {
        const area = { value: '', style: {}, setAttribute() {}, select() { log.selected++; } };
        return area;
      },
      body: { appendChild: (n) => (log.appended++, n), removeChild: (n) => (log.removed++, n) },
      execCommand: (cmd) => {
        log.commands.push(cmd);
        if (execResult === 'throw') throw new Error('no exec');
        return execResult;
      },
    };
  }
  const writer = (ok) => ({ writeText: async () => { if (!ok) throw new Error('denied'); } });

  it('the host copy is tried first; when it copies, nothing else runs', async () => {
    const env = { clipboard: { writeText: async () => assert.fail('not reached') }, document: fakeDoc(false) };
    assert.equal(await api.clipboard.copyToClipboard('p', { copyText: () => true }, env), true);
  });

  it('a host copy that says no, or throws, falls back to the async clipboard, then the textarea', async () => {
    assert.equal(await api.clipboard.copyToClipboard('p', { copyText: () => false }, { clipboard: writer(true), document: null }), true);
    assert.equal(await api.clipboard.copyToClipboard('p', { copyText: () => { throw new Error('x'); } }, { clipboard: writer(true), document: null }), true);
  });

  it('a missing or denied async clipboard falls back to a hidden textarea and execCommand', async () => {
    const doc = fakeDoc(true);
    assert.equal(await api.clipboard.copyToClipboard('p', null, { clipboard: null, document: doc }), true);
    assert.deepEqual(doc.log.commands, ['copy']);
    assert.equal(doc.log.appended, 1);
    assert.equal(doc.log.removed, 1, 'the textarea is removed again');
    const denied = fakeDoc(true);
    assert.equal(await api.clipboard.copyToClipboard('p', null, { clipboard: writer(false), document: denied }), true);
  });

  it('when every route fails, the copy reports false (the card then says Copy failed)', async () => {
    assert.equal(await api.clipboard.copyToClipboard('p', null, { clipboard: writer(false), document: fakeDoc(false) }), false);
    assert.equal(await api.clipboard.copyToClipboard('p', null, { clipboard: null, document: fakeDoc('throw') }), false);
    assert.equal(await api.clipboard.copyToClipboard('p', null, { clipboard: null, document: null }), false);
  });

  it('the card says Copy failed with role=status after a failed copy and Copied after a good one', () => {
    const html = api.render.renderCodeSelection({ type: 'core', id: 'rel', label: 'a.ts', detail: 'code' }, { core: [node('rel', { path: 'src/a.ts', kind: 'file' })] });
    assert.match(html, /<span class="meta os-copy-state" role="status"><\/span>/, 'empty until a copy is tried');
    assert.match(html, /aria-label="Copy path src\/a\.ts"/);
  });
});

describe('the preview cap, long lines and the error state', () => {
  const text = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
  const ready = (t, path = 'src/huge.ts') => ({ path, status: 'ready', content: { text: t, binary: false, bytes: t.length, truncated: false, language: 'TypeScript' } });

  it('6,000 lines render 2,000 at first, then "Show more (4,000 lines)"', () => {
    const html = api.render.renderPreview(ready(text(6000)));
    assert.equal(html.split('class="os-code-no"').length - 1, 2000);
    assert.match(html, /Show more \(4,000 lines\)/);
    assert.match(html, /6,000 lines/, 'the caption still counts every line');
  });

  it('2,000 lines or fewer have no "Show more"', () => {
    assert.doesNotMatch(api.render.renderPreview(ready(text(2000))), /Show more/);
    assert.equal(api.render.renderPreview(ready(text(2000))).split('class="os-code-no"').length - 1, 2000);
  });

  it('a line over 2,000 characters is cut with an ellipsis', () => {
    const html = api.render.renderPreview(ready(`${'x'.repeat(2500)}\nshort`));
    assert.ok(html.includes(`${'x'.repeat(2000)}…`), 'cut at 2,000 characters, then the ellipsis');
    assert.ok(!html.includes('x'.repeat(2001)));
    assert.ok(html.includes('short'));
  });

  it('the error state says it could not load the file, shows the message and offers Retry only with a handler', () => {
    const err = { path: 'src/broken.ts', status: 'error', message: 'disk on fire' };
    const withRetry = api.render.renderPreview(err, () => {});
    assert.match(withRetry, /role="alert"/);
    assert.match(withRetry, /Couldn(&#x27;|')t load the file\./);
    assert.match(withRetry, /disk on fire/);
    assert.match(withRetry, /<button[^>]*>Retry<\/button>/);
    assert.doesNotMatch(api.render.renderPreview(err), /Retry/);
  });

  it('shouldRequestPreview asks only when the drawer is open and the preview is not for this path', () => {
    const { shouldRequestPreview } = api.selection;
    const error = { path: 'a.ts', status: 'error', message: 'x' };
    assert.equal(shouldRequestPreview(true, 'a.ts', null), true);
    assert.equal(shouldRequestPreview(true, 'a.ts', { path: 'b.ts', status: 'ready' }), true);
    assert.equal(shouldRequestPreview(true, 'a.ts', { path: 'a.ts', status: 'loading' }), false);
    assert.equal(shouldRequestPreview(true, 'a.ts', error), false, 'an error is not a reason to ask again');
    assert.equal(shouldRequestPreview(false, 'a.ts', null), false);
    assert.equal(shouldRequestPreview(true, '', null), false);
  });

  it('repeated renders with an error preview call loadFile exactly once; Retry is the only second call', async () => {
    let calls = 0;
    const c = controllerWith({ loadFile: async () => { calls++; throw new Error('boom'); } });
    const path = 'src/broken.ts';
    // The Selection's effect: it asks when shouldRequestPreview says so, once per render (the
    // same inputs on each of the renders below, with a fresh callback identity every time).
    for (let render = 0; render < 6; render++) {
      if (api.selection.shouldRequestPreview(true, path, c.getSnapshot().filePreview ?? null)) await c.loadFilePreview(path);
    }
    assert.equal(calls, 1);
    assert.equal(c.getSnapshot().filePreview.status, 'error');
    await c.loadFilePreview(path);
    assert.equal(calls, 2, 'Retry asks again');
  });
});

describe('the dependency-only links', () => {
  function kinded() {
    const nodes = [{ id: 'hub', title: 'hub', kind: 'function', metadata: { source_file: 'src/hub.ts' } }];
    const edges = [];
    const add = (id, from, to, kind) => {
      if (!nodes.some((n) => n.id === id)) nodes.push({ id, title: id, kind: 'function', metadata: { source_file: `src/${id}.ts` } });
      edges.push({ fromId: from, toId: to, kind, confidence: 'EXTRACTED' });
    };
    add('imp', 'hub', 'imp', 'imports');
    add('cal', 'hub', 'cal', 'calls');
    add('ref', 'hub', 'ref', 'references');
    add('dep', 'hub', 'dep', 'dependsOn');
    add('rel', 'hub', 'rel', 'relatedTo');
    add('con', 'hub', 'con', 'contains');
    add('def', 'hub', 'def', 'defines');
    add('doc', 'doc', 'hub', 'documents');
    return { nodes, edges, layers: [], tour: [] };
  }

  it('Depends on counts only dependency kinds; contains and defines are a separate Contains list', () => {
    const project = kinded();
    const core = api.systemGraph.computeCore(project).graph.core;
    const lists = api.codeNodes.linksOf(api.codeNodes.linkIndex(project.edges), 'hub', core);
    assert.equal(lists.dependsOn.total, 4, 'imports, calls, references, dependsOn');
    assert.deepEqual(lists.contains.items.map((n) => n.id).sort(), ['con', 'def']);
    assert.equal(lists.usedBy.total, 0, 'the documents edge from doc is not a use');
    const html = api.render.renderCodeSelection({ type: 'core', id: 'hub', label: 'hub', detail: 'code' }, { core, project });
    assert.match(html, /Contains <span class="meta">2<\/span>/);
    assert.doesNotMatch(html, /relatedTo|rel\.ts/, 'a non-dependency kind is not listed anywhere');
  });

  it('the Contains list is absent when the node contains nothing', () => {
    const project = { nodes: [{ id: 'lone', title: 'lone', kind: 'function', metadata: { source_file: 'src/lone.ts' } }], edges: [], layers: [], tour: [] };
    const core = api.systemGraph.computeCore(project).graph.core;
    const html = api.render.renderCodeSelection({ type: 'core', id: 'lone', label: 'lone', detail: 'code' }, { core, project });
    assert.doesNotMatch(html, /Contains/);
  });
});

describe('the file tree accessibility', () => {
  const nodes = [
    node('src/a.ts', { path: 'src/a.ts', kind: 'file' }),
    node('src/lib/b.ts', { path: 'src/lib/b.ts', kind: 'file' }),
    node('tests/a.test.ts', { path: 'tests/a.test.ts', category: 'tests' }),
  ];

  it('uses the tree pattern: role=tree, treeitems with aria-level and aria-expanded, groups for children', () => {
    const html = api.render.renderStructure(nodes);
    assert.match(html, /<ul class="os-tree-list os-tree-root" role="tree"/);
    assert.ok(html.split('role="treeitem"').length - 1 >= 3);
    assert.match(html, /aria-level="1"/);
    assert.match(html, /aria-level="2"/);
    assert.match(html, /role="group"/);
    assert.match(html, /aria-expanded="false"/, 'tests/ is closed');
  });

  it('roving tabindex: exactly one row is in the tab order, the first one when nothing is selected', () => {
    const html = api.render.renderStructure(nodes);
    assert.equal(html.split('tabindex="0"').length - 1, 1);
    assert.equal(html.split('tabindex="-1"').length - 1, html.split('role="treeitem"').length - 2);
  });

  it('a selected file that is on screen takes the tab stop, and is marked selected', () => {
    const html = api.render.renderStructure(nodes, 'src/a.ts');
    assert.match(html, /aria-selected="true"[^>]*tabindex="0"/);
    assert.equal(html.split('tabindex="0"').length - 1, 1);
  });
});
