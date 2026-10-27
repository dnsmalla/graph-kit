// Test-only helper, loaded through Vite's SSR loader (see test/web.test.mjs).
import { renderToString } from 'react-dom/server';
import { App } from '../../src/App';
import { Recent } from '../../src/components/Recent';
import type { OsController, OsSelection } from '../../src/controller';
import type { OsActivityItem } from '../../src/types';

export function renderApp(controller: OsController): string {
  return renderToString(<App controller={controller} />);
}

/** The recent list alone, for checking how many rows a limit shows. */
export function renderRecent(
  items: OsActivityItem[],
  controller: OsController,
  selected: OsSelection | null = null,
  limit?: number,
): string {
  return renderToString(<Recent items={items} controller={controller} selected={selected} limit={limit} />);
}
