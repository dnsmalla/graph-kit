import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OsSelection, ViewState, OsController } from '../controller';
import type { CoreView, RingView, VizView } from '../systemGraph';
import { SYSTEM_VIEW_LIMITS } from '../systemGraph';
import type { OsActivityItem, OsSnapshot } from '../types';
import { OrbitPanel, type OrbitPanelHandle } from '../orbit/OrbitPanel';
import type { OrbitColorMode, OrbitPick } from '../orbit/OrbitView';
import { clusterSummary, CLUSTER_PALETTE_SIZE, uniqueCoreNodes, VIZ_KIND_COLORS, VIZ_KIND_FALLBACK, vizKindSummary } from '../orbit/scene';
import { fmtInt, humanKey, words } from '../format';
import { DRILL_GUARD_MS, HUB_TITLES, isHubKey, levelKey, swallowsPick, type DrillGuard, type HubKey, type VizGraph } from '../viz';
import { NodeSearch } from './NodeSearch';
import { Selection } from './Selection';
import { CodeStructure } from './CodeStructure';
import { HubOverview, ActivityOverview } from './HubOverview';
import type { CodeTab } from '../controller';

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

/** A pick as a selection: edges are hover-only and never selected. */
function toSelection(item: OrbitPick): OsSelection | null {
  if (item.type === 'edge') return null;
  return { type: item.type, id: item.id, label: item.label, detail: item.detail };
}

/** What the details drawer shows: a hub's overview, a selected node, the activity timeline, or nothing. */
type DrawerContent = { kind: 'hub'; hub: string } | { kind: 'selection' } | { kind: 'activity' } | null;

/**
 * The stage: the brain fills it (the OS graph, one part of it, or the project's code graph), with
 * the breadcrumb, search, the code toggle, the legend and the activity chip as overlays, and the
 * details drawer on the right (a bottom sheet on a narrow stage). The drawer's content follows the
 * selection and the level; the brain's canvas is padded while the drawer is open, so nothing it
 * draws sits under it. Back and Escape return to the OS; Escape hides the drawer first.
 */
