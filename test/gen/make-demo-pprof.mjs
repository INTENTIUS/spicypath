// Emits the bundled pprof samples (src/samples/multi-value.pprof + alloc-heap.pprof) from a wide,
// realistic web-server profile so the flame graph is busy and worth exploring — many endpoints,
// each fanning into db/json/cache/template/crypto work, plus background goroutines (GC, scheduler,
// worker pool). multi-value.pprof carries cpu(nanoseconds)+alloc_space(bytes); alloc-heap.pprof
// carries alloc_space(bytes)+alloc_objects(count). Hand-written pprof protobuf, no deps.
//   node test/gen/make-demo-pprof.mjs
import { writeFileSync } from 'node:fs';

// --- protobuf wire helpers ---
const varint = (n) => { const o = []; n = Math.floor(n); while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const cat = (...b) => Buffer.concat(b);
const tag = (f, w) => varint((f << 3) | w);
const VF = (f, n) => cat(tag(f, 0), varint(n));
const LD = (f, buf) => cat(tag(f, 2), varint(buf.length), buf);
const packed = (f, arr) => LD(f, cat(...arr.map(varint)));

// deterministic pseudo-weights (no Math.random → reproducible builds)
const hash = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x; };
const cpu = (s) => 800_000 + (hash(s) % 24) * 900_000;          // ~0.8–22 ms
const alloc = (s, heavy = 1) => (hash(s + 'a') % 12) * 24_576 * heavy; // 0–~3.5 MB (×heavy)

// --- build stacks (root→leaf function-name arrays with cpu/alloc weights) ---
const stacks = [];
const add = (path, seed, heavy = 1) => stacks.push({ path, cpu: cpu(seed), alloc: alloc(seed, heavy) });

const HTTP = ['main', 'net/http.(*Server).Serve', 'net/http.(*conn).serve', 'net/http.serverHandler.ServeHTTP', 'app/mux.(*Router).dispatch'];
const endpoints = [
  ['GET', 'users'], ['GET', 'user_by_id'], ['POST', 'orders'], ['GET', 'products'],
  ['GET', 'product_search'], ['POST', 'checkout'], ['GET', 'cart'], ['POST', 'upload'],
  ['GET', 'feed'], ['GET', 'recommendations'], ['POST', 'login'], ['GET', 'profile'],
  ['PUT', 'settings'], ['GET', 'notifications'], ['GET', 'analytics'],
];

for (const [method, ep] of endpoints) {
  const base = [...HTTP, 'app/mw.Logging', 'app/mw.Auth', 'app/mw.RateLimit', `app/handlers.${method}_${ep}`];
  const k = method + ep;
  // data layer: a DB query with a scan (alloc-heavy) + a network read (cpu)
  add([...base, 'app/db.Query', 'database/sql.(*DB).QueryContext', 'net.(*netFD).Read', 'syscall.read'], k + 'read');
  add([...base, 'app/db.Query', 'database/sql.(*DB).QueryContext', 'app/db.(*Rows).Scan', 'reflect.Value.Set'], k + 'scan', 3);
  add([...base, 'app/db.Query', 'database/sql.(*DB).QueryContext', 'app/db.(*Rows).Scan', 'runtime.growslice'], k + 'grow', 4);
  // cache
  add([...base, 'app/cache.Get', 'sync.(*Map).Load'], k + 'cacheget');
  if (hash(k) % 3 === 0) add([...base, 'app/cache.Set', 'runtime.mapassign_faststr'], k + 'cacheset', 2);
  // serialization: most endpoints JSON, some render templates
  if (hash(k) % 4 !== 0) {
    add([...base, 'encoding/json.Marshal', 'encoding/json.(*encodeState).marshal', 'reflect.Value.MapKeys'], k + 'json', 3);
    add([...base, 'encoding/json.Marshal', 'encoding/json.(*encodeState).string'], k + 'jsonstr', 2);
  } else {
    add([...base, 'app/tmpl.Render', 'text/template.(*Template).Execute', 'bytes.(*Buffer).Write'], k + 'tmpl', 2);
  }
  // auth work varies
  if (method === 'POST' || method === 'PUT' || ep === 'login' || ep === 'profile') {
    add([...base, 'app/mw.Auth', 'crypto/hmac.New', 'crypto/sha256.(*digest).Write'], k + 'hmac');
    add([...base, 'app/mw.Auth', 'app/token.Parse', 'encoding/base64.(*Encoding).Decode'], k + 'b64');
  }
  // uploads stream to disk
  if (ep === 'upload') add([...base, 'io.Copy', 'os.(*File).Write', 'syscall.write'], k + 'write');
}

