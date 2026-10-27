// Test-only helper, loaded through Vite's SSR loader (see test/web.test.mjs).
import { renderToString } from 'react-dom/server';
import { App } from '../../src/App';
import { Brain } from '../../src/components/Brain';
import { Recent } from '../../src/components/Recent';
import { CodePreview, Selection } from '../../src/components/Selection';
import { CodeStructure } from '../../src/components/CodeStructure';
import { EMPTY_CORE_VIEW, EMPTY_RING_VIEW, type CoreView } from '../../src/systemGraph';
import type { FilePreview, OsController, OsSelection } from '../../src/controller';
import type { CGData } from '../../../typescript/src/models';
import type { SystemCoreNode } from '../../../typescript/src/system/types';
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

/** React's server renderer puts `<!-- -->` between adjacent text nodes; the tests read the text. */
function plain(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

/** The code node's details card (or any selection), with the drawn code nodes and the project's graph. */
export function renderCodeSelection(
  selected: OsSelection,
  opts: {
    core?: readonly SystemCoreNode[] | null;
    project?: CGData | null;
    preview?: FilePreview | null;
    viz?: VizGraph | null;
  } = {},
): string {
  return plain(renderToString(
    <Selection
      selected={selected}
      activity={[]}
      viz={opts.viz ?? null}
      core={opts.core ?? null}
      project={opts.project ?? null}
      preview={opts.preview ?? null}
      onClose={() => {}}
      onPreview={() => {}}
      onOpenFile={() => {}}
      onFocusCore={() => {}}
      onExploreCluster={() => {}}
    />,
  ));
}

/** The preview body alone, for each preview state. */
export function renderPreview(preview: FilePreview | null): string {
  return plain(renderToString(<CodePreview preview={preview} />));
}

/** The file structure tab alone, over the given core nodes. */
export function renderStructure(nodes: readonly SystemCoreNode[], selectedId: string | null = null): string {
  return plain(renderToString(<CodeStructure nodes={nodes} selectedId={selectedId} onSelect={() => {}} />));
}

/** The brain drawing the project's code level (the controller must be on the code hub). */
export function renderCodeBrain(controller: OsController, core: CoreView): string {
  return plain(renderToString(
    <Brain
      state={controller.getSnapshot()}
      controller={controller}
      core={core}
      ring={EMPTY_RING_VIEW}
      drawFailed={false}
      coreLoading={false}
      activity={[]}
    />,
  ));
}
