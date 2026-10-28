// The Storage hub's state machines, as pure functions: the Clear flow (dry-run preview, explicit
// confirm, real clear), the Compact flow and the retention rule. The controller drives them and
// the overview renders them; nothing here touches the host, so every path is testable on its own.
import type { OsClearCounts, OsClearResult } from './types';

const COUNT_KEYS = ['agent_runs', 'agent_tool_events', 'turn_composition', 'agent_daily', 'agent_daily_tools'] as const;

/** Whether a value is a full set of clear counts (every table, each a finite number). */
export function isCountSet(value: unknown): value is OsClearCounts {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return COUNT_KEYS.every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
}

/** Whether a host answer is a usable dry run: the counts, a non-empty previewId and a total. */
export function isDryRunResult(value: unknown): value is DryRunClear {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.dryRun === true &&
    isCountSet(v.wouldDelete) &&
    typeof v.previewId === 'string' &&
    v.previewId.length > 0 &&
    typeof v.total === 'number' &&
    Number.isFinite(v.total)
  );
}

/** Whether a host answer is a real clear: the deleted counts and a total. */
export function isRealClearResult(value: unknown): value is Extract<OsClearResult, { dryRun: false }> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.dryRun === false && isCountSet(v.deleted) && typeof v.total === 'number' && Number.isFinite(v.total);
}

/**
 * Codes for an answer the page cannot trust: the request timed out or the reply did not parse. The
 * operation may have completed on the server, so the page re-reads the storage figures before it says so.
 */
export const UNCERTAIN_CODES: readonly string[] = ['timeout', 'bad_reply'];

export function isUncertainCode(code: string): boolean {
  return UNCERTAIN_CODES.includes(code);
}

export const UNCERTAIN_MESSAGE =
  'The request timed out or the reply could not be read, so the operation may have completed. The figures were refreshed; check them before trying again.';

export const UNEXPECTED_PREVIEW = 'The host sent an unexpected answer to the preview. Nothing was cleared.';
export const UNEXPECTED_CLEAR = 'The host sent an unexpected answer to the clear. The history may or may not have been cleared; check it before trying again.';

export type ClearScope = 'raw' | 'all';

/** The dry run a confirm shows: the counts a real clear would delete, and the previewId that binds the clear to them. */
export type DryRunClear = Extract<OsClearResult, { dryRun: true }>;

/** The Clear flow. Only `confirm` may lead to `clearing`; a real clear always needs a preview first. */
export type ClearFlow =
  | { kind: 'idle' }
  | { kind: 'previewing'; scope: ClearScope; beforeDays: number | null }
  | { kind: 'confirm'; scope: ClearScope; beforeDays: number | null; preview: DryRunClear; notice: string | null }
  | { kind: 'clearing'; scope: ClearScope; beforeDays: number | null; preview: DryRunClear }
  | { kind: 'cleared'; scope: ClearScope; beforeDays: number | null; deleted: OsClearCounts; total: number }
  | { kind: 'failed'; scope: ClearScope; beforeDays: number | null; message: string };

/** The Compact flow. */
export type CompactFlow =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; freedBytes: number; pagesFreed: number; mode: 'incremental' | 'full'; ms: number }
  | { kind: 'failed'; code: string; message: string };

/** The retention editor: 7 to 365 whole days (the server clamps the same range). */
export const RETENTION_MIN = 7;
export const RETENTION_MAX = 365;

/** Errors that mean the preview no longer stands: the page re-previews once, and never clears on its own. */
export const STALE_PREVIEW_CODES: readonly string[] = ['PREVIEW_EXPIRED', 'PREVIEW_INVALID', 'preview_stale'];

export function isStalePreview(code: string): boolean {
  return STALE_PREVIEW_CODES.includes(code);
}

/** Why a preview went stale, as the page tells the user before it shows the fresh preview. */
export const STALE_NOTICES: Record<string, string> = {
  PREVIEW_EXPIRED: 'The preview expired. Here is a fresh one: check the counts and confirm again.',
  PREVIEW_INVALID: 'The preview no longer matches this clear. Here is a fresh one: check the counts and confirm again.',
  preview_stale: 'The data changed since the preview. Here is a fresh one: check the counts and confirm again.',
};

