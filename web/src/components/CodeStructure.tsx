import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { SystemCoreNode } from '../../../typescript/src/system/types';
import { ancestorFolders, buildFileTree, CATEGORIES, filterFileTree, normalizePath, TREE_CHILD_CAP, type CategoryCounts, type FileTree, type TreeFile, type TreeFolder } from '../fileTree';
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

/**
 * The project's file structure: a collapsible tree of the code graph's files, folders first and
 * alphabetical. A folder shows its file count and category dots. A file click selects its node
 * (the brain flies there when the view switches back to 3D). The selected node's file is revealed
 * (its folders open) and scrolled to. Folders show TREE_CHILD_CAP rows, then "show more".
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

  // The folders that are open. The top level starts open; a reveal opens the selected file's folders.
  const [open, setOpen] = useState<Set<string>>(() => new Set(tree.root.folders.map((f) => f.path)));
  // Folders whose "show more" was pressed: they list every child.
  const [all, setAll] = useState<Set<string>>(() => new Set());
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const scrollPending = useRef(false);

  useEffect(() => {
    if (selectedPath === '') return;
    scrollPending.current = true;
    const ancestors = ancestorFolders(selectedPath);
    setOpen((prev) => (ancestors.every((a) => prev.has(a)) ? prev : new Set([...prev, ...ancestors])));
  }, [selectedPath]);

  // Scroll once the revealed row is on screen. Runs after the reveal re-renders.
  useEffect(() => {
    if (!scrollPending.current || !selectedRef.current) return;
    scrollPending.current = false;
    selectedRef.current.scrollIntoView?.({ block: 'nearest' });
  }, [selectedPath, open]);

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

  const renderFile = (file: TreeFile, depth: number) => {
    const selected = file.path === selectedPath;
    return (
      <li key={`f:${file.path}`}>
        <button
          type="button"
          ref={selected ? selectedRef : undefined}
          className={selected ? 'os-tree-row os-tree-file os-tree-selected' : 'os-tree-row os-tree-file'}
          style={{ paddingLeft: 8 + depth * 14 + 16 }}
          aria-current={selected ? 'true' : undefined}
          title={file.path}
          onClick={() => pick(file)}
        >
          <span className="os-tree-name">{file.name}</span>
          <span className="meta os-tree-count">{fmtInt(file.nodes)} {file.nodes === 1 ? 'node' : 'nodes'}</span>
          <CategoryDots counts={file.counts} />
        </button>
      </li>
    );
  };

  const renderFolder = (folder: TreeFolder, depth: number): ReactElement => {
    const expanded = isOpen(folder.path);
    return (
      <li key={`d:${folder.path}`}>
        <button
          type="button"
          className="os-tree-row os-tree-folder"
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-expanded={expanded}
          onClick={() => toggle(folder.path)}
        >
          <span className="os-tree-chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="os-tree-name">{folder.name}/</span>
          <span className="meta os-tree-count">{fmtInt(folder.fileCount)} {folder.fileCount === 1 ? 'file' : 'files'}</span>
          <CategoryDots counts={folder.counts} />
        </button>
        {expanded ? renderChildren(folder, depth + 1) : null}
      </li>
    );
  };

  const renderChildren = (folder: TreeFolder, depth: number): ReactElement => {
    const rows: Array<{ key: string; render: () => ReactElement }> = [
      ...folder.folders.map((child) => ({ key: `d:${child.path}`, render: () => renderFolder(child, depth) })),
      ...folder.files.map((file) => ({ key: `f:${file.path}`, render: () => renderFile(file, depth) })),
    ];
    const cap = all.has(folder.path) ? rows.length : TREE_CHILD_CAP;
    const hidden = rows.length - cap;
    return (
      <ul className="os-tree-list" role="group">
        {rows.slice(0, cap).map((row) => row.render())}
        {hidden > 0 ? (
          <li>
            <button
              type="button"
              className="os-tree-row os-tree-more"
              style={{ paddingLeft: 8 + depth * 14 + 16 }}
              onClick={() => setAll((prev) => new Set([...prev, folder.path]))}
            >
              Show {fmtInt(hidden)} more
            </button>
          </li>
        ) : null}
      </ul>
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
        <ul className="os-tree-list os-tree-root" role="tree" aria-label="Files">
          {shown.root.folders.map((folder) => renderFolder(folder, 0))}
          {shown.root.files.map((file) => renderFile(file, 0))}
        </ul>
      )}
    </div>
  );
}
