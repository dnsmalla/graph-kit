const integer = new Intl.NumberFormat('en-US');

export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return integer.format(Math.round(value));
}

/** Share of a whole as a whole percentage, 0 when the whole is empty. */
export function pct(part: number, whole: number): number {
  if (!(whole > 0) || !Number.isFinite(part)) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/**
 * A server timestamp as local time. The server writes SQLite times without a
 * zone ("2026-10-26 13:56:08", UTC); ISO strings already carry one.
 */
export function fmtTime(value: string | null | undefined): string {
  if (!value) return '—';
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const ms = Date.parse(hasZone ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A kind such as "knowledge_updated" as words. */
export function words(value: string): string {
  return value.replace(/[_-]+/g, ' ');
}

/** The short form of a commit SHA. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}

const relative = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

/** A server timestamp as parsed milliseconds, or NaN. Handles the SQLite form (UTC, no zone) too. */
function parseServerTime(value: string): number {
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  return Date.parse(hasZone ? value : `${value.replace(' ', 'T')}Z`);
}

/** How long ago (or until) a server timestamp is, as words: "3 minutes ago", "in 2 hours". */
export function fmtRelative(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return '—';
  const ms = parseServerTime(value);
  if (Number.isNaN(ms)) return value;
  const seconds = Math.round((ms - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3300) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 79200) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 5 * 86400) return relative.format(Math.round(seconds / 86400), 'day');
  return fmtTime(value);
}

/** Whether a string is a server timestamp (ISO 8601 or the SQLite form). */
export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value);
}

/** A camelCase or snake_case key as a sentence start: "lastRunAt" becomes "Last run at". */
export function humanKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One row of a meta table: a formatted value, plus the key: value lines of a nested object. */
export type MetaRow = { key: string; value: string; lines?: MetaRow[] };

/** A scalar meta value as text. Numbers get separators, timestamps read as time and how long ago. */
function scalar(key: string, value: unknown, now: number): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (/share$/i.test(key) && value >= 0 && value <= 1) return `${pct(value, 1)}%`;
    return fmtInt(value);
  }
  if (isTimestamp(value)) return `${fmtTime(value)} · ${fmtRelative(value, now)}`;
  return String(value);
}

/**
 * The rows of a details card's meta table. Scalars read as text, arrays as counts ("3 items"),
 * nested objects as a row with key: value lines beneath it. Null-ish values read as an em dash.
 */
export function metaRows(meta: Record<string, unknown>, now: number = Date.now()): MetaRow[] {
  return Object.entries(meta).map(([key, value]) => {
    const label = humanKey(key);
    if (Array.isArray(value)) {
      return { key: label, value: value.length === 0 ? 'none' : `${fmtInt(value.length)} ${value.length === 1 ? 'item' : 'items'}` };
    }
    if (value !== null && typeof value === 'object') {
      const lines = Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
        key: humanKey(k),
        value: scalar(k, v, now),
      }));
      return { key: label, value: lines.length === 0 ? 'none' : '', lines };
    }
    return { key: label, value: scalar(key, value, now) };
  });
}

/** A size in bytes as words: "512 B", "12.5 KiB", "3.2 MiB". */
export function fmtBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${fmtInt(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

/** A server timestamp's clock time, hh:mm (local). Used for "Updated hh:mm" in the top bar. */
export function fmtClock(value: string | null | undefined): string {
  if (!value) return '—';
  const ms = parseServerTime(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** A duration in milliseconds as seconds or minutes: "850 ms", "12 s", "2 min 30 s". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${fmtInt(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}
