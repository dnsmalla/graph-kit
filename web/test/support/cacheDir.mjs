// Each test file starts its own Vite dev server, and `node --test` runs the files in parallel.
// On a machine with no warm cache they all tried to build Vite's dependency cache in the same
// node_modules/.vite folder and raced on its rename (ENOTEMPTY ... deps_temp_*), which failed the
// setup hook and left the process hanging until the CI job timed out. A private cache directory
// per server removes the shared state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function uniqueCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'graph-kit-web-vite-'));
}
