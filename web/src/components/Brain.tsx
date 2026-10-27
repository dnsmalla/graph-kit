import { useRef, useState } from 'react';
import type { ViewState, OsController } from '../controller';
import type { CoreView, RingView } from '../systemGraph';
import { SYSTEM_VIEW_LIMITS } from '../systemGraph';
import type { OsActivityItem } from '../types';
import { OrbitPanel } from '../orbit/OrbitPanel';
import { fmtInt } from '../format';
import { Recent, RECENT_LIMIT } from './Recent';
import { Selection } from './Selection';

const LEGEND: Array<{ key: 'code' | 'docs' | 'tests' | 'knowledge' | 'other'; label: string }> = [
  { key: 'code', label: 'Code' },
  { key: 'docs', label: 'Docs' },
  { key: 'tests', label: 'Tests' },
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'other', label: 'Other' },
];

/** The centre column: the project brain, its selection, a colour legend and the recent list. */
export function Brain({
  state,
  controller,
  core,
  ring,
  drawFailed,
  activity,
}: {
  state: ViewState;
  controller: OsController;
  core: CoreView;
  ring: RingView;
  /** True when the host's graph or the activity could not be drawn; the view is then empty. */
  drawFailed: boolean;
  activity: OsActivityItem[];
}) {
  const { graph } = core;
  const status = state.projectGraphStatus;
  const ready = !drawFailed && status === 'ready' && graph.core.length > 0;
  const truncated = graph.truncated.totalNodes > graph.truncated.keptNodes;
  const caption = ready
    ? `${fmtInt(graph.core.length)} nodes · ${fmtInt(ring.items.length)} recent${
        truncated ? ` · showing ${fmtInt(graph.truncated.keptNodes)} of ${fmtInt(graph.truncated.totalNodes)}` : ''
      }`
    : null;
  // Without WebGL the brain cannot be picked, so the recent list stands in for the whole ring.
  const [webgl, setWebgl] = useState(true);
  // The Recent row that opened the current selection; focus returns to it on close.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // The loading and error texts sit under the stage; the stage's own empty text only
  // shows once the load has settled, so the two never overlap.
  const settled = status !== 'loading' && status !== 'idle' && status !== 'error';

  return (
    <section className="os-centre" aria-labelledby="sec-brain">
      <div className="os-centre-head">
        <h2 id="sec-brain" className="card-title">
          Project brain
        </h2>
        {caption ? <p className="meta">{caption}</p> : null}
      </div>

      <div className="os-brain">
        <div className="os-brain-stage">
          <OrbitPanel
            core={drawFailed ? null : core}
            ring={drawFailed ? null : ring}
            showEmpty={settled && !drawFailed}
            onFallback={() => setWebgl(false)}
            onSelect={(item) => {
              triggerRef.current = null;
              controller.select(item);
            }}
          />
        </div>
        {status === 'loading' || status === 'idle' ? (
          <p className="os-brain-status" role="status">
            Loading the project graph…
          </p>
        ) : null}
        {status === 'error' ? (
          <p className="os-brain-status banner-error" role="alert">
            Could not load the project graph.
          </p>
        ) : null}
        {drawFailed ? (
          <p className="os-brain-status banner-error" role="alert">
            Could not draw the project graph.
          </p>
        ) : null}
        {state.selected ? (
          <Selection
            selected={state.selected}
            activity={activity}
            onClose={() => {
              const trigger = triggerRef.current;
              triggerRef.current = null;
              controller.select(null);
              trigger?.focus();
            }}
          />
        ) : null}
      </div>

      <ul className="os-legend" aria-label="Colour legend">
        {LEGEND.map(({ key, label }) => (
          <li key={key}>
            <span className={`os-swatch os-cat-${key}`} aria-hidden="true" />
            {label}
          </li>
        ))}
        <li>
          <span className="os-swatch os-swatch-ring" aria-hidden="true" />
          Recent activity
        </li>
      </ul>

      <Recent
        items={activity}
        controller={controller}
        selected={state.selected}
        limit={webgl ? RECENT_LIMIT : SYSTEM_VIEW_LIMITS.maxRingItems}
        onPick={(row) => {
          triggerRef.current = row;
        }}
      />
    </section>
  );
}