// background goroutines — a real profile always has these
add(['runtime.gcBgMarkWorker', 'runtime.gcDrain', 'runtime.scanobject'], 'gcscan');
add(['runtime.gcBgMarkWorker', 'runtime.gcDrain', 'runtime.markroot', 'runtime.scanstack'], 'gcroot');
add(['runtime.gcBgMarkWorker', 'runtime.gcDrain', 'runtime.greyobject'], 'gcgrey');
add(['runtime.mstart', 'runtime.mstart1', 'runtime.schedule', 'runtime.findRunnable', 'runtime.stealWork'], 'sched');
add(['runtime.mstart', 'runtime.mstart1', 'runtime.schedule', 'runtime.futex'], 'futex');
add(['runtime.sysmon', 'runtime.netpoll', 'syscall.Syscall'], 'netpoll');
add(['runtime.sysmon', 'runtime.usleep'], 'usleep');
add(['app/worker.(*Pool).run', 'app/worker.(*Pool).process', 'app/jobs.EncodeThumbnail', 'image/jpeg.Encode'], 'thumb', 5);
add(['app/worker.(*Pool).run', 'app/worker.(*Pool).process', 'app/jobs.Compress', 'compress/gzip.(*Writer).Write'], 'gzip', 3);
add(['app/worker.(*Pool).run', 'app/worker.(*Pool).process', 'app/jobs.SendEmail', 'net/smtp.(*Client).Data'], 'smtp');

// --- intern functions + emit ---
const funcId = new Map();
for (const s of stacks) for (const fn of s.path) if (!funcId.has(fn)) funcId.set(fn, funcId.size + 1);

function build(sampleTypes, valueOf) {
  const st = ['']; const sid = (s) => { let i = st.indexOf(s); if (i < 0) { i = st.length; st.push(s); } return i; };
  const parts = [];
  for (const [type, unit] of sampleTypes) parts.push(LD(1, cat(VF(1, sid(type)), VF(2, sid(unit)))));
  for (const s of stacks) parts.push(LD(2, cat(packed(1, s.path.map((fn) => funcId.get(fn)).reverse()), packed(2, valueOf(s)))));
  for (const [fn, id] of funcId) parts.push(LD(4, cat(VF(1, id), LD(4, cat(VF(1, id), VF(2, 1))))));
  for (const [fn, id] of funcId) parts.push(LD(5, cat(VF(1, id), VF(2, sid(fn)), VF(4, 0), VF(5, 1))));
  for (const s of st) parts.push(LD(6, Buffer.from(s, 'utf8')));
  return cat(...parts);
}

writeFileSync('src/samples/multi-value.pprof', build([['cpu', 'nanoseconds'], ['alloc_space', 'bytes']], (s) => [s.cpu, s.alloc]));
writeFileSync('src/samples/alloc-heap.pprof', build([['alloc_space', 'bytes'], ['alloc_objects', 'count']], (s) => [s.alloc, s.alloc ? Math.max(1, Math.round(s.alloc / 64)) : 0]));
console.log('wrote multi-value.pprof + alloc-heap.pprof from', stacks.length, 'stacks,', funcId.size, 'functions');
