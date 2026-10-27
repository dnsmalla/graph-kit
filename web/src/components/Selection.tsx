import type { OsSelection } from '../controller';
import type { OsActivityItem } from '../types';
import { fmtTime, words } from '../format';

/** The activity row a ring item stands for (ring ids are `activity:<id>`), or null. */
export function findActivity(selected: OsSelection, activity: OsActivityItem[]): OsActivityItem | null {
  if (selected.type !== 'ring' || !selected.id.startsWith('activity:')) return null;
  const id = selected.id.slice('activity:'.length);
  return activity.find((item) => String(item.id) === id) ?? null;
}

/** Details of the picked brain or ring item. Overlaid on the brain; closes with the button. */
export function Selection({
  selected,
  activity,
  onClose,
}: {
  selected: OsSelection;
  activity: OsActivityItem[];
  onClose: () => void;
}) {
  const match = findActivity(selected, activity);
  return (
    <section className="os-selection" aria-labelledby="os-selection-title">
      <div className="os-selection-head">
        <span className="meta">{selected.type === 'core' ? 'Project node' : 'Recent activity'}</span>
        <button type="button" className="btn os-close" onClick={onClose}>
          Close
        </button>
      </div>
      <h3 id="os-selection-title" className="sub-title os-selection-title">
        {selected.label}
      </h3>
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
