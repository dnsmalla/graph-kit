import { useEffect, useRef } from 'react';
import type { OsSelection } from '../controller';
import type { OsCancel, OsActivityItem, OsSnapshot } from '../types';
import type { OsOpenTarget } from '../host';
import type { HubKey, VizGraph, VizNode, VizStatus } from '../viz';
import { fmtTime, humanKey, metaRows, words, type MetaRow } from '../format';
import { HUB_TITLES, isHubKey } from '../viz';

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

/**
 * Details of the picked brain or ring item. Overlaid on the brain; closes with the button. The
 * heading takes focus when the overlay opens, and the region is a polite live region so the
 * change is announced. An OS-graph node shows its status, a readable meta table and the actions
 * its kind offers; a project node and an activity item show their own facts, as before.
 */
export function Selection({
  selected,
  activity,
  viz = null,
  running = null,
  stopping = null,
  onClose,
  onDrill,
  onOpen,
  onStop,
}: {
  selected: OsSelection;
  activity: OsActivityItem[];
  /** The graph the brain is drawing. An OS-graph node is looked up in it. */
  viz?: VizGraph | null;
  /** The snapshot's running items, for the Stop action of an agent node. */
  running?: OsSnapshot['running'] | null;
  /** The key of the running item whose Stop request is in flight. */
  stopping?: string | null;
  onClose: () => void;
  onDrill?: (hub: HubKey) => void;
  onOpen?: (target: OsOpenTarget) => void;
  onStop?: (cancel: OsCancel, key: string) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const match = findActivity(selected, activity);
  const node = findVizNode(selected, viz);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const heading = (
    <h3 id="os-selection-title" ref={headingRef} tabIndex={-1} className="sub-title os-selection-title">
      {selected.label}
    </h3>
  );

  if (selected.type === 'viz') {
    const kindText = node ? humanKey(node.kind) : words(selected.detail);
    return (
      <section className="os-selection" aria-labelledby="os-selection-title" aria-live="polite">
        <div className="os-selection-head">
          <span className="meta">{node && node.kind === 'hub' ? 'Part of the OS' : 'OS graph'}</span>
          <button type="button" className="btn os-close" onClick={onClose}>
            Close
          </button>
        </div>
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
      <div className="os-selection-head">
        <span className="meta">{selected.type === 'core' ? 'Project node' : 'Recent activity'}</span>
        <button type="button" className="btn os-close" onClick={onClose}>
          Close
        </button>
      </div>
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
