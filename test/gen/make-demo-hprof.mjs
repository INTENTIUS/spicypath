// Emits src/samples/demo-heap.hprof — a tiny, hand-built HPROF heap dump with a clean retained-size
// story (no JVM internals), for the bundled "Sample: heap dump" entry. A real dump is ~4 MB and
// dominated by JVM classes; this is ~15 KB and legible. Run once:
//   node test/gen/make-demo-hprof.mjs
import { writeFileSync } from 'node:fs';

const chunks = [];
const push = (b) => chunks.push(b);
const u1 = (n) => Buffer.from([n & 0xff]);
const u2 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u4 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const id = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }; // idSize = 8
const cat = (...bufs) => Buffer.concat(bufs);
const record = (tag, body) => cat(u1(tag), u4(0), u4(body.length), body);

// Header: "JAVA PROFILE 1.0.2\0", u4 idSize, u8 timestamp.
push(cat(Buffer.from('JAVA PROFILE 1.0.2', 'ascii'), Buffer.from([0]), u4(8), id(0)));

// --- strings: class names + a field-name placeholder ---
let sid = 1;
const strId = new Map();
const str = (s) => { const i = sid++; strId.set(s, i); push(record(0x01, cat(id(i), Buffer.from(s, 'utf8')))); return i; };
const FNAME = str('f'); // field name (unused by the parser, but the record needs one)
const classes = {
  Registry:   { obj: 1001, fields: ['cache', 'a', 'b', 'lru', 'session'] },
  ImageCache: { obj: 1002, fields: ['pixels'] },
  Config:     { obj: 1003, fields: ['blob'] },
  ServiceA:   { obj: 1004, fields: ['config'] },
  ServiceB:   { obj: 1005, fields: ['config'] },
  LruNode:    { obj: 1006, fields: ['entry', 'next'] },
  Session:    { obj: 1007, fields: ['token', 'peer'] },
};
let serial = 1;
for (const [name, c] of Object.entries(classes)) push(record(0x02, cat(u4(serial++), id(c.obj), u4(0), id(str(name)))));

// --- heap dump body ---
const heap = [];
// CLASS_DUMP for each class (super = 0, no cp/static, object-typed instance fields).
for (const c of Object.values(classes)) {
  const fields = c.fields.map(() => cat(id(FNAME), u1(2))); // type 2 = object ref
  heap.push(cat(
    u1(0x20), id(c.obj), u4(0), id(0), id(0), id(0), id(0), id(0), id(0),
    u4(c.fields.length * 8), u2(0), u2(0), u2(c.fields.length), ...fields));
}
// INSTANCE_DUMP: objId, stack, classObjId, nBytes, field-value bytes (object refs, in field order).
const inst = (obj, cls, refs) => heap.push(cat(
  u1(0x21), id(obj), u4(0), id(classes[cls].obj), u4(refs.length * 8), ...refs.map((r) => id(r))));
// PRIMITIVE_ARRAY_DUMP: objId, stack, nElems, elemType(8=byte), data.
const arr = (obj, n) => heap.push(cat(u1(0x23), id(obj), u4(0), u4(n), u1(8), Buffer.alloc(n)));

// objects: reg → {cache→pixels, a/b→cfg→blob, lru chain, session cycle}
inst(2001, 'Registry', [2002, 2004, 2005, 2006, 2009]);
inst(2002, 'ImageCache', [3001]); arr(3001, 48_000);      // exclusively owned — the big cell
inst(2003, 'Config', [3002]);     arr(3002, 16_000);      // shared by ServiceA + ServiceB
inst(2004, 'ServiceA', [2003]);
inst(2005, 'ServiceB', [2003]);
inst(2006, 'LruNode', [3003, 2007]); arr(3003, 12_000);   // chain: retained decreases down
inst(2007, 'LruNode', [3004, 2008]); arr(3004, 8_000);
inst(2008, 'LruNode', [3005, 0]);    arr(3005, 4_000);
inst(2009, 'Session', [3006, 2010]); arr(3006, 3_000);    // cycle: sess1 ⇄ sess2
inst(2010, 'Session', [3007, 2009]); arr(3007, 3_000);
// GC root: a JNI global handle on the Registry.
heap.push(cat(u1(0x01), id(2001), id(0)));

push(record(0x0c, cat(...heap)));

const out = 'src/samples/demo-heap.hprof';
writeFileSync(out, Buffer.concat(chunks));
console.log('wrote', out, Buffer.concat(chunks).length, 'bytes');
