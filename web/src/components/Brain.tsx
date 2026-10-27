import { useEffect, useMemo, useRef, useState } from 'react';
import type { OsSelection, ViewState, OsController } from '../controller';
import type { CoreView, RingView, VizView } from '../systemGraph';
import { SYSTEM_VIEW_LIMITS } from '../systemGraph';
import type { OsActivityItem, OsSnapshot } from '../types';
import { OrbitPanel, type OrbitPanelHandle } from '../orbit/OrbitPanel';
import type { OrbitColorMode, OrbitPick } from '../orbit/OrbitView';
import { clusterSummary, CLUSTER_PALETTE_SIZE, uniqueCoreNodes, VIZ_KIND_COLORS, VIZ_KIND_FALLBACK, vizKindSummary } from '../orbit/scene';
import { fmtInt, humanKey } from '../format';
import { HUB_TITLES, isHubKey, type HubKey, type VizGraph } from '../viz';
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

/** Status tints in the OS graph's legend. */
const STATUS_LEGEND: Array<{ key: string; label: string }> = [
  { key: 'ok', label: 'OK' },
  { key: 'warn', label: 'Needs attention' },
  { key: 'off', label: 'Off' },
  { key: 'running', label: 'Running' },
];

/** Clusters listed in the legend before the "and N more" line. */
const CLUSTER_LEGEND_LIMIT = 10;
/** A click on a hub right after a drill is the same gesture: it must not pick a node of the new view. */
const DRILL_GUARD_MS = 500;

/** A pick as a selection: edges are hover-only and never selected. */
function toSelection(item: OrbitPick): OsSelection | null {
  if (item.type === 'edge') return null;
  return { type: item.type, id: item.id, label: item.label, detail: item.detail };
}

/**
 * The centre column: the brain (the OS graph, one part of it, or the project's code graph), its
 * breadcrumb, search, selection, legend and the recent list. A hub node opens its part; Back and
 * Escape return to the OS. The camera is remembered per level.
 */
