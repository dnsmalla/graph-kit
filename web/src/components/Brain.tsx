import { useMemo, useRef, useState } from 'react';
import type { ViewState, OsController } from '../controller';
import type { CoreView, RingView } from '../systemGraph';
import { SYSTEM_VIEW_LIMITS } from '../systemGraph';
import type { OsActivityItem } from '../types';
import { OrbitPanel, type OrbitPanelHandle } from '../orbit/OrbitPanel';
import type { OrbitColorMode } from '../orbit/OrbitView';
import { clusterSummary, CLUSTER_PALETTE_SIZE, uniqueCoreNodes } from '../orbit/scene';
import { fmtInt } from '../format';
import { Recent, RECENT_LIMIT } from './Recent';
import { NodeSearch } from './NodeSearch';
import { Selection } from './Selection';

const LEGEND: Array<{ key: 'code' | 'docs' | 'tests' | 'knowledge' | 'other'; label: string }> = [
  { key: 'code', label: 'Code' },
  { key: 'docs', label: 'Docs' },
  { key: 'tests', label: 'Tests' },
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'other', label: 'Other' },
];

/** Clusters listed in the legend before the "and N more" line. */
const CLUSTER_LEGEND_LIMIT = 10;

/** The centre column: the project brain, its search, selection, colour legend and the recent list. */
export function Brain({
  state,
  controller,
  core,
  ring,
  drawFailed,
  coreLoading,
  activity,
}: {
  state: ViewState;
  controller: OsController;
  core: CoreView;
  ring: RingView;
  /** True when the host's graph or the activity could not be drawn; the view is then empty. */
  drawFailed: boolean;
  /** True while the core is still compiling: the brain shows its loading state. */
  coreLoading: boolean;
  activity: OsActivityItem[];
}) {
  const { graph } = core;
  const status = state.projectGraphStatus;
  const drawing = !drawFailed && !coreLoading;
  const ready = drawing && status === 'ready' && graph.core.length > 0;
  const truncated = graph.truncated.totalNodes > graph.truncated.keptNodes;
  const caption = ready
    ? `${fmtInt(graph.core.length)} nodes · ${fmtInt(ring.items.length)} recent${
        truncated ? ` · showing ${fmtInt(graph.truncated.keptNodes)} of ${fmtInt(graph.truncated.totalNodes)}` : ''
      }`
    : null;
  // Without WebGL the brain cannot be picked, so the recent list stands in for the whole ring.
  const [webgl, setWebgl] = useState(true);
  const [colorBy, setColorBy] = useState<OrbitColorMode>('kind');
  // The brain's imperative handle: search flies the camera through it.
  const brainRef = useRef<OrbitPanelHandle>(null);
  // The Recent row that opened the current selection; focus returns to it on close.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // The loading and error texts sit under the stage; the stage's own empty text only
  // shows once the load has settled, so the two never overlap.
  const settled = status !== 'loading' && status !== 'idle' && status !== 'error';
  const clusters = useMemo(() => clusterSummary(uniqueCoreNodes(graph)), [graph]);

  return (
    <section className="os-centre" aria-labelledby="sec-brain">
      <div className="os-centre-head">
        <h2 id="sec-brain" className="card-title">
          Project brain
        </h2>
        {caption ? <p className="meta">{caption}</p> : null}
      </div>

      <NodeSearch
        graph={ready ? graph : null}
        onChoose={(hit) => {
          triggerRef.current = null;
          brainRef.current?.focusNode(hit.id);
          controller.select({ type: 'core', id: hit.id, label: hit.label, detail: hit.category });
        }}
      />

      <div className="os-brain">
        <div className="os-brain-stage">
          <OrbitPanel
            ref={brainRef}
            core={drawing ? core : null}
            ring={drawing ? ring : null}
            showEmpty={settled && drawing}
            selectedId={state.selected?.id ?? null}
            colorBy={colorBy}
            onColorByChange={setColorBy}
            onFallback={() => setWebgl(false)}
            onSelect={(item) => {
              triggerRef.current = null;
              controller.select(item);
            }}
          />
        </div>
        {status === 'loading' || status === 'idle' || coreLoading ? (
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

      {colorBy === 'cluster' ? (
        <ul className="os-legend" aria-label="Cluster legend">
          {clusters.slice(0, CLUSTER_LEGEND_LIMIT).map(({ community, count }) => (
            <li key={community}>
              <span
                className="os-swatch"
                aria-hidden="true"
                style={{ background: `var(--os-cluster-${(community % CLUSTER_PALETTE_SIZE) + 1})` }}
              />
              Cluster {community + 1} · {fmtInt(count)}
            </li>
          ))}
          {clusters.length > CLUSTER_LEGEND_LIMIT ? (
            <li>and {fmtInt(clusters.length - CLUSTER_LEGEND_LIMIT)} more</li>
          ) : null}
          <li>
            <span className="os-swatch os-swatch-ring" aria-hidden="true" />
            Recent activity
          </li>
        </ul>
      ) : (
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
      )}

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
