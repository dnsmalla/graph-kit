import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { SystemCoreNode } from '../../../typescript/src/system/types';
import {
  ancestorFolders,
  buildFileTree,
  CATEGORIES,
  filterFileTree,
  isRepoPath,
  normalizePath,
  OUTSIDE_KEY,
  TREE_CHILD_CAP,
  type CategoryCounts,
  type FileTree,
  type TreeFile,
  type TreeFolder,
} from '../fileTree';
import { coreById } from '../codeNodes';
import { fmtInt, words } from '../format';

/** The category dots of a folder or file: one coloured dot and count per category that has nodes. */
function CategoryDots({ counts }: { counts: CategoryCounts }) {
  const present = CATEGORIES.filter((c) => counts[c] > 0);
  if (present.length === 0) return null;
  return (
    <span className="os-tree-dots" title={present.map((c) => `${words(c)} ${fmtInt(counts[c])}`).join(', ')}>
      {present.map((c) => (
        <span key={c} className="os-tree-dot">
          <span className={`os-swatch os-cat-${c}`} aria-hidden="true" />
          {fmtInt(counts[c])}
        </span>
      ))}
    </span>
  );
}

/** A row under a folder (or the tree root): a sub-folder, or a file. */
type Child = { kind: 'folder'; folder: TreeFolder } | { kind: 'file'; file: TreeFile };

/** A folder's rows: its sub-folders, then its files. */
function childrenOf(folder: TreeFolder): Child[] {
  return [
    ...folder.folders.map((f): Child => ({ kind: 'folder', folder: f })),
    ...folder.files.map((file): Child => ({ kind: 'file', file })),
  ];
}

/** The tree's top level: the repo's folders and files, then the "Outside the repo" group when it has files. */
function topChildren(tree: FileTree): Child[] {
  const out = childrenOf(tree.root);
  if (tree.outside.fileCount > 0) out.push({ kind: 'folder', folder: tree.outside });
  return out;
}

/** A row the keyboard can reach: its key (the DOM id), its path, its parent row and its level. */
interface Entry {
  key: string;
  kind: 'folder' | 'file';
  path: string;
  parentKey: string | null;
  level: number;
}

/** The rows on screen, in order: the open folders' rows, each folder capped at TREE_CHILD_CAP until "show more". */
function visibleEntries(
  children: Child[],
  parentKey: string | null,
  parentPath: string | null,
  level: number,
  isOpen: (path: string) => boolean,
  showAll: Set<string>,
  out: Entry[] = [],
): Entry[] {
  const cap = parentPath === null || showAll.has(parentPath) ? children.length : TREE_CHILD_CAP;
  for (const child of children.slice(0, cap)) {
    if (child.kind === 'folder') {
      const key = `d:${child.folder.path}`;
      out.push({ key, kind: 'folder', path: child.folder.path, parentKey, level });
      if (isOpen(child.folder.path)) {
        visibleEntries(childrenOf(child.folder), key, child.folder.path, level + 1, isOpen, showAll, out);
      }
    } else {
      out.push({ key: `f:${child.file.path}`, kind: 'file', path: child.file.path, parentKey, level });
    }
  }
  return out;
}

/**
 * The project's file structure: a collapsible tree of the code graph's files, folders first and
 * alphabetical, with the files outside the repo under their own group. It follows the WAI-ARIA tree
 * pattern: arrow keys move, Right/Left open and close or step to a child/parent, Home/End jump, Enter
 * or Space activates, and one row at a time is in the tab order (roving tabindex). A file click
 * selects its node (the brain flies there when the view switches back to 3D). The selected node's
 * file is revealed (its folders open) and scrolled to. A folder shows TREE_CHILD_CAP rows, then "show more".
 */
