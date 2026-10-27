import type { ExtraStatus, OsController } from '../controller';
import type { OsRoutine } from '../types';
import { fmtTime } from '../format';
import { Card, Empty } from './common';

/** Scheduled routines, with the two buttons that open Loop and Auto Tasks on this Mac. */
export function Routines({
  routines,
  status,
  controller,
}: {
  routines: OsRoutine[] | null;
  status: ExtraStatus;
  controller: OsController;
}) {
  const actions = (
    <>
      <button type="button" className="btn" onClick={() => controller.open('loop')}>
        Open Loop
      </button>
      <button type="button" className="btn" onClick={() => controller.open('autoTasks')}>
        Open Auto Tasks
      </button>
    </>
  );
  return (
    <Card id="sec-routines" title="Routines" actions={actions}>
      <p className="meta">Loop and Auto Tasks run on this Mac. Their routines are listed here when the host reports them.</p>
      {routines !== null && routines.length > 0 ? (
        <ul className="routine-list">
          {routines.map((routine) => (
            <li key={routine.id} className="routine">
              <span className={routine.enabled ? 'dot dot-ok' : 'dot'} aria-hidden="true" />
              <div className="row-main">
                <strong>{routine.title}</strong>
                <div className="meta">
                  {routine.enabled ? 'Enabled' : 'Paused'} · {routine.schedule ? routine.schedule : 'No schedule'}
                </div>
                <div className="meta">
                  Next {routine.nextRunAt ? fmtTime(routine.nextRunAt) : '—'} · last {routine.lastRunAt ? fmtTime(routine.lastRunAt) : '—'}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : status === 'error' ? (
        <Empty>Could not load routines.</Empty>
      ) : status === 'none' ? (
        <Empty>Routines are not available in this host.</Empty>
      ) : status === 'ready' ? (
        <Empty>No routines yet.</Empty>
      ) : (
        <p className="meta">Loading routines…</p>
      )}
    </Card>
  );
}
