// Emits the bundled pprof samples (src/samples/multi-value.pprof + alloc-heap.pprof) from a single
// realistic web-server call tree, so the flame graph is actually interesting instead of 3 samples.
// multi-value.pprof carries cpu(nanoseconds) + alloc_space(bytes); alloc-heap.pprof carries
// alloc_space(bytes) + alloc_objects(count). Hand-written protobuf (pprof profile.proto), no deps.
//   node test/gen/make-demo-pprof.mjs
import { writeFileSync } from 'node:fs';

// --- protobuf wire helpers ---
const varint = (n) => { const o = []; n = Math.floor(n); while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const cat = (...b) => Buffer.concat(b);
const tag = (f, w) => varint((f << 3) | w);
const VF = (f, n) => cat(tag(f, 0), varint(n));                 // varint field
const LD = (f, buf) => cat(tag(f, 2), varint(buf.length), buf); // length-delimited field
const packed = (f, arr) => LD(f, cat(...arr.map(varint)));

// --- the call tree: leaves carry { cpu: nanos, alloc: bytes } ---
const tree = {
  'main': { k: {
    'net/http.(*Server).Serve': { k: {
      'net/http.(*conn).serve': { k: {
        'net/http.serverHandler.ServeHTTP': { k: {
          'app/api.(*Router).route': { k: {
            'app/auth.Verify': { k: {
              'crypto/hmac.New': { cpu: 3_200_000, alloc: 4_096 },
              'crypto/sha256.block': { cpu: 8_100_000, alloc: 0 },
            } },
            'app/db.Query': { k: {
              'database/sql.(*DB).query': { k: {
                'net.(*conn).Read': { cpu: 12_500_000, alloc: 8_192 },
                'app/db.(*Rows).Scan': { k: {
                  'reflect.Value.Set': { cpu: 2_100_000, alloc: 65_536 },
                  'runtime.growslice': { cpu: 1_200_000, alloc: 131_072 },
                } },
              } },
            } },
            'encoding/json.Marshal': { k: {
              'encoding/json.(*encodeState).marshal': { cpu: 6_700_000, alloc: 98_304 },
              'reflect.Value.Interface': { cpu: 1_100_000, alloc: 16_384 },
            } },
            'app/tmpl.Render': { k: {
              'text/template.(*Template).Execute': { cpu: 4_300_000, alloc: 49_152 },
              'bytes.(*Buffer).Write': { cpu: 900_000, alloc: 24_576 },
            } },
          } },
          'app/static.Serve': { k: {
            'io.Copy': { k: { 'syscall.write': { cpu: 9_300_000, alloc: 0 } } },
          } },
          'app/metrics.Handler': { k: {
            'prometheus.(*Registry).Gather': { cpu: 2_400_000, alloc: 24_576 },
          } },
        } },
      } },
    } },
    'app/cache.evictLoop': { k: {
      'app/cache.(*LRU).evict': { cpu: 1_800_000, alloc: 0 },
    } },
  } },
  'runtime.gcBgMarkWorker': { k: {
    'runtime.scanobject': { cpu: 15_200_000, alloc: 0 },
    'runtime.markroot': { cpu: 3_300_000, alloc: 0 },
  } },
  'runtime.mstart': { k: {
    'runtime.mallocgc': { cpu: 4_500_000, alloc: 0 },
    'runtime.futex': { cpu: 6_100_000, alloc: 0 },
  } },
};

// walk → leaf stacks (root→leaf function-name arrays) with weights
const stacks = [];
const walk = (node, path) => {
  for (const [name, child] of Object.entries(node)) {
    const p = [...path, name];
    if (child.k) walk(child.k, p);
    else stacks.push({ path: p, cpu: child.cpu || 0, alloc: child.alloc || 0 });
  }
};
walk(tree, []);

// intern function names → ids; one location per function (id == funcId)
const strtab = ['']; const strId = (s) => { let i = strtab.indexOf(s); if (i < 0) { i = strtab.length; strtab.push(s); } return i; };
const funcId = new Map();
for (const s of stacks) for (const fn of s.path) if (!funcId.has(fn)) funcId.set(fn, funcId.size + 1);

function build(sampleTypes, valueOf) {
  // sampleTypes: [[typeStr, unitStr], ...]; valueOf(stack) → [v0, v1]
  const st = strtab.slice(); const sid = (s) => { let i = st.indexOf(s); if (i < 0) { i = st.length; st.push(s); } return i; };
  const parts = [];
  for (const [type, unit] of sampleTypes) parts.push(LD(1, cat(VF(1, sid(type)), VF(2, sid(unit)))));
  for (const s of stacks) {
    const locIds = s.path.map((fn) => funcId.get(fn)).reverse(); // leaf-first
    parts.push(LD(2, cat(packed(1, locIds), packed(2, valueOf(s)))));
  }
  for (const [fn, id] of funcId) parts.push(LD(4, cat(VF(1, id), LD(4, cat(VF(1, id), VF(2, 1)))))); // location{ id, line{ funcId, line:1 } }
  for (const [fn, id] of funcId) parts.push(LD(5, cat(VF(1, id), VF(2, sid(fn)), VF(4, 0), VF(5, 1)))); // function{ id, name, file:"", start_line:1 }
  for (const s of st) parts.push(LD(6, Buffer.from(s, 'utf8')));                                        // string_table
  return cat(...parts);
}

writeFileSync('src/samples/multi-value.pprof', build([['cpu', 'nanoseconds'], ['alloc_space', 'bytes']], (s) => [s.cpu, s.alloc]));
writeFileSync('src/samples/alloc-heap.pprof', build([['alloc_space', 'bytes'], ['alloc_objects', 'count']], (s) => [s.alloc, s.alloc ? Math.max(1, Math.round(s.alloc / 48)) : 0]));
console.log('wrote multi-value.pprof + alloc-heap.pprof from', stacks.length, 'stacks,', funcId.size, 'functions');
