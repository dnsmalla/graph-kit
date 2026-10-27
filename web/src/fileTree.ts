// The project's file structure: the code graph's nodes grouped by the file they are in. Pure
// functions over the core nodes (SystemCoreNode.path), so the page, its tests and any host
// read the same tree. Folders aggregate their files; a file is one path, with its nodes counted.
//
// Paths come in three shapes. A repo path is relative and has no `..` (the only kind the page
// sends to a host). An absolute path ('/x', '~/x', 'C:/x') and any path with `..` is outside the
// repo: it is kept (never rebased onto the repo), listed under "Outside the repo", and has no
// Open or Preview action.
import type { CoreCategory, SystemCoreNode } from '../../typescript/src/system/types';

/** Most core nodes the tree is built from. The core keeps at most 4000 already; this is the hard ceiling. */
export const TREE_MAX_NODES = 5000;
/** Rows a folder shows before its "show more" control (expand on demand keeps big trees light). */
export const TREE_CHILD_CAP = 200;
/** The key of the synthetic folder that holds the files outside the repo. */
export const OUTSIDE_KEY = '\u0000outside';

export const CATEGORIES: readonly CoreCategory[] = ['code', 'docs', 'tests', 'knowledge', 'other'];

/** How many nodes of each category a folder or file holds. Every category is present (zero when none). */
export type CategoryCounts = Record<CoreCategory, number>;

export interface TreeFile {
  /** The normalised path, the file's identity. */
  path: string;
  name: string;
  /** The node a click on the file selects: the file's own node, else its highest-degree node. */
  nodeId: string;
  /** The category of that node. */
  category: CoreCategory;
  /** Nodes in the file. */
  nodes: number;
  counts: CategoryCounts;
}

export interface TreeFolder {
  /** The normalised path ('' for the root, OUTSIDE_KEY for the outside group). */
  path: string;
  name: string;
  /** Sub-folders, then files: both sorted by name. */
  folders: TreeFolder[];
  files: TreeFile[];
  /** Files anywhere below this folder. */
  fileCount: number;
  /** Nodes anywhere below this folder. */
  nodeCount: number;
  counts: CategoryCounts;
}

export interface FileTree {
  /** The repo's folders and files. */
  root: TreeFolder;
  /** The files outside the repo (absolute, `~`, or with `..`), as one folder keyed OUTSIDE_KEY. Empty when there are none. */
  outside: TreeFolder;
  /** Every file, repo and outside, in path order. */
  files: TreeFile[];
  /** Nodes that have a path and are in the tree. */
  nodeCount: number;
  /** Nodes with no path: they are in no file, so no tree row. */
  unpathed: number;
  /** Nodes with a path that were past TREE_MAX_NODES and left out. */
  skipped: number;
}

export function emptyCounts(): CategoryCounts {
  return { code: 0, docs: 0, tests: 0, knowledge: 0, other: 0 };
}

/** Code-unit order: the same on every host, unlike a locale collation. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A path as the tree keys it: backslashes become slashes, empty and '.' segments go. A leading '/'
 * (an absolute path) is kept, as are '~' and a drive ('C:'). '..' is kept here (it is the identity of
 * an outside path); `displayPath` drops it for showing. '' when nothing is left.
 */
export function normalizePath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const slashed = raw.replace(/\\/g, '/');
  const segments = slashed.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return '';
  return (slashed.startsWith('/') ? '/' : '') + segments.join('/');
}

/** True for an absolute path: a leading '/', a leading '~', or a drive ('C:/'). */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:\//.test(path);
}

/**
 * True when the path is inside the repo: relative and without a '..' segment. Only such a path is
 * sent to a host (open, preview). Takes a normalised path.
 */
export function isRepoPath(path: string): boolean {
  return path !== '' && !isAbsolutePath(path) && !path.split('/').includes('..');
}

/** The path as the drawer shows it: '..' segments dropped (the identity keeps them). */
export function displayPath(path: string): string {
  const absolute = path.startsWith('/') ? '/' : '';
  return absolute + path.split('/').filter((segment) => segment !== '' && segment !== '..').join('/');
}

/** The folder keys a file sits in, outermost first: `a/b/c.ts` gives `a`, `a/b`; `/x/y.ts` gives `/x`. */
export function ancestorFolders(path: string): string[] {
  const normal = normalizePath(path);
  const segments = normal.split('/').filter((segment) => segment !== '');
  const prefix = normal.startsWith('/') ? '/' : '';
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) out.push(prefix + segments.slice(0, i).join('/'));
  return out;
}