export function CodeStructure({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: readonly SystemCoreNode[];
  selectedId: string | null;
  onSelect: (node: SystemCoreNode) => void;
}) {
  const tree = useMemo(() => buildFileTree(nodes), [nodes]);
  const [query, setQuery] = useState('');
  const shown: FileTree = useMemo(() => filterFileTree(tree, query), [tree, query]);
  const byId = useMemo(() => coreById(nodes), [nodes]);
  const selectedPath = useMemo(() => {
    const node = selectedId ? byId.get(selectedId) : undefined;
    return node ? normalizePath(node.path) : '';
  }, [byId, selectedId]);

  // The folders that are open, and the folders whose "show more" was pressed. Both are keyed by
  // folder path and kept across refreshes: a new `nodes` array does not close what the user opened.
  // The top level starts open, and so does a top-level folder that appears later (a graph that
  // loads after mount); a folder the user closed stays closed.
  const topKeys = (t: FileTree): string[] => topChildren(t).flatMap((c) => (c.kind === 'folder' ? [c.folder.path] : []));
  const [open, setOpen] = useState<Set<string>>(() => new Set(topKeys(tree)));
  const seenTop = useRef<Set<string>>(new Set(topKeys(tree)));
  const [all, setAll] = useState<Set<string>>(() => new Set());
  // The row the keyboard is on (roving tabindex); null until the user moves into the tree.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const focusRequest = useRef<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const selectedRef = useRef<HTMLLIElement | null>(null);
  const scrollPending = useRef(false);

  useEffect(() => {
    const fresh = topKeys(tree).filter((key) => !seenTop.current.has(key));
    if (fresh.length === 0) return;
    for (const key of fresh) seenTop.current.add(key);
    setOpen((prev) => new Set([...prev, ...fresh]));
  }, [tree]);

  useEffect(() => {
    if (selectedPath === '') return;
    scrollPending.current = true;
    const ancestors = isRepoPath(selectedPath) ? ancestorFolders(selectedPath) : [OUTSIDE_KEY, ...ancestorFolders(selectedPath)];
    setOpen((prev) => (ancestors.every((a) => prev.has(a)) ? prev : new Set([...prev, ...ancestors])));
  }, [selectedPath]);

  // Scroll once the revealed row is on screen. Runs after the reveal re-renders.
  useEffect(() => {
    if (!scrollPending.current || !selectedRef.current) return;
    scrollPending.current = false;
    selectedRef.current.scrollIntoView?.({ block: 'nearest' });
  }, [selectedPath, open]);

  // Moves the focus to the row a key press asked for, once that row is rendered.
  useEffect(() => {
    const target = focusRequest.current;
    if (target === null) return;
    focusRequest.current = null;
    itemRefs.current.get(target)?.focus();
  });

  const filtering = query.trim() !== '';
  const isOpen = (path: string) => filtering || open.has(path);
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const pick = (file: TreeFile) => {
    const node = byId.get(file.nodeId);
    if (node) onSelect(node);
  };

  const entries = shown.files.length === 0 ? [] : visibleEntries(topChildren(shown), null, null, 1, isOpen, all);
  const activeKey =
    entries.find((e) => e.key === focusKey)?.key ??
    entries.find((e) => e.kind === 'file' && e.path === selectedPath)?.key ??
    entries[0]?.key ??
    null;

  const moveTo = (key: string) => {
    focusRequest.current = key;
    setFocusKey(key);
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = entries.findIndex((e) => e.key === activeKey);
    if (index < 0) return;
    const entry = entries[index]!;
    const last = entries.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        moveTo(entries[Math.min(index + 1, last)]!.key);
        break;
      case 'ArrowUp':
        moveTo(entries[Math.max(index - 1, 0)]!.key);
        break;
      case 'Home':
        moveTo(entries[0]!.key);
        break;
      case 'End':
        moveTo(entries[last]!.key);
        break;
      case 'ArrowRight': {
        if (entry.kind !== 'folder') break;
        if (!isOpen(entry.path)) toggle(entry.path);
        else if (entries[index + 1]?.parentKey === entry.key) moveTo(entries[index + 1]!.key);
        break;
      }
      case 'ArrowLeft': {
        if (entry.kind === 'folder' && isOpen(entry.path)) toggle(entry.path);
        else if (entry.parentKey !== null) moveTo(entry.parentKey);
        break;
      }
      case 'Enter':
      case ' ': {
        if (entry.kind === 'folder') toggle(entry.path);
        else {
          const file = shown.files.find((f) => f.path === entry.path);
          if (file) pick(file);
        }
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const rowRef = (key: string) => (el: HTMLLIElement | null) => {
    if (el) itemRefs.current.set(key, el);
    else itemRefs.current.delete(key);
  };

  const renderItems = (children: Child[], parentPath: string | null, level: number): ReactElement[] => {
    const cap = parentPath === null || all.has(parentPath) ? children.length : TREE_CHILD_CAP;
    const rows = children.slice(0, cap).map((child) =>
      child.kind === 'folder' ? renderFolder(child.folder, level) : renderFile(child.file, level),
    );
    if (cap < children.length && parentPath !== null) {
      rows.push(
        <li key={`more:${parentPath}`} role="none">
          <button
            type="button"
            className="os-tree-row os-tree-more"
            style={{ paddingLeft: 8 + (level - 1) * 14 + 16 }}
            onClick={() => setAll((prev) => new Set([...prev, parentPath]))}
          >
            Show {fmtInt(children.length - cap)} more
          </button>
        </li>,
      );
    }
    return rows;
  };

  const renderFile = (file: TreeFile, level: number): ReactElement => {
    const key = `f:${file.path}`;
    const selected = file.path === selectedPath;
    return (
      <li
        key={key}
        role="treeitem"
        aria-level={level}
        aria-selected={selected}
        aria-current={selected ? 'true' : undefined}
        tabIndex={key === activeKey ? 0 : -1}
        className="os-tree-item"
        ref={(el) => {
          rowRef(key)(el);
          if (selected) selectedRef.current = el;
        }}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocusKey(key);
        }}
      >
        <div
          className={selected ? 'os-tree-row os-tree-file os-tree-selected' : 'os-tree-row os-tree-file'}
          style={{ paddingLeft: 8 + (level - 1) * 14 + 16 }}
          title={file.path}
          onClick={() => pick(file)}
        >
          <span className="os-tree-name">{file.name}</span>
          <span className="meta os-tree-count">
            {fmtInt(file.nodes)} {file.nodes === 1 ? 'node' : 'nodes'}
          </span>
          <CategoryDots counts={file.counts} />
        </div>
      </li>
    );
  };

  const renderFolder = (folder: TreeFolder, level: number): ReactElement => {
    const key = `d:${folder.path}`;
    const expanded = isOpen(folder.path);
    const outside = folder.path === OUTSIDE_KEY;
    return (
      <li
        key={key}
        role="treeitem"
        aria-level={level}
        aria-expanded={expanded}
        tabIndex={key === activeKey ? 0 : -1}
        className="os-tree-item"
        ref={rowRef(key)}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocusKey(key);
        }}
      >
        <div
          className="os-tree-row os-tree-folder"
          style={{ paddingLeft: 8 + (level - 1) * 14 }}
          onClick={() => toggle(folder.path)}
        >
          <span className="os-tree-chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="os-tree-name">{outside ? 'Outside the repo' : `${folder.name}/`}</span>
          <span className="meta os-tree-count">
            {fmtInt(folder.fileCount)} {folder.fileCount === 1 ? 'file' : 'files'}
          </span>
          <CategoryDots counts={folder.counts} />
        </div>
        {expanded ? (
          <ul className="os-tree-list" role="group">
            {renderItems(childrenOf(folder), folder.path, level + 1)}
          </ul>
        ) : null}
      </li>
    );
  };

  const empty = tree.files.length === 0;
  return (
    <div className="os-tree-panel">
      <div className="os-tree-head">
        <label className="os-tree-filter">
          <span className="meta">Filter</span>
          <input
            type="search"
            value={query}
            placeholder="Filter files"
            aria-label="Filter files"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p className="meta" role="status">
          {empty ? 'No files with a path yet' : `${fmtInt(shown.files.length)} files · ${fmtInt(shown.nodeCount)} nodes`}
          {tree.unpathed > 0 ? ` · ${fmtInt(tree.unpathed)} not in a file` : ''}
          {tree.skipped > 0 ? ` · ${fmtInt(tree.skipped)} left out` : ''}
        </p>
      </div>
      {empty ? (
        <p className="meta os-tree-empty">The project graph has no file paths yet. Files appear here once the graph has them.</p>
      ) : shown.files.length === 0 ? (
        <p className="meta os-tree-empty">No file path contains “{query.trim()}”.</p>
      ) : (
        <ul
          className="os-tree-list os-tree-root"
          role="tree"
          aria-label="Files"
          onKeyDown={onTreeKeyDown}
        >
          {renderItems(topChildren(shown), null, 1)}
        </ul>
      )}
    </div>
  );
}
