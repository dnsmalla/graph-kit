import { useSyncExternalStore } from 'react';
import type { OsController, ViewState } from './controller';
import type { OsRange } from './host';
import type { OsLiveStatus } from './types';
import { fmtTime } from './format';
import { Activity } from './components/Activity';
import { Knowledge } from './components/Knowledge';
import { OnThisMac } from './components/OnThisMac';
import { RunningNow } from './components/RunningNow';
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

      {!data ? <p className="empty">Loading the System view…</p> : null}

      {data ? (
        <div className="os-grid">
          <SystemMap system={data.system} controller={controller} />
          <RunningNow
            running={data.running}
            stopping={state.stopping}
            onStop={(cancel, key) => void controller.stopItem(cancel, key)}
          />
          <Activity activity={data.activity} />
          <TokenFlow tokens={data.tokens} />
          <Knowledge knowledge={data.knowledge} controller={controller} />
          <OnThisMac controller={controller} />
        </div>
      ) : null}
    </div>
  );
}
