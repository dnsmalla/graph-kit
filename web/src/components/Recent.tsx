import type { OsController } from '../controller';
import type { OsActivityItem } from '../types';
import { fmtTime, words } from '../format';
import { Empty } from './common';

export const RECENT_LIMIT = 5;

/** The latest activity as a plain list under the brain, so it reads without WebGL. Each row selects its ring item. */
export function Recent({ items, controller }: { items: OsActivityItem[]; controller: OsController }) {
  const latest = items.slice(0, RECENT_LIMIT);
  return (
    <section className="os-recent" aria-labelledby="sec-recent">
      <h3 id="sec-recent" className="sub-title">
        Recent
      </h3>
      {latest.length === 0 ? (
        <Empty>No activity yet. Chat turns, ingests and meetings show up here as they happen.</Empty>
      ) : (
        <ul className="os-recent-list">
          {latest.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="os-recent-item"
                onClick={() => controller.select({ type: 'ring', id: `activity:${item.id}`, label: item.title, detail: item.kind })}
              >
                <time dateTime={item.createdAt}>{fmtTime(item.createdAt)}</time>
                <span className="tag">{words(item.kind)}</span>
                <span className="os-recent-title">{item.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
