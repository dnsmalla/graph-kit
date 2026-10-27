import type { OsController, OsSelection } from '../controller';
import type { OsActivityItem } from '../types';
import { fmtTime, words } from '../format';
import { Empty } from './common';

/** Recent rows shown while the brain draws (WebGL available). Without WebGL the list shows the whole ring. */
export const RECENT_LIMIT = 5;

/** The ring id of an activity row (ring ids are `activity:<id>`). */
export function ringIdFor(item: OsActivityItem): string {
  return `activity:${item.id}`;
}

/**
 * The latest activity as a plain list under the brain, so it reads without WebGL.
 * Each row selects its ring item; the row for the current selection is aria-pressed.
 * `limit` is how many rows to show; `onPick` gets the clicked row before the selection changes.
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
    <section className="os-recent" aria-labelledby="sec-recent">
      <h3 id="sec-recent" className="sub-title">
        Recent
      </h3>
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
                  onClick={(event) => {
                    onPick?.(event.currentTarget);
                    controller.select({ type: 'ring', id, label: item.title, detail: item.kind });
                  }}
                >
                  <time dateTime={item.createdAt}>{fmtTime(item.createdAt)}</time>
                  <span className="tag">{words(item.kind)}</span>
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
