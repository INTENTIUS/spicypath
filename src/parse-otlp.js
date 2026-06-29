// OTLP Profiles (OpenTelemetry profiling signal) DECOMPRESSED bytes → canonical model.
// Pure (browser + Node); the caller gunzips. Hand-rolled protobuf decode, no deps.
// Aggregated (no per-sample time, like pprof); Location.Line → inlineDepth; multi-value.
//
// SCHEMA PINNED: open-telemetry/opentelemetry-proto @ v1.7.0,
//   opentelemetry/proto/profiles/v1development/profiles.proto  (signal is Alpha/moving).
// All OTLP field numbers live in THIS file only, so an Alpha schema bump is a one-file edit.
// Layout: ProfilesData{ resource_profiles=1, dictionary=2 }. The symbol tables are shared in
// a top-level ProfilesDictionary (NOT inside each Profile, unlike pprof): location_table=2,
// function_table=3, string_table=5. A Sample slices Profile.location_indices(3) via
// locations_start_index(1)/locations_length(2); those indices point into location_table.
import { ProfileBuilder } from './model.js';

const td = new TextDecoder();

// Same hand-rolled reader as parse-pprof.js (kept local for the isolation boundary).
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
// read a repeated scalar as either packed (wire 2) or a single value (wire 0)
function ints(s, t, out) { if (t.wire === 2) { const sub = s.sub(); while (!sub.eof()) out.push(sub.varint()); } else out.push(s.varint()); }

// pprof/OTLP sample-type string → canonical weight type (same mapping as parse-pprof.js,
// kept local so the two parsers stay independent — see the isolation note above).
function mapType(s) {
  if (s === 'cpu') return 'cpu_nanos';
  if (s === 'wall') return 'wall_nanos';
  if (s === 'alloc_space' || s === 'inuse_space') return 'alloc_bytes';
  if (s === 'alloc_objects' || s === 'inuse_objects') return 'alloc_objects';
  return s;
}

export function parseOtlpBytes(data) {
  const r = new Reader(data);
  const dict = { strtab: [], funcs: [], locs: [] }; // function_table / location_table indexed by position
  const profiles = [];

  // ProfilesDictionary: location_table=2, function_table=3, string_table=5
  function readDictionary(s) {
    while (!s.eof()) {
      const t = s.tag();
      if (t.field === 2 && t.wire === 2) { // Location: line=3 (repeated Line{ function_index=1, line=2 })
        const l = s.sub(); const lines = [];
        while (!l.eof()) { const lt = l.tag(); if (lt.field === 3 && lt.wire === 2) { const ln = l.sub(); let fn = 0, line = 0; while (!ln.eof()) { const nt = ln.tag(); if (nt.field === 1) fn = ln.varint(); else if (nt.field === 2) line = ln.varint(); else ln.skip(nt.wire); } lines.push({ fn, line }); } else l.skip(lt.wire); }
        dict.locs.push(lines);
      } else if (t.field === 3 && t.wire === 2) { // Function: name_strindex=1, filename_strindex=3, start_line=4
        const f = s.sub(); let name = 0, file = 0, line = 0;
        while (!f.eof()) { const ft = f.tag(); if (ft.field === 1) name = f.varint(); else if (ft.field === 3) file = f.varint(); else if (ft.field === 4) line = f.varint(); else f.skip(ft.wire); }
        dict.funcs.push({ name, file, line });
      } else if (t.field === 5 && t.wire === 2) { dict.strtab.push(s.str()); }
      else s.skip(t.wire);
    }
  }
  // Profile: sample_type=1, sample=2, location_indices=3 (packed int32)
  function readProfile(s) {
    const sampleTypes = [], samples = [], locationIndices = [];
    while (!s.eof()) {
      const t = s.tag();
      if (t.field === 1 && t.wire === 2) { const v = s.sub(); let type = 0, unit = 0; while (!v.eof()) { const vt = v.tag(); if (vt.field === 1) type = v.varint(); else if (vt.field === 2) unit = v.varint(); else v.skip(vt.wire); } sampleTypes.push({ type, unit }); }
      else if (t.field === 2 && t.wire === 2) { // Sample: locations_start_index=1, locations_length=2, value=3 (packed)
        const sm = s.sub(); let start = 0, len = 0; const vals = [];
        while (!sm.eof()) { const st = sm.tag(); if (st.field === 1) start = sm.varint(); else if (st.field === 2) len = sm.varint(); else if (st.field === 3) ints(sm, st, vals); else sm.skip(st.wire); }
        samples.push({ start, len, vals });
      } else if (t.field === 3) { ints(s, t, locationIndices); }
      else s.skip(t.wire);
    }
    profiles.push({ sampleTypes, samples, locationIndices });
  }

  // ProfilesData: resource_profiles=1 → ScopeProfiles(2) → Profile(2); dictionary=2
  while (!r.eof()) {
    const t = r.tag();
    if (t.field === 1 && t.wire === 2) {
      const rp = r.sub();
      while (!rp.eof()) { const rt = rp.tag(); if (rt.field === 2 && rt.wire === 2) { const sp = rp.sub(); while (!sp.eof()) { const st = sp.tag(); if (st.field === 2 && st.wire === 2) readProfile(sp.sub()); else sp.skip(st.wire); } } else rp.skip(rt.wire); }
    } else if (t.field === 2 && t.wire === 2) { readDictionary(r.sub()); }
    else r.skip(t.wire);
  }

  const prof = profiles.find((p) => p.samples.length) || profiles[0] || { sampleTypes: [], samples: [], locationIndices: [] };
  const b = new ProfileBuilder();
  const funcIdx = new Map();
  const bFunc = (fi) => { let x = funcIdx.get(fi); if (x === undefined) { const f = dict.funcs[fi] || { name: 0, file: 0, line: 0 }; x = b.internFunc(b.internString(dict.strtab[f.name] || '?'), b.internString(dict.strtab[f.file] || ''), f.line); funcIdx.set(fi, x); } return x; };

  const stackCol = [];
  const colArr = prof.sampleTypes.map(() => []);
  for (const smp of prof.samples) {
    let prefix = -1;
    // slice of location_indices for this sample, leaf-first → walk root→leaf building the prefix
    for (let li = smp.len - 1; li >= 0; li--) {
      const lines = dict.locs[prof.locationIndices[smp.start + li]] || [];
      for (let k = lines.length - 1; k >= 0; k--) { const ln = lines[k]; prefix = b.internStack(b.internFrame(bFunc(ln.fn), ln.line, lines.length - 1 - k), prefix); }
    }
    stackCol.push(prefix);
    for (let j = 0; j < prof.sampleTypes.length; j++) colArr[j].push(smp.vals[j] || 0);
  }

  const weightsByType = {}, finalTypes = [];
  for (let j = 0; j < prof.sampleTypes.length; j++) { let nm = mapType(dict.strtab[prof.sampleTypes[j].type] || ('v' + j)); if (weightsByType[nm]) nm = nm + '_' + j; weightsByType[nm] = colArr[j]; finalTypes.push(nm); }
  return b.finish([{ name: 'otlp', samples: { stack: stackCol, weightsByType, time: null } }], { hasTiming: false, weightTypes: finalTypes.length ? finalTypes : ['samples'], isDiff: false });
}
