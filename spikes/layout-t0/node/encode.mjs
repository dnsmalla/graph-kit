// Graph JSON (from T0Bench fixtures) -> the binary input contract of rust/src/lib.rs.
// Edge kinds are interned into a small table; confidence is one byte.
const CONF = { EXTRACTED: 0, INFERRED: 1, AMBIGUOUS: 2 };

export function encodeGraph(graph) {
  const kinds = [];
  const kindIndex = new Map();
  for (const e of graph.edges) {
    if (!kindIndex.has(e.k)) { kindIndex.set(e.k, kinds.length); kinds.push(e.k); }
  }
  if (kinds.length > 255) throw new Error('too many kinds');
  const kindBytes = kinds.map((k) => Buffer.from(k, 'utf8'));
  const header = 4 + 4 + 1 + kindBytes.reduce((s, b) => s + 1 + b.length, 0);
  const buf = Buffer.alloc(header + graph.edges.length * 10);
  let at = 0;
  buf.writeUInt32LE(graph.n, at); at += 4;
  buf.writeUInt32LE(graph.edges.length, at); at += 4;
  buf.writeUInt8(kinds.length, at); at += 1;
  for (const b of kindBytes) { buf.writeUInt8(b.length, at); at += 1; b.copy(buf, at); at += b.length; }
  for (const e of graph.edges) {
    buf.writeUInt32LE(e.f, at); buf.writeUInt32LE(e.t, at + 4);
    buf.writeUInt8(kindIndex.get(e.k), at + 8); buf.writeUInt8(CONF[e.c], at + 9);
    at += 10;
  }
  return buf;
}

// Decode the output contract of rust/src/lib.rs.
export function decodeOutput(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const n = dv.getUint32(0, true), links = dv.getUint32(4, true), communities = dv.getUint32(8, true);
  const pos = new Float64Array(2 * n), radius = new Float64Array(n), community = new Uint32Array(n);
  const degree = new Uint32Array(n), inDegree = new Uint32Array(n);
  let at = 12;
  for (let i = 0; i < n; i++) {
    pos[2 * i] = dv.getFloat64(at, true);
    pos[2 * i + 1] = dv.getFloat64(at + 8, true);
    radius[i] = dv.getFloat64(at + 16, true);
    community[i] = dv.getUint32(at + 24, true);
    degree[i] = dv.getUint32(at + 28, true);
    inDegree[i] = dv.getUint32(at + 32, true);
    at += 36;
  }
  const linkWeights = new Float64Array(links);
  for (let i = 0; i < links; i++) linkWeights[i] = dv.getFloat64(at + 8 * i, true);
  return { n, links, communities, pos, radius, community, degree, inDegree, linkWeights };
}
