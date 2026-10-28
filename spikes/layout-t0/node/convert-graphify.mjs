// Converts a graphify-format graph (node-link JSON: `nodes`, `links` with `relation`)
// into the T0 fixture format read by T0Bench (`loadFixture`) and by t0.mjs.
// Usage: node convert-graphify.mjs <graph.json> <outDir> <name>
// Relation mapping (graphify -> CGEdgeKind): contains, inherits, calls are identical;
// method -> defines (a type's member); case_of -> references (a peer link).
// Any other relation fails loudly, so the mapping cannot drift silently.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [src, outDir, name] = process.argv.slice(2);
const MAP = { contains: 'contains', inherits: 'inherits', method: 'defines', calls: 'calls', case_of: 'references' };
const g = JSON.parse(await readFile(src, 'utf8'));
const ids = g.nodes.map((n) => String(n.id));
const index = new Map(ids.map((id, i) => [id, i]));
const edges = g.links.map((l) => {
  const k = MAP[l.relation];
  if (!k) throw new Error(`unmapped relation: ${l.relation}`);
  return { f: index.get(String(l.source)), t: index.get(String(l.target)), k,
    c: l.confidence === 'INFERRED' ? 'INFERRED' : 'EXTRACTED' };
});
await writeFile(path.join(outDir, `${name}.graph.json`), JSON.stringify({ name, n: ids.length, ids, edges }));
console.log(`n=${ids.length} m=${edges.length}`);