/** The message for a clear failure that is not a stale preview. */
export function clearErrorMessage(code: string, message?: string): string {
  if (code === 'PREVIEW_REQUIRED') return 'The clear needs a preview first. Start again from the preview.';
  if (code === 'busy') return 'The store is busy. Try again in a moment.';
  if (code === 'store_down') return 'The agent store is not available right now, so nothing was cleared.';
  return message ? `Could not clear: ${message}` : 'Could not clear the agent history.';
}

/** The message for a compact failure. busy, disk_space and store_down are the typed cases. */
export function compactErrorMessage(code: string, message?: string): string {
  switch (code) {
    case 'busy':
      return 'Compact waits until no agent run is in progress. Try again when the runs finish.';
    case 'disk_space':
      return 'There is not enough free disk space to compact the store. Compact needs about twice the store size free.';
    case 'store_down':
      return 'The agent store is not available right now, so nothing was compacted.';
    default:
      return message ? `Could not compact: ${message}` : 'Could not compact the agent store.';
  }
}

/** Whether a retention value is a whole number of days in range. */
export function retentionError(days: unknown): string | null {
  if (typeof days !== 'number' || !Number.isInteger(days)) return 'Enter a whole number of days.';
  if (days < RETENTION_MIN || days > RETENTION_MAX) return `Enter ${RETENTION_MIN} to ${RETENTION_MAX} days.`;
  return null;
}

/** Sum of a count set. */
export function totalOf(counts: OsClearCounts): number {
  return counts.agent_runs + counts.agent_tool_events + counts.turn_composition + counts.agent_daily + counts.agent_daily_tools;
}

/** The rows of a count set for the preview table, in display order, with plain labels. */
export function countRows(counts: OsClearCounts): Array<{ key: keyof OsClearCounts; label: string; count: number }> {
  return [
    { key: 'agent_runs', label: 'Agent runs', count: counts.agent_runs },
    { key: 'agent_tool_events', label: 'Tool calls', count: counts.agent_tool_events },
    { key: 'turn_composition', label: 'Turn composition', count: counts.turn_composition },
    { key: 'agent_daily', label: 'Daily summaries', count: counts.agent_daily },
    { key: 'agent_daily_tools', label: 'Daily tool summaries', count: counts.agent_daily_tools },
  ];
}

export function previewing(scope: ClearScope, beforeDays: number | null): ClearFlow {
  return { kind: 'previewing', scope, beforeDays };
}

export function previewed(
  scope: ClearScope,
  beforeDays: number | null,
  preview: DryRunClear,
  notice: string | null = null,
): ClearFlow {
  return { kind: 'confirm', scope, beforeDays, preview, notice };
}

/** confirm to clearing. Any other state is returned unchanged: a clear is never started without a shown preview. */
export function confirming(flow: ClearFlow): ClearFlow {
  if (flow.kind !== 'confirm') return flow;
  return { kind: 'clearing', scope: flow.scope, beforeDays: flow.beforeDays, preview: flow.preview };
}

export function cleared(flow: ClearFlow, result: Extract<OsClearResult, { dryRun: false }>): ClearFlow {
  const scope = flow.kind === 'idle' ? result.scope : flow.scope;
  return { kind: 'cleared', scope, beforeDays: result.beforeDays, deleted: result.deleted, total: result.total };
}

export function failed(scope: ClearScope, beforeDays: number | null, message: string): ClearFlow {
  return { kind: 'failed', scope, beforeDays, message };
}

/** What a failed step does next: a stale preview re-previews (once), anything else fails with a message. */
export type ClearFailure = { action: 'repreview'; notice: string } | { action: 'fail'; message: string };

export function clearFailure(code: string, message?: string): ClearFailure {
  if (isStalePreview(code)) return { action: 'repreview', notice: STALE_NOTICES[code] ?? STALE_NOTICES.preview_stale! };
  return { action: 'fail', message: clearErrorMessage(code, message) };
}

export function compactStarted(): CompactFlow {
  return { kind: 'running' };
}

export function compactDone(result: { mode: 'incremental' | 'full'; pagesFreed: number; bytesBefore: number; bytesAfter: number; ms: number }): CompactFlow {
  return {
    kind: 'done',
    freedBytes: Math.max(0, result.bytesBefore - result.bytesAfter),
    pagesFreed: result.pagesFreed,
    mode: result.mode,
    ms: result.ms,
  };
}

export function compactFailed(code: string, message?: string): CompactFlow {
  return { kind: 'failed', code, message: compactErrorMessage(code, message) };
}
