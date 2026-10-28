import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { OsController, ViewState } from './controller';
import type { OsRange } from './host';
import type { OsLiveStatus } from './types';
import { fmtClock } from './format';
import { drawOs, drawViews, osGraphStatus, vizForLevel, whenOsGraphReady, type OsGraphStatus, type VizView } from './systemGraph';
import { Brain } from './components/Brain';

const LIVE_LABEL: Record<OsLiveStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  stopped: 'Paused',
};

const RANGES: Array<{ id: OsRange; label: string }> = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
];

/** The core's status, re-read once the core has settled (ready or failed). */
function useOsGraphStatus(): OsGraphStatus {
  const [status, setStatus] = useState<OsGraphStatus>(osGraphStatus);
  useEffect(() => {
    let live = true;
    void whenOsGraphReady().then(() => {
      if (live) setStatus(osGraphStatus());
    });
    return () => {
      live = false;
    };
  }, []);
  return status;
}

/**
 * The slim top bar: title, project, Day|Week, live status, the update time, and two chips: the
 * server health (opens Kits) and the running count (opens Agents, hidden at zero).
 */
function TopBar({ state, controller }: { state: ViewState; controller: OsController }) {
  const data = state.data;
  const running = data ? data.running.chatTurns.length + data.running.meetingAgentRuns.length + data.running.liveSessions.length : 0;
  const healthy = data?.system.status === 'ok';
  return (
    <header className="os-top">
      <div className="os-top-title">
        <h1>System</h1>
        <p className="meta os-top-project">{state.projectName ?? 'No project open'}</p>
      </div>
      <div className="os-top-controls">
        <div className="seg" role="group" aria-label="Time window">
          {RANGES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={state.range === id}
              className={state.range === id ? 'seg-btn seg-on' : 'seg-btn'}
              onClick={() => controller.setRange(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className={`live live-${state.live}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {LIVE_LABEL[state.live]}
          {state.notice ? <span className="meta"> · {state.notice}</span> : null}
        </p>
        {data ? <p className="meta os-top-updated">Updated {fmtClock(data.generatedAt)}</p> : null}
      </div>
      <div className="os-top-chips">
        {data ? (
          <button type="button" className={healthy ? 'chip os-health os-health-ok' : 'chip os-health os-health-bad'} onClick={() => controller.drill('kits')}>
            <span className="dot" aria-hidden="true" />
            {healthy ? 'Healthy' : 'Degraded'}
          </button>
        ) : null}
        {running > 0 ? (
          <button type="button" className="chip os-running-chip" onClick={() => controller.drill('agents')}>
            {running} running
          </button>
        ) : null}
      </div>
    </header>
  );
}

export function App({ controller }: { controller: OsController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const data = state.data;
  // The core's status is a dependency: drawViews reads it, and it changes once when the core is ready.
  const graphStatus = useOsGraphStatus();
  const drawn = useMemo(() => drawViews(state.projectGraph, data), [state.projectGraph, data, graphStatus]);
  // The code brain shows the project's graph only: the OS view is not built while it is showing.
  const inCode = state.view.level === 'hub' && state.view.hub === 'code';
  const osDrawn = useMemo(
    () => drawOs(data, state.skills, state.routines, drawn.core, { loading: drawn.loading, skip: inCode }),
    [data, state.skills, state.routines, drawn.core, drawn.loading, inCode],
  );
  // A refresh can remove the part the brain is on, or a node that is selected: the controller reconciles.
  useEffect(() => {
    if (osDrawn.view) controller.reconcile(osDrawn.view);
  }, [controller, osDrawn.view]);
  const level = state.view.level === 'os' ? 'os' : state.view.hub;
  const vizDrawn = useMemo((): { viz: VizView | null; failed: boolean } => {
    if (!osDrawn.view || level === 'code') return { viz: null, failed: false };
    try {
      return { viz: vizForLevel(osDrawn.view, level), failed: false };
    } catch {
      return { viz: null, failed: true };
    }
  }, [osDrawn.view, level]);

  return (
    <div className="os">
      <TopBar state={state} controller={controller} />
      <div className="os-stage">
        {state.signedOut ? (
          <p className="banner banner-warn os-stage-banner" role="status">
            {controller.signedOutNotice}
          </p>
        ) : null}
        {state.error ? (
          <p className="banner banner-error os-stage-banner" role="alert">
            {state.error}
          </p>
        ) : null}
        {!data ? <p className="empty os-stage-empty">Loading the System view…</p> : null}
        {data ? (
          <Brain
            state={state}
            controller={controller}
            core={drawn.core}
            ring={drawn.ring}
            drawFailed={drawn.drawFailed}
            coreLoading={drawn.loading}
            activity={data.activity.items}
            data={data}
            viz={vizDrawn.viz}
            osFailed={osDrawn.failed || vizDrawn.failed}
            osLoading={osDrawn.loading}
            running={data.running}
          />
        ) : null}
      </div>
    </div>
  );
}

