import { useEffect, useRef, useState, type RefObject } from 'react';
import type { OsSelection, FilePreview, FileContent } from '../controller';
import type { OsCancel, OsActivityItem, OsSnapshot } from '../types';
import type { OsOpenTarget } from '../host';
import type { HubKey, VizGraph, VizNode, VizStatus } from '../viz';
import type { CGData } from '../../../typescript/src/models';
import type { SystemCoreNode } from '../../../typescript/src/system/types';
import { fmtBytes, fmtInt, fmtTime, humanKey, metaRows, words, type MetaRow } from '../format';
import { HUB_TITLES, isHubKey } from '../viz';
import { coreById, largestInCommunity, linkIndex, linksOf, type Neighbour, type NeighbourList } from '../codeNodes';
import { normalizePath } from '../fileTree';

/** The activity row a ring item stands for (ring ids are `activity:<id>`), or null. */
export function findActivity(selected: OsSelection, activity: OsActivityItem[]): OsActivityItem | null {
  if (selected.type !== 'ring' || !selected.id.startsWith('activity:')) return null;
  const id = selected.id.slice('activity:'.length);
  return activity.find((item) => String(item.id) === id) ?? null;
}

/** The OS-graph node a selection stands for, or null when it is not in the drawn graph. */
export function findVizNode(selected: OsSelection, viz: VizGraph | null): VizNode | null {
  if (selected.type !== 'viz' || !viz) return null;
  return viz.nodes.find((node) => node.id === selected.id) ?? null;
}

/** The screen a kind opens in the host, or null when the kind has none. */
export function openTargetFor(kind: string): { target: OsOpenTarget; label: string } | null {
  switch (kind) {
    case 'routine':
      return { target: 'autoTasks', label: 'Open Auto Tasks' };
    case 'kit':
    case 'feature':
    case 'check':
      return { target: 'settings', label: 'Open Settings' };
    case 'sourceKind':
      return { target: 'library', label: 'Open Library' };
    default:
      return null;
  }
}

/** The running item behind an agent node, with the key RunningNow uses for its stop. */
export function runningFor(
  node: VizNode,
  running: OsSnapshot['running'] | null | undefined,
): { cancel: OsCancel; key: string } | null {
  if (!running) return null;
  if (node.kind === 'chatTurn') {
    const id = node.id.slice('chatTurn:'.length);
    const turn = running.chatTurns.find((t) => t.chatSessionId === id);
    return turn ? { cancel: turn.cancel, key: `chat-${id}` } : null;
  }
  if (node.kind === 'agentRun') {
    const id = node.id.slice('agentRun:'.length);
    const run = running.meetingAgentRuns.find((r) => r.sessionId === id);
    return run ? { cancel: run.cancel, key: `agent-${id}` } : null;
  }
  return null;
}

/** A code-cluster node of the OS graph: the cluster summary carries its community index. */
export function isCodeCluster(node: VizNode): boolean {
  return node.kind === 'codeCluster' && typeof node.meta.index === 'number';
}

const STATUS_TEXT: Record<VizStatus, string> = {
  ok: 'OK',
  warn: 'Needs attention',
  off: 'Off',
  running: 'Running',
  unknown: 'Unknown',
};

function StatusChip({ status }: { status: VizStatus }) {
  return <span className={`os-chip os-chip-${status}`}>{STATUS_TEXT[status]}</span>;
}