export function Brain({
  state,
  controller,
  core,
  ring,
  drawFailed,
  coreLoading,
  activity,
  data = null,
  viz = null,
  osFailed = false,
  osLoading = false,
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
  /** The snapshot, for the hub overviews and the drawer's figures. */
  data?: OsSnapshot | null;
  /** The OS graph or a hub's graph to draw. Null while it loads or when the level has none. */
  viz?: VizView | null;
  /** The OS graph could not be drawn. */
  osFailed?: boolean;
  /** The OS graph is still being built: the brain says so until it is ready. */
  osLoading?: boolean;
  /** The snapshot's running items, for the Stop action of an agent node. */
  running?: OsSnapshot['running'] | null;
}) {
  const view = state.view;
  const inCode = view.level === 'hub' && view.hub === 'code';
  const { graph } = core;
  const codeTab: CodeTab = inCode ? state.codeTab : 'brain';
  const structure = codeTab === 'structure';
  const status = state.projectGraphStatus;
  const drawing = inCode ? !drawFailed && !coreLoading : !osFailed && viz !== null;
  const vizGraph: VizGraph | null = !inCode && drawing && viz ? viz.graph : null;
  const ready = inCode && drawing && status === 'ready' && graph.core.length > 0;
  const truncated = graph.truncated.totalNodes > graph.truncated.keptNodes;
  const codeCaption = ready
    ? `${fmtInt(graph.core.length)} nodes · ${fmtInt(ring.items.length)} recent${
        truncated ? ` · showing ${fmtInt(graph.truncated.keptNodes)} of ${fmtInt(graph.truncated.totalNodes)}` : ''
      }`
    : null;
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
  // Without WebGL the brain cannot be picked; the activity timeline then lists the ring.
  const [, setWebgl] = useState(true);
  const [colorBy, setColorBy] = useState<OrbitColorMode>('kind');
  const [legendOpen, setLegendOpen] = useState(false);
  const brainRef = useRef<OrbitPanelHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const drillGuard = useRef<DrillGuard | null>(null);
  const headingRef = useRef<HTMLSpanElement>(null);
  const settled = status !== 'loading' && status !== 'idle' && status !== 'error';
  const clusters = useMemo(() => (inCode ? clusterSummary(uniqueCoreNodes(graph)) : []), [graph, inCode]);
  const kinds = useMemo(() => (vizGraph ? vizKindSummary(vizGraph.nodes) : []), [vizGraph]);
  const viewKey = view.level === 'os' ? 'os' : `hub:${view.hub}`;
  const crumbTitle = view.level === 'os' ? 'OS' : HUB_TITLES[view.hub];

  // A hub node selected on the OS (or on a part) is shown as that hub's overview.
  const selectedHub: string | null = (() => {
    if (!state.selected || state.selected.type !== 'viz' || !vizGraph) return null;
    const node = vizGraph.nodes.find((n) => n.id === state.selected?.id);
    return node && node.kind === 'hub' && isHubKey(node.drill) ? node.drill : null;
  })();
  const drawer: DrawerContent = state.selected
    ? selectedHub
      ? { kind: 'hub', hub: selectedHub }
      : { kind: 'selection' }
    : view.level === 'hub'
      ? { kind: 'hub', hub: view.hub }
      : state.osPanel === 'activity'
        ? { kind: 'activity' }
        : null;
  const drawerOpen = drawer !== null && state.drawerClosed[levelKey(view)] !== true;
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;

  // The camera memory: the brain reports its camera so a navigation remembers the level it leaves.
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
    headingRef.current?.focus({ preventScroll: true });
  }, [viewKey, controller, view]);

  // A side action asked for a node: fly to it once the level that holds it is drawn.
  const focused = useRef(state.focusSeq);
  useEffect(() => {
    if (focused.current === state.focusSeq) return;
    focused.current = state.focusSeq;
    if (state.selected && codeTab === 'brain') brainRef.current?.focusNode(state.selected.id);
  }, [state.focusSeq, state.selected, codeTab]);

  // Back from the structure to the 3D brain: the selected node is flown to.
  const shownTab = useRef(codeTab);
  useEffect(() => {
    const previous = shownTab.current;
    shownTab.current = codeTab;
    if (previous === 'structure' && codeTab === 'brain' && state.selected) brainRef.current?.focusNode(state.selected.id);
  }, [codeTab, state.selected]);

  const drill = (hub: HubKey) => {
    drillGuard.current = { id: `hub:${hub}`, until: Date.now() + DRILL_GUARD_MS };
    triggerRef.current = null;
    controller.drill(hub);
  };
  const goOs = () => {
    triggerRef.current = null;
    controller.back();
  };

  // Enter opens the selected hub when the focus is on the stage (not on a control).
  useEffect(() => {
    if (!selectedHub || !vizGraph) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.tagName === 'A' || target.isContentEditable)) return;
      event.preventDefault();
      if (isHubKey(selectedHub)) drill(selectedHub);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // drill is rebuilt each render but only reads the controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHub, vizGraph, controller]);

  // Escape hides the drawer first; with the drawer hidden it returns from a part to the OS.
  // Typing in a field keeps its own Escape (the search clears).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (drawerOpenRef.current) {
        event.preventDefault();
        controller.setDrawerOpen(false);
        return;
      }
      if (view.level === 'hub') {
        event.preventDefault();
        goOs();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // goOs is rebuilt each render but only reads the controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.level, controller]);

  // "/" focuses the search, unless the focus is already in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSearchChoose = (hit: { id: string; label: string; category: string }) => {
    triggerRef.current = null;
    brainRef.current?.focusNode(hit.id);
    controller.select(
      vizGraph
        ? { type: 'viz', id: hit.id, label: hit.label, detail: hit.category }
        : { type: 'core', id: hit.id, label: hit.label, detail: hit.category },
    );
  };

  // Stable callbacks: a new identity on every render would re-run the Selection's preview request.
  const loadPreview = useCallback((path: string) => void controller.loadFilePreview(path), [controller]);
  const openFileInApp = useCallback((path: string) => controller.openFile(path), [controller]);
  const copyTextFor = useCallback((text: string) => controller.copyText(text), [controller]);

  const closeSelection = () => {
    const trigger = triggerRef.current;
    triggerRef.current = null;
    controller.select(null);
    trigger?.focus();
  };
  const hideDrawer = () => controller.setDrawerOpen(false);
  const showDrawer = () => controller.setDrawerOpen(true);
  const drawerTitle = drawer?.kind === 'hub' ? (HUB_TITLES[drawer.hub as HubKey] ?? words(drawer.hub)) : drawer?.kind === 'activity' ? 'Activity' : '';

  return (
    <section className={drawerOpen ? 'os-centre os-centre-drawer' : 'os-centre'} aria-labelledby="sec-brain">
      <div className={drawerOpen ? 'os-brain os-brain-drawer' : 'os-brain'}>
        <div className="os-brain-stage" hidden={structure}>
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
              if (swallowsPick(drillGuard.current, item.id, Date.now())) return;
              triggerRef.current = null;
              const selection = toSelection(item);
              if (selection) controller.select(selection);
            }}
            onActivate={(item) => {
              if (swallowsPick(drillGuard.current, item.id, Date.now())) return;
              triggerRef.current = null;
              if (item.type === 'viz' && isHubKey(item.drill)) {
                drill(item.drill);
                return;
              }
              const selection = toSelection(item);
              if (selection) controller.select(selection);
            }}
          />
        </div>
        {inCode && structure ? (
          <div className="os-tree-host os-tree-host-drawer">
            {status === 'ready' || graph.core.length > 0 ? (
              <CodeStructure
                nodes={graph.core}
                selectedId={state.selected?.id ?? null}
                onSelect={(node) => {
                  triggerRef.current = null;
                  controller.select({ type: 'core', id: node.id, label: node.label ?? node.id, detail: node.category });
                }}
              />
            ) : (
              <p className="meta os-tree-empty">{status === 'error' ? 'Could not load the project graph.' : 'Loading the project graph…'}</p>
            )}
          </div>
        ) : null}
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
        {!inCode && !viz && !osFailed && osLoading ? (
          <p className="os-brain-status" role="status">
            Loading the OS graph…
          </p>
        ) : null}
      </div>

      <div className="os-top-left">
        <nav className="os-crumbs" aria-label="Where you are">
          {view.level === 'os' ? (
            <span className="os-crumb os-crumb-current" aria-current="page" ref={headingRef} tabIndex={-1} id="sec-brain">
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
              <span className="os-crumb os-crumb-current" aria-current="page" ref={headingRef} tabIndex={-1} id="sec-brain">
                {crumbTitle}
              </span>
              <button type="button" className="btn os-back" onClick={goOs}>
                Back
              </button>
            </>
          )}
        </nav>
        {inCode ? (
          <div className="seg os-codeview" role="group" aria-label="Code view">
            {(['brain', 'structure'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                aria-pressed={codeTab === tab}
                className={codeTab === tab ? 'seg-btn seg-on' : 'seg-btn'}
                onClick={() => controller.setCodeTab(tab)}
              >
                {tab === 'brain' ? '3D' : 'Structure'}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="os-top-centre">
        <NodeSearch
          graph={inCode && ready ? graph : null}
          viz={vizGraph}
          onChoose={onSearchChoose}
          inputRef={searchRef}
        />
      </div>

      <div className="os-notices">
        {osFailed ? (
          <p className="banner banner-error" role="alert">
            Could not draw the OS graph.
          </p>
        ) : null}
        {!inCode && drawFailed ? (
          <p className="banner banner-error" role="alert">
            Could not draw the project graph.
          </p>
        ) : null}
        {!inCode && status === 'error' ? (
          <p className="banner banner-error" role="alert">
            Could not load the project graph.
          </p>
        ) : null}
        {!inCode && (status === 'loading' || status === 'idle' || coreLoading) ? (
          <p className="meta" role="status">
            Loading the project graph…
          </p>
        ) : null}
      </div>

      <div className="os-bottom-left">
        {legendOpen ? (
          inCode && colorBy === 'cluster' ? (
            <ul className="os-legend" aria-label="Cluster legend">
              {clusters.slice(0, CLUSTER_LEGEND_LIMIT).map(({ community, count }) => (
                <li key={community}>
                  <span className="os-swatch" aria-hidden="true" style={{ background: `var(--os-cluster-${(community % CLUSTER_PALETTE_SIZE) + 1})` }} />
                  Cluster {community + 1} · {fmtInt(count)}
                </li>
              ))}
              {clusters.length > CLUSTER_LEGEND_LIMIT ? <li>and {fmtInt(clusters.length - CLUSTER_LEGEND_LIMIT)} more</li> : null}
              <li>
                <span className="os-swatch os-swatch-ring" aria-hidden="true" />
                Recent activity
              </li>
            </ul>
          ) : inCode ? (
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
          ) : vizGraph ? (
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
          ) : null
        ) : null}
        <div className="os-bottom-row">
          <button type="button" className="chip os-chip-toggle" aria-expanded={legendOpen} onClick={() => setLegendOpen((open) => !open)}>
            Legend {legendOpen ? '▴' : '▾'}
          </button>
          {caption ? <span className="meta os-caption">{caption}</span> : null}
          {view.level === 'os' ? (
            <button
              type="button"
              className="chip os-chip-toggle"
              aria-pressed={state.osPanel === 'activity'}
              onClick={() => controller.toggleActivity()}
            >
              Activity · {fmtInt(activity.length)}
            </button>
          ) : null}
        </div>
      </div>

      {drawer !== null && !drawerOpen ? (
        <button type="button" className="os-drawer-tab" aria-label={`Show details for ${drawerTitle || 'the selection'}`} onClick={showDrawer}>
          Details
        </button>
      ) : null}

      {drawer !== null && drawerOpen ? (
        <aside className="os-drawer" aria-label="Details">
          {drawer.kind === 'selection' && state.selected ? (
            <Selection
              selected={state.selected}
              activity={activity}
              viz={vizGraph}
              running={running}
              stopping={state.stopping}
              core={graph.core}
              project={state.projectGraph}
              preview={state.filePreview}
              onDrill={drill}
              onOpen={(target) => controller.open(target)}
              onStop={(cancel, key) => void controller.stopItem(cancel, key)}
              onPreview={loadPreview}
              onOpenFile={openFileInApp}
              onCopy={copyTextFor}
              onFocusCore={(item) => controller.openCodeNode(item)}
              onExploreCluster={(top) => {
                triggerRef.current = null;
                if (top) controller.openCodeNode({ id: top.id, label: top.label ?? top.id, detail: top.category });
                else drill('code');
              }}
              onHide={hideDrawer}
              onClose={closeSelection}
            />
          ) : (
            <>
              <div className="os-drawer-head">
                <h2 className="os-drawer-title">{drawerTitle}</h2>
                <div className="os-drawer-buttons">
                  {drawer.kind === 'hub' && view.level === 'os' && isHubKey(drawer.hub) ? (
                    <button type="button" className="btn btn-primary" onClick={() => drill(drawer.hub as HubKey)}>
                      Explore
                    </button>
                  ) : null}
                  {state.selected ? (
                    <button type="button" className="btn os-close" onClick={closeSelection}>
                      Close
                    </button>
                  ) : null}
                  <button type="button" className="btn os-close" onClick={hideDrawer}>
                    Hide
                  </button>
                </div>
              </div>
              <div className="os-drawer-body">
                {drawer.kind === 'hub' && data ? (
                  <HubOverview hub={drawer.hub} data={data} state={state} controller={controller} core={core} selected={state.selected} />
                ) : drawer.kind === 'activity' ? (
                  <ActivityOverview items={activity} controller={controller} selected={state.selected} />
                ) : null}
              </div>
            </>
          )}
        </aside>
      ) : null}
    </section>
  );
}
