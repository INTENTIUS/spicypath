// Scene → OTLP Profiles (profiles/v1development, opentelemetry-proto v1.7.0), uncompressed
// protobuf bytes. Aggregates samples by stack; emits multiple sample_types for multi-value
// scenes. Deliberately mirrors emit-pprof.js's frame layout (one Line per Location, line=0,
// empty filename, leaf-first locations) so the SAME scene yields an identical canonical model
// through parse-otlp.js and parse-pprof.js — that equivalence is the pprof<->OTLP lossless-edge
// proof (test/otlp-test.ts). Pure JS; hand-rolled writer (no deps).
//
// Dictionary model: symbol tables live in a top-level ProfilesDictionary (string_table=5,
// location_table=2, function_table=3), referenced by 0-based position. A Sample slices
// Profile.location_indices(3) via locations_start_index(1)/locations_length(2).

const utf8 = new TextEncoder();

class W {
  constructor() { this.b = []; }
  varint(n) { n = Math.floor(n); for (;;) { const x = n % 128; n = Math.floor(n / 128); if (n > 0) this.b.push(x | 0x80); else { this.b.push(x); break; } } }
  tag(field, wire) { this.varint(field * 8 + wire); }
  varField(field, n) { this.tag(field, 0); this.varint(n); }
  bytesField(field, bytes) { this.tag(field, 2); this.varint(bytes.length); for (let i = 0; i < bytes.length; i++) this.b.push(bytes[i]); }
  strField(field, s) { this.bytesField(field, utf8.encode(s)); }
  msgField(field, w) { this.bytesField(field, w.finish()); }
  packedField(field, nums) { const p = new W(); for (const n of nums) p.varint(n); this.bytesField(field, p.finish()); }
  finish() { return Uint8Array.from(this.b); }
}

// canonical value type → (type, unit) strings; round-trips through parse-otlp.mapType
function vtPair(vt) {
  if (vt === 'cpu_nanos') return ['cpu', 'nanoseconds'];
  if (vt === 'wall_nanos') return ['wall', 'nanoseconds'];
  if (vt === 'alloc_bytes') return ['alloc_space', 'bytes'];
  if (vt === 'alloc_objects') return ['alloc_objects', 'count'];
  return [vt, 'count']; // 'samples' etc.
}

export function emitOtlp(scene) {
  const valueOf = (s, vt) => (vt === scene.weightTypes[0] ? s.weight : (scene.extraValues && scene.extraValues[vt] ? scene.extraValues[vt](s) : (vt === 'samples' ? 1 : 0)));
  const vts = scene.weightTypes;

  const strs = ['']; const strIdx = new Map([['', 0]]);
  const sidx = (s) => { let i = strIdx.get(s); if (i === undefined) { i = strs.length; strs.push(s); strIdx.set(s, i); } return i; };

  const funcs = []; const funcId = new Map();            // function_table (0-based)
  const locs = []; const locId = new Map();              // location_table (0-based), one Line each
  const frameLoc = (name) => {
    let l = locId.get(name);
    if (l === undefined) {
      let f = funcId.get(name);
      if (f === undefined) { f = funcs.length; funcs.push({ name: sidx(name), file: sidx('') }); funcId.set(name, f); }
      l = locs.length; locs.push({ fn: f }); locId.set(name, l);
    }
    return l;
  };

  // aggregate samples by stack path
  const agg = new Map();
  for (const s of scene.samples) {
    const key = s.stack.join(' ');
    let e = agg.get(key);
    if (!e) { e = { stack: s.stack, values: vts.map(() => 0) }; agg.set(key, e); }
    vts.forEach((vt, i) => { e.values[i] += valueOf(s, vt); });
  }

  // Profile: sample_type(1), sample(2), location_indices(3, packed). Build the flat
  // location_indices array, leaf-first, with each sample slicing into it.
  const profile = new W();
  for (const vt of vts) { const [t, u] = vtPair(vt); const st = new W(); st.varField(1, sidx(t)); st.varField(2, sidx(u)); profile.msgField(1, st); }
  const locationIndices = [];
  for (const e of agg.values()) {
    const ids = [...e.stack].reverse().map(frameLoc); // leaf-first
    const start = locationIndices.length;
    for (const id of ids) locationIndices.push(id);
    const sm = new W();
    sm.varField(1, start); sm.varField(2, ids.length); sm.packedField(3, e.values);
    profile.msgField(2, sm);
  }
  profile.packedField(3, locationIndices);

  // ResourceProfiles(1) → ScopeProfiles(2) → Profile(2)
  const scope = new W(); scope.msgField(2, profile);
  const resource = new W(); resource.msgField(2, scope);

  // ProfilesDictionary(2): location_table(2), function_table(3), string_table(5)
  const dict = new W();
  for (const l of locs) { const lm = new W(); const ll = new W(); ll.varField(1, l.fn); lm.msgField(3, ll); dict.msgField(2, lm); }
  for (const f of funcs) { const fm = new W(); fm.varField(1, f.name); fm.varField(3, f.file); dict.msgField(3, fm); }
  for (const s of strs) dict.strField(5, s);

  const top = new W();
  top.msgField(1, resource);
  top.msgField(2, dict);
  return top.finish();
}