/** The node a file's click selects: a `file` node (or one whose id is the path) first, then the highest degree, then the smaller id. */
function primaryOf(nodes: SystemCoreNode[], path: string): SystemCoreNode {
  let best = nodes[0]!;
  for (const node of nodes) {
    if (node === best) continue;
    const isFile = (n: SystemCoreNode) => n.kind === 'file' || n.id === path;
    if (isFile(node) !== isFile(best)) {
      if (isFile(node)) best = node;
      continue;
    }
    if (node.degree !== best.degree) {
      if (node.degree > best.degree) best = node;
      continue;
    }
    if (compareNames(node.id, best.id) < 0) best = node;
  }
  return best;
}

/** The tree of the given core nodes. Only nodes with a path are in it; the rest are counted as `unpathed`. */
export function buildFileTree(nodes: readonly SystemCoreNode[], maxNodes: number = TREE_MAX_NODES): FileTree {
  const byPath = new Map<string, SystemCoreNode[]>();
  let unpathed = 0;
  let skipped = 0;
  let kept = 0;
  for (const node of nodes) {
    const path = normalizePath(node.path);
    if (path === '') {
      unpathed++;
      continue;
    }
    if (kept >= maxNodes) {
      skipped++;
      continue;
    }
    kept++;
    const group = byPath.get(path);
    if (group) group.push(node);
    else byPath.set(path, [node]);
  }
  const files: TreeFile[] = [...byPath.keys()].sort(compareNames).map((path) => {
    const group = byPath.get(path)!;
    const primary = primaryOf(group, path);
    const counts = emptyCounts();
    for (const node of group) counts[node.category] += 1;
    const segments = path.split('/').filter((segment) => segment !== '');
    return {
      path,
      name: segments[segments.length - 1] ?? path,
      nodeId: primary.id,
      category: primary.category,
      nodes: group.length,
      counts,
    };
  });
  return { ...assemble(files), unpathed, skipped };
}

/** The repo tree and the outside tree of a sorted file list. */
function assemble(files: readonly TreeFile[]): Omit<FileTree, 'unpathed' | 'skipped'> {
  const repo = files.filter((file) => isRepoPath(file.path));
  const outside = files.filter((file) => !isRepoPath(file.path));
  const root = treeFromFiles(repo).root;
  const outsideRoot = treeFromFiles(outside).root;
  const outsideFolder: TreeFolder = { ...outsideRoot, path: OUTSIDE_KEY, name: 'Outside the repo' };
  return {
    root,
    outside: outsideFolder,
    files: [...files],
    nodeCount: root.nodeCount + outsideRoot.nodeCount,
  };
}

/** Folders and their totals built from a list of files (sorted by path). The root is the folder with path ''. */
export function treeFromFiles(files: readonly TreeFile[]): { root: TreeFolder; files: TreeFile[]; nodeCount: number } {
  const root: TreeFolder = { path: '', name: '', folders: [], files: [], fileCount: 0, nodeCount: 0, counts: emptyCounts() };
  const folders = new Map<string, TreeFolder>([['', root]]);
  for (const file of files) {
    const segments = file.path.split('/').filter((segment) => segment !== '');
    let parent = root;
    addTo(root, file);
    for (let i = 0; i < segments.length - 1; i++) {
      const path = ancestorFolders(file.path)[i]!;
      let folder = folders.get(path);
      if (!folder) {
        folder = { path, name: segments[i]!, folders: [], files: [], fileCount: 0, nodeCount: 0, counts: emptyCounts() };
        folders.set(path, folder);
        parent.folders.push(folder);
      }
      addTo(folder, file);
      parent = folder;
    }
    parent.files.push(file);
  }
  for (const folder of folders.values()) {
    folder.folders.sort((a, b) => compareNames(a.name, b.name));
    folder.files.sort((a, b) => compareNames(a.name, b.name));
  }
  return { root, files: [...files], nodeCount: root.nodeCount };
}

function addTo(folder: TreeFolder, file: TreeFile): void {
  folder.fileCount += 1;
  folder.nodeCount += file.nodes;
  for (const category of CATEGORIES) folder.counts[category] += file.counts[category];
}

/**
 * The tree narrowed to the files whose path contains `query` (case-insensitive). The folders are
 * rebuilt from the matching files, so their counts are the matching ones. An empty query returns the tree.
 */
export function filterFileTree(tree: FileTree, query: string): FileTree {
  const q = query.trim().toLowerCase();
  if (q === '') return tree;
  const matching = tree.files.filter((file) => file.path.toLowerCase().includes(q));
  return { ...assemble(matching), unpathed: tree.unpathed, skipped: tree.skipped };
}