export function Brain({
  state,
  controller,
  core,
  ring,
  drawFailed,
  coreLoading,
  activity,
  viz = null,
  osFailed = false,
  running = null,
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
  /** The OS graph or a hub's graph to draw. Null while it loads or when the level has none. */
  viz?: VizView | null;
  /** The OS graph could not be drawn. */
  osFailed?: boolean;
  /** The snapshot's running items, for the Stop action of an agent node. */
  running?: OsSnapshot['running'] | null;
}) {
  const view = state.view;
  const inCode = view.level === 'hub' && view.hub === 'code';
  const { graph } = core;
  const status = state.projectGraphStatus;
  // The code brain draws the project's core; the OS levels draw the OS graph or one part of it.
  const drawing = inCode ? !drawFailed && !coreLoading : !osFailed && viz !== null;
  const vizGraph: VizGraph | null = !inCode && drawing && viz ? viz.graph : null;
  const ready = inCode && drawing && status === 'ready' && graph.core.length > 0;
  const truncated = graph.truncated.totalNodes > graph.truncated.keptNodes;
  const codeCaption = ready
    ? `${fmtInt(graph.core.length)} nodes · ${fmtInt(ring.items.length)} recent${
        truncated ? ` · showing ${fmtInt(graph.truncated.keptNodes)} of ${fmtInt(graph.truncated.totalNodes)}` : ''
      }`
    : null;
  // A part's own centre (its hub node) carries the part's counts; the OS graph has no centre.
  const centre = vizGraph && vizGraph.level !== 'os' ? vizGraph.nodes.find((node) => node.kind === 'hub') : undefined;
  const members = typeof centre?.meta.members === 'number' ? centre.meta.members : null;
  const more = typeof centre?.meta.more === 'number' ? centre.meta.more : 0;
  const vizCaption = vizGraph
    ? view.level === 'os'
      ? `${fmtInt(vizGraph.nodes.length)} nodes · ${fmtInt(vizGraph.edges.length)} links`
      : `${members !== null ? `${fmtInt(members)} members` : `${fmtInt(vizGraph.nodes.length)} nodes`}${
          more > 0 ? ` · ${fmtInt(more)} not shown` : ''
        }`
    : null;
  const caption = inCode ? codeCaption : vizCaption;
  // Without WebGL the brain cannot be picked, so the recent list stands in for the whole ring.
  const [webgl, setWebgl] = useState(true);
  const [colorBy, setColorBy] = useState<OrbitColorMode>('kind');
  // The brain's imperative handle: search, the camera memory and the focus requests go through it.
  const brainRef = useRef<OrbitPanelHandle>(null);
  // The Recent row that opened the current selection; focus returns to it on close.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Picks are ignored for a moment after a drill (see DRILL_GUARD_MS).
  const drillGuard = useRef(0);
  // The loading and error texts sit under the stage; the stage's own empty text only
  // shows once the load has settled, so the two never overlap.
  const settled = status !== 'loading' && status !== 'idle' && status !== 'error';
  const clusters = useMemo(() => (inCode ? clusterSummary(uniqueCoreNodes(graph)) : []), [graph, inCode]);
  const kinds = useMemo(() => (vizGraph ? vizKindSummary(vizGraph.nodes) : []), [vizGraph]);
  const viewKey = view.level === 'os' ? 'os' : `hub:${view.hub}`;
  const title = inCode ? 'Project brain' : view.level === 'os' ? 'The whole OS' : HUB_TITLES[view.hub];
  const crumbTitle = view.level === 'os' ? 'OS' : HUB_TITLES[view.hub];

  // The camera memory: the brain tells the controller where its camera is, so a navigation
  // remembers the level it leaves; the level being entered gets its remembered pose back.
  useEffect(() => {
    controller.setCameraSource(() => brainRef.current?.getCamera() ?? null);
    return () => controller.setCameraSource(null);
  }, [controller]);
  const restored = useRef(viewKey);
  useEffect(() => {
    if (restored.current === viewKey) return;
    restored.current = viewKey;
    const pose = controller.cameraFor(view);
    if (pose) brainRef.current?.setCamera(pose);
    else brainRef.current?.refit();
  }, [viewKey, controller, view]);

  // A side panel asked for a node: fly to it once the level that holds it is drawn.
  const focused = useRef(state.focusSeq);
  useEffect(() => {
    if (focused.current === state.focusSeq) return;
    focused.current = state.focusSeq;
    if (state.selected) brainRef.current?.focusNode(state.selected.id);
  }, [state.focusSeq, state.selected]);

  const drill = (hub: HubKey) => {
    drillGuard.current = Date.now() + DRILL_GUARD_MS;
    triggerRef.current = null;
    controller.drill(hub);
  };
  const goOs = () => {
    drillGuard.current = Date.now() + DRILL_GUARD_MS;
    triggerRef.current = null;
    controller.back();
  };

  // Escape returns from a part to the OS. Typing in a field keeps its own Escape (the search clears).
  useEffect(() => {
    if (view.level !== 'hub') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      goOs();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // goOs is rebuilt each render but only reads the controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.level, controller]);

  const onSearchChoose = (hit: { id: string; label: string; category: string }) => {
    triggerRef.current = null;
    brainRef.current?.focusNode(hit.id);
    controller.select(
      vizGraph
        ? { type: 'viz', id: hit.id, label: hit.label, detail: hit.category }
        : { type: 'core', id: hit.id, label: hit.label, detail: hit.category },
    );
  };

  return (
    <section className="os-centre" aria-labelledby="sec-brain">
      <div className="os-centre-head">
        <h2 id="sec-brain" className="card-title">
          {title}
        </h2>
        {caption ? <p className="meta">{caption}</p> : null}
      </div>

      {!inCode ? (
        <div className="os-notices">
          {osFailed ? (
            <p className="banner banner-error" role="alert">
              Could not draw the OS graph.
            </p>
          ) : null}
          {drawFailed ? (
            <p className="banner banner-error" role="alert">
              Could not draw the project graph.
            </p>
          ) : null}
          {status === 'error' ? (
            <p className="banner banner-error" role="alert">
              Could not load the project graph.
            </p>
          ) : null}
          {status === 'loading' || status === 'idle' || coreLoading ? (
            <p className="meta" role="status">
              Loading the project graph…
            </p>
          ) : null}
        </div>
      ) : null}

      <nav className="os-crumbs" aria-label="Where you are">
        {view.level === 'os' ? (
          <span className="os-crumb os-crumb-current" aria-current="page">
            OS
          </span>
        ) : (
          <>
            <button type="button" className="os-crumb os-crumb-link" onClick={goOs}>
              OS
            </button>
            <span className="os-crumb-sep" aria-hidden="true">
              ›
            </span>
            <span className="os-crumb os-crumb-current" aria-current="page">
              {crumbTitle}
            </span>
            <button type="button" className="btn os-back" onClick={goOs}>
              Back
            </button>
          </>
        )}
      </nav>

      <NodeSearch
        graph={inCode && ready ? graph : null}
        viz={vizGraph}
        onChoose={onSearchChoose}
      />

      <div className="os-brain">
        <div className="os-brain-stage">
          <OrbitPanel
            ref={brainRef}
            core={inCode && drawing ? core : null}
            ring={drawing ? ring : null}
            viz={!inCode && drawing && viz ? viz : null}
            showEmpty={settled && drawing}
            selectedId={state.selected?.id ?? null}
            colorBy={colorBy}
            onColorByChange={setColorBy}
            onFallback={() => setWebgl(false)}
            onSelect={(item) => {
              if (Date.now() < drillGuard.current) return;
              triggerRef.current = null;
              // A hub node opens its part (the code hub opens the project's graph); every other node selects.
              if (item.type === 'viz' && isHubKey(item.drill)) {
                drill(item.drill);
                return;
              }
              const selection = toSelection(item);
              if (selection) controller.select(selection);
            }}
          />
        </div>
        {/* The code brain says what it waits for over the stage. The OS draws at once; its
            project-graph notices sit above the stage instead, so the graph stays visible. */}
        {inCode && (status === 'loading' || status === 'idle' || coreLoading) ? (
          <p className="os-brain-status" role="status">
            Loading the project graph…
          </p>
        ) : null}
        {inCode && status === 'error' ? (
          <p className="os-brain-status banner-error" role="alert">
            Could not load the project graph.
          </p>
        ) : null}
        {inCode && drawFailed ? (
          <p className="os-brain-status banner-error" role="alert">
            Could not draw the project graph.
          </p>
        ) : null}
        {!inCode && !viz && !osFailed ? (
          <p className="os-brain-status" role="status">
            Loading the OS graph…
          </p>
        ) : null}
        {state.selected ? (
          <Selection
            selected={state.selected}
            activity={activity}
            viz={vizGraph}
            running={running}
            stopping={state.stopping}
            onDrill={drill}
            onOpen={(target) => controller.open(target)}
            onStop={(cancel, key) => void controller.stopItem(cancel, key)}
            onClose={() => {
              const trigger = triggerRef.current;
              triggerRef.current = null;
              controller.select(null);
              trigger?.focus();
            }}
          />
        ) : null}
      </div>

      {inCode && colorBy === 'cluster' ? (
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
      ) : null}
      {inCode && colorBy !== 'cluster' ? (
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
      ) : null}
      {!inCode && vizGraph ? (
        <ul className="os-legend" aria-label="Kind legend">
          {kinds.map(({ kind, count }) => (
            <li key={kind}>
              <span className="os-swatch" aria-hidden="true" style={{ background: VIZ_KIND_COLORS[kind] ?? VIZ_KIND_FALLBACK }} />
              {humanKey(kind)} · {fmtInt(count)}
            </li>
          ))}
          {STATUS_LEGEND.map(({ key, label }) => (
            <li key={key} className="os-legend-status">
              <span className={`os-chip os-chip-${key}`}>{label}</span>
            </li>
          ))}
        </ul>
      ) : null}

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
