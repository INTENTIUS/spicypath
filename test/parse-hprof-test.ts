// FG-057/FG-058/FG-059 — HPROF heap-dump test.
//
// Generates a REAL `.hprof` from test/gen/HprofWorkload.java (a graph with known dominator
// relationships + retained sizes), then exercises it. If java/javac are absent, prints
// "SKIP (no JDK)" and exits 0.
//   node test/parse-hprof-test.ts
//
// Two tiers:
//   Tier A (runs whenever a JDK is present): structurally walk the generated dump — magic,
//     identifier size, and the top-level tag/length record framing to EOF, with a heap-dump
//     segment present. This validates the generator and pins the outer container format the
//     FG-058 parser's read loop must handle. Runnable TODAY (no spicypath heap parser needed).
//   Tier B (runs once src/parse-hprof.js exists): the GROUND-TRUTH assertions against the
//     dominator/retained-size contract below. Until FG-058/FG-059 land, this block prints a
//     "pending" note and is skipped — it is the executable spec the implementer builds toward.
//
// ── The contract Tier B asserts (this test IS the FG-058/059 spec) ──────────────────────────
//   import { parseHprof } from '../src/parse-hprof.js';
//   const p = parseHprof(bytes: Uint8Array) => {
//     capabilities: { kind: 'heap' },
//     heap: {
//       roots: number[],                          // GC-root object ids
//       objectCount: number,
//       totalShallow: number,                     // Σ live shallow sizes
//       byClass(): Array<{ name, count, shallow, retained }>,   // retained = Σ retained of instances
//       objectsOfClass(nameSuffix: string): number[],           // instance ids, class simple-name match
//       retainedOf(objId: number): number,        // retained size (dominator subtree shallow sum)
//       dominatorParentOf(objId: number): number, // immediate dominator; -1 == the synthetic super-root
//     }
//   }
// The sampled-profile model (capabilities.kind === 'sampled', absent = 'sampled') is untouched.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';

// Ground-truth sizes — must match test/gen/HprofWorkload.java exactly.
const EXCL = 4_000_037, SHARED = 2_000_003, CYCLE = 1_000_003;
const C1SZ = 300_017, C2SZ = 200_003, C3SZ = 100_003, GARBAGE = 5_000_011;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const hasCmd = (cmd: string) => spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;

// ── JDK gate ────────────────────────────────────────────────────────────────────────────────
if (!hasCmd('java') || !hasCmd('javac')) {
  console.log('SKIP (no JDK) — install a JDK to generate + exercise the HPROF fixture');
  process.exit(0);
}

// ── generate the dump (regen if the generator changed; dumpHeap won't overwrite → delete first)
const OUT_DIR = 'test/out';
const HPROF   = `${OUT_DIR}/heap-workload.hprof`;
const SRC     = 'test/gen/HprofWorkload.java';
const CLS     = `${OUT_DIR}/HprofWorkload.class`;
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const needRegen = !existsSync(HPROF) ||
  (existsSync(SRC) && statSync(SRC).mtimeMs > statSync(HPROF).mtimeMs);
if (needRegen) {
  console.log('Generating heap-workload.hprof …');
  if (existsSync(HPROF)) rmSync(HPROF);
  if (existsSync(CLS)) rmSync(CLS);
  execSync(`javac -d ${OUT_DIR} ${SRC}`, { stdio: 'pipe' });
  // dumpHeap fails if the target exists; we deleted it above.
  execSync(`java -cp ${OUT_DIR} HprofWorkload ${HPROF}`, { stdio: 'pipe' });
}
if (!existsSync(HPROF)) { console.log('  ✗ dump not produced:', HPROF); process.exit(1); }

