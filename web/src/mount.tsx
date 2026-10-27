import { createRoot } from 'react-dom/client';
import { App } from './App';
import { OsController } from './controller';
import type { OsHost } from './host';
import { applyTheme } from './theme';
import './theme.css';
import './styles.css';

export type MountOptions = {
  /** Initial theme id (dark, light, midnight). Unknown values fall back to dark. */
  theme?: string;
  projectName?: string | null;
  /** Notice shown when the host cannot open a screen. */
  openFallbackNotice?: string;
  /** Notice shown when the host refuses the session. */
  signedOutNotice?: string;
  /** The document whose <html> carries data-theme. Defaults to the global document. */
  doc?: Document;
};

export type OsViewHandle = {
  configure(cfg: { theme?: string; projectName?: string | null }): void;
  /** For hosts that push changes: re-fetch once the burst settles. */
  notifyChange(): void;
  /** After the host refreshed its session: clears the sign-out and resumes the feed and data. */
  retry(): void;
  dispose(): void;
  controller: OsController;
};

/** Renders the System view into `root`, backed by `host`, and starts its change feed. */
export function mountOsView(root: HTMLElement, host: OsHost, opts: MountOptions = {}): OsViewHandle {
  const doc = opts.doc ?? document;
  const controller = new OsController(
    {
      host,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      applyTheme: (theme) => {
        applyTheme(theme, doc.documentElement);
      },
      openFallbackNotice: opts.openFallbackNotice,
      signedOutNotice: opts.signedOutNotice,
    },
    { projectName: opts.projectName ?? null },
  );
  applyTheme(opts.theme, doc.documentElement);

  const reactRoot = createRoot(root);
  reactRoot.render(<App controller={controller} />);
  controller.start();

  return {
    configure: (cfg) => controller.configure(cfg),
    notifyChange: () => controller.notifyChange(),
    retry: () => controller.retry(),
    dispose: () => {
      controller.dispose();
      reactRoot.unmount();
    },
    controller,
  };
}
