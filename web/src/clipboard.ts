// Copying text from the page. The host's own copy is tried first (a native app can copy where the
// page cannot), then the async clipboard API, then a hidden textarea with execCommand('copy'): the
// async API is missing or refused in some embedded views (a file:// page in WKWebView, for one).
import type { OsHost } from './host';

/** The parts of the browser the copy reads. Injected by the tests; the page uses the globals. */
export interface ClipboardEnv {
  clipboard?: { writeText(text: string): Promise<void> } | null;
  document?: {
    createElement(tag: 'textarea'): HTMLTextAreaElement;
    body: { appendChild(node: Node): Node; removeChild(node: Node): Node };
    execCommand(command: string): boolean;
  } | null;
}

function browserEnv(): ClipboardEnv {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return {
    clipboard: nav?.clipboard ?? null,
    document: typeof document === 'undefined' ? null : document,
  };
}

/** Copies `text`. True when one of the routes copied it; false when all of them refused or were missing. */
export async function copyToClipboard(
  text: string,
  host?: Pick<OsHost, 'copyText'> | null,
  env: ClipboardEnv = browserEnv(),
): Promise<boolean> {
  if (typeof host?.copyText === 'function') {
    try {
      if (host.copyText(text) === true) return true;
    } catch {
      // The host refused or failed: the page's own routes are tried next.
    }
  }
  if (env.clipboard && typeof env.clipboard.writeText === 'function') {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable here: the textarea route below.
    }
  }
  const doc = env.document;
  if (!doc || typeof doc.createElement !== 'function') return false;
  try {
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.left = '-9999px';
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand('copy');
    doc.body.removeChild(area);
    return ok === true;
  } catch {
    return false;
  }
}
