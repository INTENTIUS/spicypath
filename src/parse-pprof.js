// pprof (profile.proto) DECOMPRESSED bytes → canonical model. Pure (browser + Node);
// the caller gunzips (DecompressionStream in browser, zlib in Node). Hand-rolled
// protobuf decode, no deps. Aggregated; Location.Line → inlineDepth; multi-value.
import { ProfileBuilder } from './model.js';

const td = new TextDecoder();

class Reader {
  constructor(buf, pos = 0, end) { this.buf = buf; this.pos = pos; this.end = end == null ? buf.length : end; }
  eof() { return this.pos >= this.end; }
  varint() { let shift = 0, res = 0; for (;;) { const b = this.buf[this.pos++]; res += (b & 0x7f) * Math.pow(2, shift); if ((b & 0x80) === 0) break; shift += 7; } return res; }
  tag() { const t = this.varint(); return { field: Math.floor(t / 8), wire: t & 7 }; }
  bytes() { const n = this.varint(); const s = this.pos; this.pos += n; return this.buf.subarray(s, s + n); }
  str() { return td.decode(this.bytes()); }
  sub() { const n = this.varint(); const r = new Reader(this.buf, this.pos, this.pos + n); this.pos += n; return r; }
  skip(wire) { if (wire === 0) this.varint(); else if (wire === 2) { const n = this.varint(); this.pos += n; } else if (wire === 5) this.pos += 4; else if (wire === 1) this.pos += 8; else throw new Error('wire ' + wire); }
}
function packed(r) { const out = []; const s = r.sub(); while (!s.eof()) out.push(s.varint()); return out; }
function mapType(s) {
  if (s === 'cpu') return 'cpu_nanos';
  if (s === 'wall') return 'wall_nanos';
  if (s === 'alloc_space' || s === 'inuse_space') return 'alloc_bytes';
  if (s === 'alloc_objects' || s === 'inuse_objects') return 'alloc_objects';
  return s;
}

export function parsePprofBytes(data) {
  const r = new Reader(data);
  const strtab = [], sampleTypes = [], samples = [];
  const funcs = new Map(), locs = new Map();
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) { const s = r.sub(); let type = 0, unit = 0; while (!s.eof()) { const t = s.tag(); if (t.field === 1) type = s.varint(); else if (t.field === 2) unit = s.varint(); else s.skip(t.wire); } sampleTypes.push({ type, unit }); }
    else if (field === 2 && wire === 2) {
      const s = r.sub(); const locIds = [], vals = [];
      while (!s.eof()) { const t = s.tag(); if (t.field === 1) { if (t.wire === 2) locIds.push(...packed(s)); else locIds.push(s.varint()); } else if (t.field === 2) { if (t.wire === 2) vals.push(...packed(s)); else vals.push(s.varint()); } else s.skip(t.wire); }
      samples.push({ locIds, vals });
    } else if (field === 4 && wire === 2) {
      const s = r.sub(); let id = 0; const lines = [];
      while (!s.eof()) { const t = s.tag(); if (t.field === 1) id = s.varint(); else if (t.field === 4 && t.wire === 2) { const l = s.sub(); let fn = 0, line = 0; while (!l.eof()) { const lt = l.tag(); if (lt.field === 1) fn = l.varint(); else if (lt.field === 2) line = l.varint(); else l.skip(lt.wire); } lines.push({ fn, line }); } else s.skip(t.wire); }
      locs.set(id, lines);
    } else if (field === 5 && wire === 2) {
      const s = r.sub(); let id = 0, name = 0, file = 0, line = 0;
      while (!s.eof()) { const t = s.tag(); if (t.field === 1) id = s.varint(); else if (t.field === 2) name = s.varint(); else if (t.field === 4) file = s.varint(); else if (t.field === 5) line = s.varint(); else s.skip(t.wire); }
      funcs.set(id, { name, file, line });
    } else if (field === 6 && wire === 2) { strtab.push(r.str()); }
    else r.skip(wire);
  }

  const b = new ProfileBuilder();
  const funcIdx = new Map();
  const bFunc = (id) => { let x = funcIdx.get(id); if (x === undefined) { const f = funcs.get(id); x = b.internFunc(b.internString(strtab[f.name] || '?'), b.internString(strtab[f.file] || ''), f.line); funcIdx.set(id, x); } return x; };

  const stackCol = [];
  const colArr = sampleTypes.map(() => []);
  for (const smp of samples) {
    let prefix = -1;
    for (let li = smp.locIds.length - 1; li >= 0; li--) {
      const lines = locs.get(smp.locIds[li]) || [];
      for (let k = lines.length - 1; k >= 0; k--) { const ln = lines[k]; prefix = b.internStack(b.internFrame(bFunc(ln.fn), ln.line, lines.length - 1 - k), prefix); }
    }
    stackCol.push(prefix);
    for (let j = 0; j < sampleTypes.length; j++) colArr[j].push(smp.vals[j] || 0);
  }

  const weightsByType = {}, finalTypes = [];
  for (let j = 0; j < sampleTypes.length; j++) { let nm = mapType(strtab[sampleTypes[j].type] || ('v' + j)); if (weightsByType[nm]) nm = nm + '_' + j; weightsByType[nm] = colArr[j]; finalTypes.push(nm); }
  return b.finish([{ name: 'cpu', samples: { stack: stackCol, weightsByType, time: null } }], { hasTiming: false, weightTypes: finalTypes, isDiff: false });
}
