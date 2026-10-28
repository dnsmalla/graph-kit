import type { OsController, OsSelection } from '../controller';
import type { OsActivityItem } from '../types';
import { fmtRelative, fmtTime, words } from '../format';
import { Empty } from './common';

/** Rows the activity timeline shows by default (the ring draws the same items, up to its own cap). */
export const RECENT_LIMIT = 12;

/** The ring id of an activity row (ring ids are `activity:<id>`). */
export function ringIdFor(item: OsActivityItem): string {
  return `activity:${item.id}`;
}

/**
 * The latest activity as a timeline: kind chip, title and how long ago. Each row selects its ring
 * item; the row for the current selection is aria-pressed. Works without WebGL. `limit` is how
 * many rows to show; `onPick` gets the clicked row before the selection changes.
 */
export function Recent({
  items,
  controller,
  selected,
  limit = RECENT_LIMIT,
  onPick,
}: {
  items: OsActivityItem[];
  controller: OsController;
  selected: OsSelection | null;
  limit?: number;
  onPick?: (row: HTMLButtonElement) => void;
}) {
  const latest = items.slice(0, limit);
  return (
    <section className="os-recent" aria-label="Recent activity">
      {latest.length === 0 ? (
        <Empty>No activity yet. Chat turns, ingests and meetings show up here as they happen.</Empty>
      ) : (
        <ul className="os-recent-list">
          {latest.map((item) => {
            const id = ringIdFor(item);
            const pressed = selected !== null && selected.type === 'ring' && selected.id === id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="os-recent-item"
                  aria-pressed={pressed}
                  title={fmtTime(item.createdAt)}
                  onClick={(event) => {
                    onPick?.(event.currentTarget);
                    controller.select({ type: 'ring', id, label: item.title, detail: item.kind });
                  }}
                >
                  <span className="os-recent-top">
                    <span className="tag">{words(item.kind)}</span>
                    <time dateTime={item.createdAt} className="meta">
                      {fmtRelative(item.createdAt)}
                    </time>
                  </span>
                  <span className="os-recent-title">{item.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
