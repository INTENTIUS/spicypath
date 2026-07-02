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

// ── Tier B: ground-truth dominator / retained-size assertions (pending FG-058/FG-059) ────────
if (!existsSync('src/parse-hprof.js')) {
  console.log('  · Tier B pending — src/parse-hprof.js not implemented yet (FG-058/FG-059).');
  console.log('    The ground-truth oracle is ready: EXCLUSIVE, SHARED (no double-count), CYCLE');
  console.log('    (terminates), CHAIN (monotone), GARBAGE (absent), conservation of retained size.');
} else {
  const SLACK = 8192; // object/array header + alignment overhead per object
  const { parseHprof } = await import('../src/parse-hprof.js' as any);
  const p: any = parseHprof(bytes);
  const heap = p?.heap;

  check('Tier B: capabilities.kind === "heap"', p?.capabilities?.kind === 'heap');
  check('Tier B: GC roots + objects present', !!heap && heap.roots?.length > 0 && heap.objectCount > 0,
    heap ? `roots=${heap.roots?.length}, objects=${heap.objectCount}` : 'no heap model');

  const classes = heap.byClass();
  const cls = (suffix: string) => classes.find((c: any) => c.name.endsWith(suffix));
  for (const n of ['ExclusiveOwner', 'SharerA', 'SharerB', 'SharedPayload', 'ChainLink', 'CycleNode']) {
    check(`Tier B: class present — ${n}`, !!cls(n), cls(n) ? `retained=${cls(n).retained}` : 'missing');
  }

  // EXCLUSIVE — the exclusively-owned array is fully attributed to its single owner.
  const exclId = heap.objectsOfClass('ExclusiveOwner')[0];
  const exclRet = heap.retainedOf(exclId);
  check('Tier B: ExclusiveOwner retains its array (retained ≈ EXCL)',
    exclRet >= EXCL && exclRet <= EXCL + SLACK, `retained=${exclRet}, EXCL=${EXCL}`);

  // SHARED — the decisive test: the shared payload is dominated by NEITHER sharer (common
  // dominator is the root), so neither sharer's retained size includes it (no double-count).
  const aId = heap.objectsOfClass('SharerA')[0];
  const bId = heap.objectsOfClass('SharerB')[0];
  const sharedArrId = heap.objectsOfClass('SharedPayload')[0];
  const domOfShared = heap.dominatorParentOf(heap.retainedOf ? sharedArrId : sharedArrId);
  check('Tier B: shared payload not dominated by either sharer',
    domOfShared !== aId && domOfShared !== bId, `idom(shared)=${domOfShared}, a=${aId}, b=${bId}`);
  check('Tier B: SHARED counted once — neither sharer retains it',
    heap.retainedOf(aId) < SHARED && heap.retainedOf(bId) < SHARED,
    `retained(a)=${heap.retainedOf(aId)}, retained(b)=${heap.retainedOf(bId)}, SHARED=${SHARED}`);

  // CHAIN — retained monotonically decreases down the chain, each ≥ its own array.
  const chainRet = heap.objectsOfClass('ChainLink').map((id: number) => heap.retainedOf(id)).sort((x: number, y: number) => y - x);
  check('Tier B: chain retained is monotone (C1 > C2 > C3)',
    chainRet.length === 3 && chainRet[0] > chainRet[1] && chainRet[1] > chainRet[2], `${chainRet.join(' > ')}`);
  check('Tier B: chain links each retain ≥ their own array', chainRet[2] >= C3SZ, `smallest=${chainRet[2]}, C3=${C3SZ}`);

  // CYCLE — computation terminated (reaching here proves it); entry node retains both arrays.
  const cyc = heap.objectsOfClass('CycleNode').map((id: number) => heap.retainedOf(id)).sort((x: number, y: number) => y - x);
  check('Tier B: cycle terminates with finite retained sizes', cyc.length === 2 && cyc.every((v: number) => v > 0 && Number.isFinite(v)), `${cyc.join(', ')}`);
  check('Tier B: cycle entry node retains both cycle arrays (≥ 2·CYCLE)', cyc[0] >= 2 * CYCLE, `entry=${cyc[0]}, 2·CYCLE=${2 * CYCLE}`);

  // GARBAGE — the dropped 5 MB array must be absent from a live dump.
  const anyGarbage = heap.byClass().some((c: any) => c.name.includes('[B') /* byte[] */ && c.shallow >= GARBAGE);
  check('Tier B: dropped garbage array is absent (live dump)', !anyGarbage);

  // CONSERVATION — retained size of the super-root's direct children sums to total live shallow
  // (nothing lost, nothing double-counted — the global correctness check).
  const topRet = heap.roots
    .filter((id: number) => heap.dominatorParentOf(id) === -1)
    .reduce((s: number, id: number) => s + heap.retainedOf(id), 0);
  check('Tier B: retained size conserves total shallow (no loss / double-count)',
    Math.abs(topRet - heap.totalShallow) <= SLACK * heap.objectCount / 1000 || topRet === heap.totalShallow,
    `Σretained(top)=${topRet}, totalShallow=${heap.totalShallow}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  parse-hprof-test — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
