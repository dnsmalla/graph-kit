// Test-only helper, loaded through Vite's SSR loader (see test/web.test.mjs).
import { renderToString } from 'react-dom/server';
import { App } from '../../src/App';
import { Brain } from '../../src/components/Brain';
import { Recent } from '../../src/components/Recent';
import { Selection } from '../../src/components/Selection';
import { EMPTY_CORE_VIEW, EMPTY_RING_VIEW } from '../../src/systemGraph';
import type { OsController, OsSelection } from '../../src/controller';
import type { OsActivityItem, OsSnapshot } from '../../src/types';
import type { VizGraph } from '../../src/viz';

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

/** The brain alone, with its draw state set by the caller. */
export function renderBrain(
  controller: OsController,
  draw: { drawFailed?: boolean; coreLoading?: boolean } = {},
): string {
  return renderToString(
    <Brain
      state={controller.getSnapshot()}
      controller={controller}
      core={EMPTY_CORE_VIEW}
      ring={EMPTY_RING_VIEW}
      drawFailed={draw.drawFailed ?? false}
      coreLoading={draw.coreLoading ?? false}
      activity={[]}
    />,
  );
}

/** The details card of a selection, with the snapshot's running items and the graph it is looked up in. */
export function renderSelection(
  selected: OsSelection,
  opts: {
    viz?: VizGraph | null;
    running?: OsSnapshot['running'] | null;
    stopping?: string | null;
  } = {},
): string {
  return renderToString(
    <Selection
      selected={selected}
      activity={[]}
      viz={opts.viz ?? null}
      running={opts.running ?? null}
      stopping={opts.stopping ?? null}
      onClose={() => {}}
      onDrill={() => {}}
      onOpen={() => {}}
      onStop={() => {}}
    />,
  );
}