const bytes = new Uint8Array(readFileSync(HPROF));
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// ── Tier A: structural walk of the HPROF container ───────────────────────────────────────────
// Header: NUL-terminated version string, then u4 identifierSize, then u8 timestamp.
// Records: u1 tag, u4 time (µs), u4 length, then `length` body bytes. Heap data lives in
// HEAP_DUMP (0x0C) / HEAP_DUMP_SEGMENT (0x1C) records, terminated by HEAP_DUMP_END (0x2C).
{
  let magicEnd = 0;
  while (magicEnd < 64 && bytes[magicEnd] !== 0) magicEnd++;
  const magic = new TextDecoder().decode(bytes.subarray(0, magicEnd));
  check('Tier A: HPROF magic present', /^JAVA PROFILE 1\.0\.[12]$/.test(magic), magic);

  const idSize = dv.getUint32(magicEnd + 1, false);
  check('Tier A: identifier size is 4 or 8', idSize === 4 || idSize === 8, `${idSize} bytes`);

  // Walk the top-level record stream and confirm the framing consumes the file exactly.
  let off = magicEnd + 1 + 4 + 8; // past version\0 + u4 idSize + u8 timestamp
  let records = 0, heapSegs = 0, ended = false;
  const HEAP_DUMP = 0x0c, HEAP_DUMP_SEGMENT = 0x1c, HEAP_DUMP_END = 0x2c;
  while (off + 9 <= bytes.length) {
    const tag = dv.getUint8(off);
    const len = dv.getUint32(off + 5, false); // skip u4 time at off+1
    if (tag === HEAP_DUMP || tag === HEAP_DUMP_SEGMENT) heapSegs++;
    if (tag === HEAP_DUMP_END) ended = true;
    off += 9 + len;
    records++;
  }
  check('Tier A: record framing consumes the file exactly (well-formed)', off === bytes.length, `end off ${off} of ${bytes.length}`);
  check('Tier A: at least one HEAP_DUMP[/SEGMENT] record', heapSegs > 0, `${heapSegs} segment(s), ${records} records total`);

  // Weak liveness sanity: a live-only dump holds the ~8.6 MB payload but NOT the 5 MB garbage.
  const live = EXCL + SHARED + CYCLE * 2 + C1SZ + C2SZ + C3SZ;
  check('Tier A: file size ≈ live set, excludes dropped garbage',
    bytes.length >= live && bytes.length < live + GARBAGE,
    `${(bytes.length / 1e6).toFixed(1)}MB (live ≈ ${(live / 1e6).toFixed(1)}MB, garbage ${(GARBAGE / 1e6).toFixed(1)}MB)`);
}

