import { useSyncExternalStore } from 'react';
import type { OsController, ViewState } from './controller';
import type { OsRange } from './host';
import type { OsLiveStatus } from './types';
import { fmtTime } from './format';
import { computeSystemView, SYSTEM_VIEW_LIMITS } from './systemGraph';
import { Brain } from './components/Brain';
import { Knowledge } from './components/Knowledge';
import { Routines } from './components/Routines';
import { RunningNow } from './components/RunningNow';
import { SkillsDeck } from './components/SkillsDeck';
import { SystemMap } from './components/SystemMap';
import { TokenFlow } from './components/TokenFlow';

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

function Header({ state, controller }: { state: ViewState; controller: OsController }) {
  return (
    <header className="os-head">
      <div>
        <h1>System</h1>
        <p className="meta">{state.projectName ?? 'No project open'}</p>
      </div>
      <div className="os-head-controls">
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
      </div>
      {state.data ? <p className="meta os-head-foot">Updated {fmtTime(state.data.generatedAt)}</p> : null}
    </header>
  );
}

export function App({ controller }: { controller: OsController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const data = state.data;
  // Memoised inside computeSystemView, so re-renders with the same inputs reuse the view.
  const view = data ? computeSystemView(data, state.projectGraph, SYSTEM_VIEW_LIMITS) : null;

  return (
    <div className="os">
      <Header state={state} controller={controller} />

      {state.signedOut ? (
        <p className="banner banner-warn" role="status">
          {controller.signedOutNotice}
        </p>
      ) : null}
      {state.error ? (
        <p className="banner banner-error" role="alert">
          {state.error}
        </p>
      ) : null}

      {!data || !view ? <p className="empty">Loading the System view…</p> : null}

      {data && view ? (
        <div className="os-stage">
          <div className="os-col os-col-left">
            <SystemMap system={data.system} controller={controller} />
            <RunningNow
              running={data.running}
              stopping={state.stopping}
              onStop={(cancel, key) => void controller.stopItem(cancel, key)}
            />
            <SkillsDeck skills={state.skills} status={state.skillsStatus} />
          </div>

          <Brain state={state} controller={controller} view={view} activity={data.activity.items} />

          <div className="os-col os-col-right">
            <TokenFlow tokens={data.tokens} />
            <Knowledge knowledge={data.knowledge} controller={controller} />
            <Routines routines={state.routines} status={state.routinesStatus} controller={controller} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
