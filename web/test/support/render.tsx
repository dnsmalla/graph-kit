// Test-only helper, loaded through Vite's SSR loader (see test/web.test.mjs).
import { renderToString } from 'react-dom/server';
import { App } from '../../src/App';
import type { OsController } from '../../src/controller';

export function renderApp(controller: OsController): string {
  return renderToString(<App controller={controller} />);
}
