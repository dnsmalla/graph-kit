import type { ViewState, OsController } from '../controller';
import type { SystemView } from '../systemGraph';
import type { OsActivityItem } from '../types';
import { OrbitPanel } from '../orbit/OrbitPanel';
import { fmtInt } from '../format';
import { Recent } from './Recent';
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
  view,
  activity,
}: {
  state: ViewState;
  controller: OsController;
  view: SystemView;
  activity: OsActivityItem[];
}) {
  const { graph } = view;
  const status = state.projectGraphStatus;
  const ready = status === 'ready' && graph.core.length > 0;
  const truncated = graph.truncated.totalNodes > graph.truncated.keptNodes;
  const caption = ready
    ? `${fmtInt(graph.core.length)} nodes · ${fmtInt(graph.ring.length)} recent${
        truncated ? ` · showing ${fmtInt(graph.truncated.keptNodes)} of ${fmtInt(graph.truncated.totalNodes)}` : ''
      }`
    : null;

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
          <OrbitPanel graph={graph} layout={view.layout} onSelect={(item) => controller.select(item)} />
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
        {state.selected ? (
          <Selection selected={state.selected} activity={activity} onClose={() => controller.select(null)} />
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

      <Recent items={activity} controller={controller} />
    </section>
  );
}
