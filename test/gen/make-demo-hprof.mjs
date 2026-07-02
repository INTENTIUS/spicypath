// Emits src/samples/demo-heap.hprof — a hand-built HPROF heap dump for the bundled "heap dump"
// sample. A real JVM dump is ~4 MB and dominated by JVM internals; this is a legible, app-shaped
// heap: a web server retaining a connection pool, a session cache, an image cache, a router, a
// metrics registry, a logger ring buffer, and a thread pool — with a Config shared across
// connections (dominated by the server, not any one connection) and a User⇄Session cycle. The
// retained-size icicle/treemap then shows a real "what's eating the heap" breakdown.
//   node test/gen/make-demo-hprof.mjs
import { writeFileSync } from 'node:fs';

const chunks = [];
const push = (b) => chunks.push(b);
const u1 = (n) => Buffer.from([n & 0xff]);
const u2 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u4 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const id = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }; // idSize 8
const cat = (...b) => Buffer.concat(b);
const record = (tag, body) => cat(u1(tag), u4(0), u4(body.length), body);

// Header.
push(cat(Buffer.from('JAVA PROFILE 1.0.2', 'ascii'), Buffer.from([0]), u4(8), id(0)));

// --- interned strings ---
let nextStr = 1;
const strId = new Map();
const S = (s) => { if (strId.has(s)) return strId.get(s); const i = nextStr++; strId.set(s, i); push(record(0x01, cat(id(i), Buffer.from(s, 'utf8')))); return i; };
const FN = S('f'); // placeholder field name (parser reads types, not names)

// --- classes ---
let nextClass = 1000, serial = 1;
const classes = new Map(); // name -> { obj, fields }
function defClass(name, fields) {
  const obj = nextClass++;
  push(record(0x02, cat(u4(serial++), id(obj), u4(0), id(S(name)))));
  classes.set(name, { obj, fields });
}
// An object-array class so pools/caches can fan out to their elements.
const OBJARR = nextClass++;
push(record(0x02, cat(u4(serial++), id(OBJARR), u4(0), id(S('[Ljava.lang.Object;')))));

// --- heap dump body ---
const heap = [];
function emitClassDumps() {
  for (const c of classes.values()) {
    const fbufs = c.fields.map(() => cat(id(FN), u1(2))); // type 2 = object ref
    heap.push(cat(u1(0x20), id(c.obj), u4(0), id(0), id(0), id(0), id(0), id(0), id(0),
      u4(c.fields.length * 8), u2(0), u2(0), u2(c.fields.length), ...fbufs));
  }
}
let nextObj = 100000, nextArr = 500000;
const inst = (name, refs) => { const c = classes.get(name); const o = nextObj++; heap.push(cat(u1(0x21), id(o), u4(0), id(c.obj), u4(refs.length * 8), ...refs.map((r) => id(r)))); return o; };
const arr = (n) => { const o = nextArr++; heap.push(cat(u1(0x23), id(o), u4(0), u4(n), u1(8), Buffer.alloc(n))); return o; };
const objArr = (refs) => { const o = nextArr++; heap.push(cat(u1(0x22), id(o), u4(0), u4(refs.length), id(OBJARR), ...refs.map((r) => id(r)))); return o; };
const rootOf = (o) => heap.push(cat(u1(0x01), id(o), id(0)));

// classes (all fields are object refs)
defClass('WebServer',     ['pool', 'sessions', 'images', 'router', 'metrics', 'logger', 'threads', 'config']);
defClass('ConnectionPool', ['connections']);
defClass('Connection',    ['readBuffer', 'writeBuffer', 'config']);
defClass('SessionCache',  ['sessions']);
defClass('Session',       ['user', 'token']);
defClass('User',          ['session', 'profile']); // session ref → User⇄Session cycle
defClass('ImageCache',    ['images']);
defClass('Image',         ['pixels', 'thumbnail']);
defClass('Router',        ['routes']);
defClass('Route',         ['handler', 'pattern']);
defClass('Handler',       []);
defClass('MetricsRegistry', ['counters']);
defClass('Counter',       ['label']);
defClass('Logger',        ['ringBuffer']);
defClass('ThreadPool',    ['workers']);
defClass('Worker',        ['stack']);
defClass('Config',        ['settings']);
emitClassDumps();

// shared config (referenced by the server and every connection → dominated by the server)
const config = inst('Config', [arr(2048)]);

// connection pool: 20 connections, each with its own read/write buffers + the shared config
const connections = [];
for (let i = 0; i < 20; i++) connections.push(inst('Connection', [arr(2048), arr(1024), config]));
const pool = inst('ConnectionPool', [objArr(connections)]);

// session cache: 30 sessions; each Session⇄User is a 2-node cycle (user.session ↔ session.user).
// Pre-allocate the id pair so both records can reference each other (HPROF records are write-once).
const sessions = [];
const rawInst = (oid, name, refs) => heap.push(cat(u1(0x21), id(oid), u4(0), id(classes.get(name).obj), u4(refs.length * 8), ...refs.map((r) => id(r))));
for (let i = 0; i < 30; i++) {
  const uid = nextObj++, sid = nextObj++;
  rawInst(uid, 'User', [sid, arr(512)]);     // User.session → session, User.profile → byte[512]
  rawInst(sid, 'Session', [uid, arr(256)]);  // Session.user → user, Session.token → byte[256]
  sessions.push(sid);
}
const sessionCache = inst('SessionCache', [objArr(sessions)]);

// image cache: 12 images with big pixel buffers — the heaviest subsystem
const images = [];
for (let i = 0; i < 12; i++) images.push(inst('Image', [arr(4000 + i * 400), arr(600)]));
const imageCache = inst('ImageCache', [objArr(images)]);

// router: 24 routes
const routes = [];
for (let i = 0; i < 24; i++) routes.push(inst('Route', [inst('Handler', []), arr(128)]));
const router = inst('Router', [objArr(routes)]);

// metrics: 40 counters
const counters = [];
for (let i = 0; i < 40; i++) counters.push(inst('Counter', [arr(64)]));
const metrics = inst('MetricsRegistry', [objArr(counters)]);

// logger with a big ring buffer
const logger = inst('Logger', [arr(16000)]);

// thread pool: 8 workers with per-thread stacks
const workers = [];
for (let i = 0; i < 8; i++) workers.push(inst('Worker', [arr(2048)]));
const threadPool = inst('ThreadPool', [objArr(workers)]);

// the server root
const server = inst('WebServer', [pool, sessionCache, imageCache, router, metrics, logger, threadPool, config]);
rootOf(server);

push(record(0x0c, cat(...heap)));

const out = 'src/samples/demo-heap.hprof';
const buf = Buffer.concat(chunks);
writeFileSync(out, buf);
console.log('wrote', out, buf.length, 'bytes');