// ── Tier B: ground-truth against the heap model (FG-058) + dominators (FG-059) ───────────────
// B1 needs only the parser + HeapModel (FG-058). B2 auto-activates once the model also exposes
// retainedOf/dominatorParentOf (FG-059). Until src/parse-hprof.js exists, both are pending.
if (!existsSync('src/parse-hprof.js')) {
  console.log('  · Tier B pending — src/parse-hprof.js not implemented yet (FG-058/FG-059).');
  console.log('    Oracle ready: object graph (refs/roots/shallow), then retained/dominators —');
  console.log('    EXCLUSIVE, SHARED (no double-count), CYCLE, CHAIN, GARBAGE, conservation.');
} else {
  const SLACK = 8192; // object/array header + alignment overhead per object
  const { parseHprof } = await import('../src/parse-hprof.js' as any);
  const p: any = parseHprof(bytes);
  const heap = p?.heap;

  // ── B1: object graph (FG-058) ──────────────────────────────────────────────────────────────
  check('B1: capabilities.kind === "heap"', p?.capabilities?.kind === 'heap');
  check('B1: objects + GC roots present', !!heap && heap.objectCount > 0 && heap.roots?.length > 0,
    heap ? `objects=${heap.objectCount}, roots=${heap.roots?.length}` : 'no heap model');
  check('B1: totalShallow covers the live payload',
    heap.totalShallow >= EXCL + SHARED + 2 * CYCLE + C1SZ + C2SZ + C3SZ, `totalShallow=${heap.totalShallow}`);

  const classes = heap.byClass();
  const cls = (s: string) => classes.find((c: any) => c.name.endsWith(s));
  for (const n of ['ExclusiveOwner', 'SharerA', 'SharerB', 'SharedPayload', 'ChainLink', 'CycleNode']) {
    check(`B1: class present — ${n}`, !!cls(n), cls(n) ? `count=${cls(n).count}` : 'missing');
  }

  const first = (s: string) => heap.objectsOfClass(s)[0];
  const byteArrays: number[] = heap.objectsOfClass('byte[]');

  // EXCLUSIVE — a byte[] of ~EXCL exists (the exclusively-owned payload).
  check('B1: exclusively-owned byte[EXCL] present',
    byteArrays.some((id) => heap.shallowOf(id) >= EXCL && heap.shallowOf(id) <= EXCL + SLACK),
    `byte[] instances=${byteArrays.length}`);

  // SHARED — SharerA and SharerB reference the SAME SharedPayload instance (structural proof of sharing).
  const aId = first('SharerA'), bId = first('SharerB'), spId = first('SharedPayload');
  check('B1: both sharers reference the same shared payload',
    heap.refsOf(aId).includes(spId) && heap.refsOf(bId).includes(spId), `shared=${spId}`);

  // GARBAGE — no ~5 MB byte[] survived a live dump (largest live byte[] is EXCL ≈ 4 MB).
  check('B1: dropped garbage byte[GARBAGE] absent',
    !byteArrays.some((id) => heap.shallowOf(id) >= GARBAGE - 64),
    `max byte[]=${byteArrays.length ? Math.max(...byteArrays.map((id) => heap.shallowOf(id))) : 0}`);

  // INTEGRITY — every outgoing reference resolves to a real object index.
  let bad = 0; const N = heap.objectCount;
  for (let id = 0; id < N; id++) for (const t of heap.refsOf(id)) if (!(t >= 0 && t < N)) bad++;
  check('B1: reference graph integrity (all targets resolve)', bad === 0, `${bad} dangling`);

  // ── B2: dominators + retained size (FG-059) ─────────────────────────────────────────────────
  if (typeof heap.retainedOf === 'function' && typeof heap.dominatorParentOf === 'function') {
    const exclRet = heap.retainedOf(first('ExclusiveOwner'));
    check('B2: ExclusiveOwner retained ≈ EXCL', exclRet >= EXCL && exclRet <= EXCL + SLACK, `retained=${exclRet}`);

    const domShared = heap.dominatorParentOf(spId);
    check('B2: shared payload dominated by neither sharer', domShared !== aId && domShared !== bId, `idom(shared)=${domShared}`);
    check('B2: SHARED counted once — neither sharer retains it',
      heap.retainedOf(aId) < SHARED && heap.retainedOf(bId) < SHARED,
      `ret(a)=${heap.retainedOf(aId)}, ret(b)=${heap.retainedOf(bId)}`);

    const chain = heap.objectsOfClass('ChainLink').map((id: number) => heap.retainedOf(id)).sort((x: number, y: number) => y - x);
    check('B2: chain retained monotone (C1 > C2 > C3)', chain.length === 3 && chain[0] > chain[1] && chain[1] > chain[2], chain.join(' > '));

    const cyc = heap.objectsOfClass('CycleNode').map((id: number) => heap.retainedOf(id)).sort((x: number, y: number) => y - x);
    check('B2: cycle terminates, finite retained', cyc.length === 2 && cyc.every((v: number) => v > 0 && Number.isFinite(v)), cyc.join(', '));
    check('B2: cycle entry retains both arrays (≥ 2·CYCLE)', cyc[0] >= 2 * CYCLE, `entry=${cyc[0]}`);

    // Every object lands in exactly one super-root subtree, so Σ retained over the super-root's
    // direct children (idom === -1) must equal total shallow — nothing lost or double-counted.
    let topRet = 0;
    for (let id = 0; id < heap.objectCount; id++) if (heap.dominatorParentOf(id) === -1) topRet += heap.retainedOf(id);
    check('B2: retained conserves total shallow', topRet === heap.totalShallow,
      `Σtop=${topRet}, total=${heap.totalShallow}`);
  } else {
    console.log('  · B2 pending — retainedOf/dominatorParentOf not on the heap model yet (FG-059).');
  }

  // ── B3: view bridge (FG-060) — heap ct via buildCallNodeTable ────────────────────────────────
  // Exercises the new kind:'heap' branch: build a ct from the dominator tree, verify the
  // grandTotal/roots/prefix/children invariants hold, and confirm funcName resolves to the class.
  if (!existsSync('src/callnode.js')) {
    console.log('  · B3 pending — src/callnode.js not present.');
  } else {
    const { buildCallNodeTable } = await import('../src/callnode.js' as any);
    const { funcName } = await import('../src/colors.js' as any);

    const ct = buildCallNodeTable(p, 0, 'retained_bytes');

    check('B3: grandTotal === totalShallow', ct.grandTotal === heap.totalShallow,
      `grandTotal=${ct.grandTotal}, totalShallow=${heap.totalShallow}`);
    check('B3: roots.length > 0', ct.roots.length > 0, `roots=${ct.roots.length}`);
    check('B3: grandTotal > 0', ct.grandTotal > 0, `grandTotal=${ct.grandTotal}`);

    // ExclusiveOwner node total should be close to EXCL (its retained byte array).
    const exclId2 = heap.objectsOfClass('ExclusiveOwner')[0];
    if (exclId2 !== undefined) {
      const ctRetained = ct.total[exclId2];
      const ctSelf     = ct.self[exclId2];
      const SLACK2 = 8192;
      check('B3: ExclusiveOwner ct.total ≈ EXCL', ctRetained >= EXCL && ctRetained <= EXCL + SLACK2,
        `ct.total[exclId]=${ctRetained}`);
      check('B3: ExclusiveOwner ct.self = shallowOf(exclId)',
        ctSelf === heap.shallowOf(exclId2), `ct.self=${ctSelf}`);

      // funcName via the synthetic stringTable/funcTable must resolve to the class name.
      const fn = funcName(p, ct.func[exclId2]);
      check('B3: funcName ends with class name (ExclusiveOwner)',
        typeof fn === 'string' && fn.endsWith('ExclusiveOwner'), `funcName="${fn}"`);
    } else {
      check('B3: ExclusiveOwner found in objectsOfClass', false, 'not found');
    }

    // prefix/children consistency: for each non-root node, its parent's children list
    // must contain it, and the child's prefix must match the parent's index.
    let prefixOk = true;
    const N2 = heap.objectCount;
    for (let id = 0; id < N2 && prefixOk; id++) {
      const par = ct.prefix[id];
      if (par >= 0 && !ct.children[par].includes(id)) { prefixOk = false; }
    }
    check('B3: prefix/children consistent (child in parent.children)',
      prefixOk, prefixOk ? 'ok' : 'mismatch found');
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  parse-hprof-test — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
