// The wire types the System view renders. They live in graph-kit's core
// (typescript/src/system/types.ts, structural copies of the host's server
// contract) and are re-exported here so the page imports one place.
export type {
  OsActivityItem,
  OsCancel,
  OsKitStatus,
  OsLiveStatus,
  OsRoutine,
  OsSkill,
  OsSnapshot,
  OsUsageCounts,
} from '../../typescript/src/system/types.js';
