// The project's file structure: the code graph's nodes grouped by the file they are in. Pure
// functions over the core nodes (SystemCoreNode.path), so the page, its tests and any host
// read the same tree. Folders aggregate their files; a file is one path, with its nodes counted.
import type { CoreCategory, SystemCoreNode } from '../../typescript/src/system/types';

/** Most core nodes the tree is built from. The core keeps at most 4000 already; this is the hard ceiling. */
export const TREE_MAX_NODES = 5000;
/** Rows a folder shows before its "show more" control (expand on demand keeps big trees light). */
export const TREE_CHILD_CAP = 200;

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
  /** The normalised path ('' for the root). */
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
  root: TreeFolder;
  /** Every file, in path order (the flat list the tree is built from). */
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

/** A path as the tree keys it: backslashes become slashes, empty and '.' segments go. '' when nothing is left. */
export function normalizePath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/** The folders a file sits in, outermost first: `a/b/c.ts` gives `a`, `a/b`. */
export function ancestorFolders(path: string): string[] {
  const segments = normalizePath(path).split('/');
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) out.push(segments.slice(0, i).join('/'));
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
    const segments = path.split('/');
    return {
      path,
      name: segments[segments.length - 1]!,
      nodeId: primary.id,
      category: primary.category,
      nodes: group.length,
      counts,
    };
  });
  return { ...treeFromFiles(files), unpathed, skipped };
}

/** Folders and their totals built from a list of files (sorted by path). */
export function treeFromFiles(files: readonly TreeFile[]): FileTree {
  const root: TreeFolder = { path: '', name: '', folders: [], files: [], fileCount: 0, nodeCount: 0, counts: emptyCounts() };
  const folders = new Map<string, TreeFolder>([['', root]]);
  for (const file of files) {
    const segments = file.path.split('/');
    let parent = root;
    addTo(root, file);
    let path = '';
    for (let i = 0; i < segments.length - 1; i++) {
      path = path === '' ? segments[i]! : `${path}/${segments[i]}`;
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
  return {
    root,
    files: [...files],
    nodeCount: root.nodeCount,
    unpathed: 0,
    skipped: 0,
  };
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
  return { ...treeFromFiles(matching), unpathed: tree.unpathed, skipped: tree.skipped };
}