/** The meta table: scalars as text, arrays as counts, nested objects as key: value lines. */
export function MetaTable({ rows }: { rows: MetaRow[] }) {
  if (rows.length === 0) return null;
  return (
    <table className="os-meta">
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">{row.key}</th>
            <td>
              {row.lines ? (
                <ul className="os-meta-lines">
                  {row.lines.map((line) => (
                    <li key={line.key}>
                      <span className="meta">{line.key}:</span> {line.value}
                    </li>
                  ))}
                </ul>
              ) : (
                row.value
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The actions a viz node offers: Explore for a hub, an Open button where the kind has a screen, and Stop for a cancellable run. */
function VizActions({
  node,
  running,
  stopping,
  onDrill,
  onOpen,
  onStop,
}: {
  node: VizNode;
  running: OsSnapshot['running'] | null | undefined;
  stopping: string | null | undefined;
  onDrill?: (hub: HubKey) => void;
  onOpen?: (target: OsOpenTarget) => void;
  onStop?: (cancel: OsCancel, key: string) => void;
}) {
  const hub = node.kind === 'hub' && isHubKey(node.drill) ? node.drill : null;
  const open = openTargetFor(node.kind);
  const run = runningFor(node, running);
  const cancellable = run !== null && run.cancel !== null;
  const liveNote = node.kind === 'liveSession' ? 'Ends when its capture client stops. Stop it in the Mac app.' : null;
  if (!hub && !open && !run && !liveNote) return null;
  return (
    <div className="os-actions">
      {hub && onDrill ? (
        <button type="button" className="btn btn-primary" onClick={() => onDrill(hub)}>
          Explore {HUB_TITLES[hub]}
        </button>
      ) : null}
      {open && onOpen ? (
        <button type="button" className="btn" onClick={() => onOpen(open.target)}>
          {open.label}
        </button>
      ) : null}
      {cancellable && run?.cancel && onStop ? (
        <button
          type="button"
          className="btn btn-danger"
          aria-label={`Stop ${node.label}`}
          disabled={stopping !== null && stopping !== undefined}
          onClick={() => onStop(run.cancel, run.key)}
        >
          {stopping === run.key ? 'Stopping…' : 'Stop'}
        </button>
      ) : null}
      {liveNote ? <p className="meta">{liveNote}</p> : null}
      {run && !cancellable && node.kind !== 'liveSession' ? <p className="meta">Stop it in the Mac app.</p> : null}
    </div>
  );
}

/** Copies text to the clipboard. False when the host has no clipboard or refuses. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A file's text as numbered lines. A trailing newline does not add an empty last line. */
export function fileLines(text: string): string[] {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The preview body: loading, missing, failed, binary, or the numbered text of the file. */
export function CodePreview({ preview }: { preview: FilePreview | null }) {
  if (!preview || preview.status === 'idle' || preview.status === 'loading') {
    return (
      <p className="meta" role="status">
        Loading the file…
      </p>
    );
  }
  if (preview.status === 'missing') {
    return (
      <p className="meta" role="status">
        This file is not in the project any more.
      </p>
    );
  }
  if (preview.status === 'error') {
    return (
      <p className="banner banner-error" role="alert">
        {preview.message ?? 'Could not load the file.'}
      </p>
    );
  }
  const content: FileContent | undefined = preview.content;
  if (!content) return null;
  if (content.binary) {
    return (
      <p className="meta">
        This is a binary file{content.bytes !== null ? ` (${fmtBytes(content.bytes)})` : ''}. It has no text preview.
      </p>
    );
  }
  const lines = fileLines(content.text ?? '');
  return (
    <figure className="os-code" aria-label="File preview">
      <figcaption className="os-code-head meta">
        {content.language ?? 'Text'}
        {content.bytes !== null ? ` · ${fmtBytes(content.bytes)}` : ''} · {fmtInt(lines.length)} lines
      </figcaption>
      {content.truncated ? <p className="meta os-code-note">Only the start of this file is shown.</p> : null}
      <div className="os-code-scroll" role="region" aria-label="File text" tabIndex={0}>
        <ol className="os-code-lines">
          {lines.map((line, i) => (
            <li key={i}>
              <span className="os-code-no" aria-hidden="true">
                {i + 1}
              </span>
              <span className="os-code-text">{line === '' ? ' ' : line}</span>
            </li>
          ))}
        </ol>
      </div>
    </figure>
  );
}

/** One direction of a node's links: "Depends on" or "Used by", with each drawn neighbour selectable. */
function LinkList({
  title,
  list,
  onPick,
}: {
  title: string;
  list: NeighbourList;
  onPick?: (node: Neighbour) => void;
}) {
  return (
    <section className="os-links" aria-label={title}>
      <h4 className="os-links-title">
        {title} <span className="meta">{fmtInt(list.total)}</span>
      </h4>
      {list.total === 0 ? (
        <p className="meta">None in the drawn graph.</p>
      ) : (
        <ul className="os-link-list">
          {list.items.map((node) => (
            <li key={node.id}>
              <button type="button" className="os-link" title={node.id} onClick={() => onPick?.(node)}>
                <span className={`os-swatch os-cat-${node.category}`} aria-hidden="true" />
                <span className="os-link-label">{node.label}</span>
              </button>
            </li>
          ))}
          {list.more > 0 ? <li className="meta">+{fmtInt(list.more)} more</li> : null}
        </ul>
      )}
    </section>
  );
}

/** The details of a code node: its path, its links, and the file's actions (open in the app, preview). */
function CodeNodeCard({
  selected,
  node,
  core,
  project,
  preview,
  onClose,
  onPreview,
  onOpenFile,
  onFocusCore,
  onCollapse,
  headingRef,
}: {
  selected: OsSelection;
  node: SystemCoreNode;
  core: readonly SystemCoreNode[];
  project: CGData | null;
  preview: FilePreview | null;
  onClose: () => void;
  onPreview?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onFocusCore?: (item: { id: string; label: string; detail: string }) => void;
  onCollapse: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const path = normalizePath(node.path);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  // The preview is loaded when it is opened, and again for another file while it is open.
  useEffect(() => {
    setCopied(false);
  }, [path]);
  useEffect(() => {
    if (!previewOpen || path === '') return;
    const current = previewRef.current;
    if (!current || current.path !== path || current.status === 'error') onPreview?.(path);
  }, [previewOpen, path, onPreview]);

  const links = project ? linksOf(linkIndex(project.edges), node.id, core) : null;
  const community = fmtInt(node.community + 1);
  return (
    <section className="os-selection os-selection-code" aria-labelledby="os-selection-title" aria-live="polite">
      <div className="os-selection-head">
        <span className="meta">Code node</span>
        <div className="os-selection-buttons">
          <button type="button" className="btn os-close" onClick={onCollapse}>
            Hide
          </button>
          <button type="button" className="btn os-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <h3 id="os-selection-title" ref={headingRef} tabIndex={-1} className="sub-title os-selection-title">
        {selected.label}
      </h3>
      <dl className="os-selection-facts">
        <div>
          <dt>Kind</dt>
          <dd>{node.kind ? humanKey(node.kind) : '—'}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>{words(node.category)}</dd>
        </div>
        <div>
          <dt>Community</dt>
          <dd>Cluster {community}</dd>
        </div>
        <div>
          <dt>Degree</dt>
          <dd>{fmtInt(node.degree)}</dd>
        </div>
      </dl>
      {path ? (
        <div className="os-path">
          <span className="meta">Path</span>
          <div className="os-path-row">
            <code className="os-path-text" title={path}>
              {path}
            </code>
            <button
              type="button"
              className="btn os-path-copy"
              aria-label={`Copy path ${path}`}
              onClick={() => {
                void copyText(path).then((ok) => setCopied(ok));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ) : (
        <p className="meta">This node is not in a file.</p>
      )}
      {path ? (
        <div className="os-actions">
          <button type="button" className="btn btn-primary" onClick={() => onOpenFile?.(path)}>
            Open in Explorer
          </button>
          <button type="button" className="btn" aria-expanded={previewOpen} onClick={() => setPreviewOpen((open) => !open)}>
            {previewOpen ? 'Hide preview' : 'Preview code'}
          </button>
        </div>
      ) : null}
      {path && previewOpen ? <CodePreview preview={preview && preview.path === path ? preview : null} /> : null}
      {links ? (
        <>
          <LinkList
            title="Depends on"
            list={links.dependsOn}
            onPick={(n) => onFocusCore?.({ id: n.id, label: n.label, detail: n.category })}
          />
          <LinkList
            title="Used by"
            list={links.usedBy}
            onPick={(n) => onFocusCore?.({ id: n.id, label: n.label, detail: n.category })}
          />
        </>
      ) : null}
    </section>
  );
}

/**
 * Details of the picked brain or ring item. Overlaid on the brain as a right-hand drawer (it does
 * not cover the node it describes at the left); it can be collapsed to a tab. The heading takes
 * focus when the drawer opens, and the region is a polite live region so the change is announced.
 * An OS-graph node shows its status, a readable meta table and the actions its kind offers; a code
 * node shows its path, its links and its file's actions; a code cluster lists its top files; a
 * project node without a graph entry and an activity item show their own facts.
 */
export function Selection({
  selected,
  activity,
  viz = null,
  running = null,
  stopping = null,
  core = null,
  project = null,
  preview = null,
  onClose,
  onDrill,
  onOpen,
  onStop,
  onPreview,
  onOpenFile,
  onFocusCore,
  onExploreCluster,
}: {
  selected: OsSelection;
  activity: OsActivityItem[];
  /** The graph the brain is drawing. An OS-graph node is looked up in it. */
  viz?: VizGraph | null;
  /** The snapshot's running items, for the Stop action of an agent node. */
  running?: OsSnapshot['running'] | null;
  /** The key of the running item whose Stop request is in flight. */
  stopping?: string | null;
  /** The drawn code nodes (the project's core). A code node is looked up in it. */
  core?: readonly SystemCoreNode[] | null;
  /** The project's graph: its directed edges give a code node's links. */
  project?: CGData | null;
  /** The code preview state of the file last asked for. */
  preview?: FilePreview | null;
  onClose: () => void;
  onDrill?: (hub: HubKey) => void;
  onOpen?: (target: OsOpenTarget) => void;
  onStop?: (cancel: OsCancel, key: string) => void;
  onPreview?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  /** A linked node was picked: select it and fly to it. */
  onFocusCore?: (item: { id: string; label: string; detail: string }) => void;
  /** "Explore in code" on a code cluster: the cluster's largest node, or null when there is none. */
  onExploreCluster?: (node: SystemCoreNode | null) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const match = findActivity(selected, activity);
  const node = findVizNode(selected, viz);
  const coreNode = selected.type === 'core' && core ? (coreById(core).get(selected.id) ?? null) : null;

  // The heading takes focus when the drawer opens (on mount, and again when it is expanded).
  useEffect(() => {
    if (!collapsed) headingRef.current?.focus();
  }, [collapsed]);

  if (collapsed) {
    return (
      <button
        type="button"
        className="os-drawer-tab"
        aria-label={`Show details for ${selected.label}`}
        onClick={() => setCollapsed(false)}
      >
        Details
      </button>
    );
  }

  if (selected.type === 'core' && coreNode && core) {
    return (
      <CodeNodeCard
        selected={selected}
        node={coreNode}
        core={core}
        project={project}
        preview={preview}
        onClose={onClose}
        onPreview={onPreview}
        onOpenFile={onOpenFile}
        onFocusCore={onFocusCore}
        onCollapse={() => setCollapsed(true)}
        headingRef={headingRef}
      />
    );
  }

  const heading = (
    <h3 id="os-selection-title" ref={headingRef} tabIndex={-1} className="sub-title os-selection-title">
      {selected.label}
    </h3>
  );
  const head = (kind: string) => (
    <div className="os-selection-head">
      <span className="meta">{kind}</span>
      <div className="os-selection-buttons">
        <button type="button" className="btn os-close" onClick={() => setCollapsed(true)}>
          Hide
        </button>
        <button type="button" className="btn os-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );

  if (selected.type === 'viz') {
    const kindText = node ? humanKey(node.kind) : words(selected.detail);
    if (node && isCodeCluster(node)) {
      const topLabels = Array.isArray(node.meta.topLabels) ? (node.meta.topLabels as unknown[]).filter((s): s is string => typeof s === 'string') : [];
      const top = core ? largestInCommunity(core, node.meta.index as number) : null;
      const rest = metaRows(node.meta).filter((row) => !['top labels', 'index', 'top files'].includes(row.key.toLowerCase()));
      return (
        <section className="os-selection" aria-labelledby="os-selection-title" aria-live="polite">
          {head('Code cluster')}
          {heading}
          <dl className="os-selection-facts">
            <div>
              <dt>Kind</dt>
              <dd>Code cluster</dd>
            </div>
          </dl>
          <MetaTable rows={rest} />
          {topLabels.length > 0 ? (
            <section className="os-links" aria-label="Top files">
              <h4 className="os-links-title">Top files</h4>
              <ol className="os-top-files">
                {topLabels.map((label, i) => (
                  <li key={`${i}-${label}`}>{label}</li>
                ))}
              </ol>
            </section>
          ) : null}
          <div className="os-actions">
            <button type="button" className="btn btn-primary" onClick={() => onExploreCluster?.(top)}>
              Explore in code
            </button>
          </div>
        </section>
      );
    }
    return (
      <section className="os-selection" aria-labelledby="os-selection-title" aria-live="polite">
        {head(node && node.kind === 'hub' ? 'Part of the OS' : 'OS graph')}
        {heading}
        <dl className="os-selection-facts">
          <div>
            <dt>Kind</dt>
            <dd>{kindText}</dd>
          </div>
          {node?.status ? (
            <div>
              <dt>Status</dt>
              <dd>
                <StatusChip status={node.status} />
              </dd>
            </div>
          ) : null}
        </dl>
        {node ? <MetaTable rows={metaRows(node.meta)} /> : <p className="meta">Not in this view any more.</p>}
        {node ? (
          <VizActions node={node} running={running} stopping={stopping} onDrill={onDrill} onOpen={onOpen} onStop={onStop} />
        ) : null}
      </section>
    );
  }

  return (
    <section className="os-selection" aria-labelledby="os-selection-title" aria-live="polite">
      {head(selected.type === 'core' ? 'Project node' : 'Recent activity')}
      {heading}
      <dl className="os-selection-facts">
        {selected.type === 'core' ? (
          <div>
            <dt>Category</dt>
            <dd>{words(selected.detail)}</dd>
          </div>
        ) : (
          <>
            <div>
              <dt>Kind</dt>
              <dd>{words(match ? match.kind : selected.detail)}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{match ? fmtTime(match.createdAt) : 'Not in the recent window'}</dd>
            </div>
          </>
        )}
      </dl>
    </section>
  );
}
