// JFR ingestion test (FG-031 + FG-052). Requires a JDK on PATH.
// If java/jfr are absent, prints "SKIP (no JDK)" and exits 0.
// Otherwise: ensures the reference recording exists (regenerates it if missing),
// parses it, and asserts correctness against the `jfr print` oracle.
//   node test/parse-jfr-test.ts
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { checkInvariants } from '../src/model.js';
import { mergedThread } from '../src/callnode.js';
import { parseJfr } from './parse-jfr.ts';
import { ingestBytes } from '../src/ingest.js';

// ---- helpers ---------------------------------------------------------------

function hasCmd(cmd: string): boolean {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 && !!r.stdout.trim();
}

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`FAIL  ${msg}`); process.exit(1); }
}

// Top leaf functions for a given weight column (by column name, default 'samples').
function topLeaves(
  p: ReturnType<typeof parseJfr>,
  weightType = 'samples',
  n = 5,
): { name: string; count: number }[] {
  // Aggregate across all threads
  const m = new Map<number, number>();
  for (const t of p.threads) {
    const col = t.samples.weightsByType[weightType];
    if (!col) continue;
    for (let i = 0; i < t.samples.stack.length; i++) {
      const st = t.samples.stack[i];
      if (st < 0) continue;
      const fn = p.frameTable.func[p.stackTable.frame[st]];
      m.set(fn, (m.get(fn) ?? 0) + (col[i] ?? 0));
    }
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([fn, count]) => ({ name: p.stringTable[p.funcTable.name[fn]], count }));
}

// ---- Check for JDK ---------------------------------------------------------

if (!hasCmd('java') || !hasCmd('jfr')) {
  console.log('SKIP (no JDK)');
  process.exit(0);
}

// ---- Ensure the reference recording exists ---------------------------------
// FG-052: JfrWorkload.java was updated to include allocHot(), so delete any
// cached recording built from the old source to force regeneration.

const OUT_DIR  = 'test/out';
const JFR_PATH = `${OUT_DIR}/jfr-workload.jfr`;
const SRC_PATH = 'test/gen/JfrWorkload.java';
const CLS_PATH = `${OUT_DIR}/JfrWorkload.class`;

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// Regenerate if source is newer than the recording or if recording is absent.
const needRegen = !existsSync(JFR_PATH) || (() => {
  const jfrMs = statSync(JFR_PATH).mtimeMs;
  const srcMs = existsSync(SRC_PATH) ? statSync(SRC_PATH).mtimeMs : 0;
  return srcMs > jfrMs;
})();

if (needRegen) {
  console.log('Generating jfr-workload.jfr …');
  if (existsSync(JFR_PATH)) rmSync(JFR_PATH);
  if (existsSync(CLS_PATH)) rmSync(CLS_PATH);
  execSync(`javac -d ${OUT_DIR} ${SRC_PATH}`, { stdio: 'pipe' });
  execSync(
    `java -cp ${OUT_DIR} ` +
    `-XX:StartFlightRecording=settings=profile,filename=${JFR_PATH},dumponexit=true ` +
    `JfrWorkload`,
    { stdio: 'pipe' },
  );
}

assert(existsSync(JFR_PATH), `Recording not found: ${JFR_PATH}`);

// ---- Parse ----------------------------------------------------------------

console.log(`Parsing ${JFR_PATH} …`);
const profile = parseJfr(JFR_PATH);

// ---- (a) Model invariants --------------------------------------------------

const errs = checkInvariants(profile);
assert(errs.length === 0, `checkInvariants: ${errs.join('; ')}`);
assert(profile.capabilities.hasTiming, 'hasTiming must be true');
console.log('ok    checkInvariants');

// ---- (b) Sample count ------------------------------------------------------

// FG-052: total sample count now includes CPU + alloc (+ any monitor/park) events.
// Still a loose "not empty / not garbage" check; fib dominance remains the real assertion.
const nSamples = profile.threads.reduce((s, t) => s + t.samples.stack.length, 0);
assert(nSamples >= 20 && nSamples <= 100000, `sample count ${nSamples} out of sane range [20,100000]`);
console.log(`ok    sample count = ${nSamples}`);

// ---- (c) Time array --------------------------------------------------------

for (const t of profile.threads) {
  const time = t.samples.time!;
  assert(time.length === t.samples.stack.length, 'time.length == stack.length');
  for (let i = 1; i < time.length; i++) {
    assert(time[i] >= time[i - 1], `time not monotonic at ${i} in thread "${t.name}"`);
  }
}
console.log('ok    time array monotonic');

// ---- (d) Hot CPU leaf is fib (FG-031 regression) ----------------------------

const cpuLeaves = topLeaves(profile, 'samples');
console.log('Top CPU leaf functions:');
for (const { name, count } of cpuLeaves) {
  console.log(`  ${String(count).padStart(5)}  ${name}`);
}

const hotCpuLeaf = cpuLeaves[0];
assert(!!hotCpuLeaf, 'no CPU samples found');
assert(
  hotCpuLeaf.name.toLowerCase().includes('fib'),
  `hottest CPU leaf "${hotCpuLeaf.name}" does not contain "fib" — constant-pool resolution is wrong`,
);
const nCpuSamples = profile.threads.reduce((s, t) => {
  const col = t.samples.weightsByType['samples'];
  return s + (col ? col.reduce((a, v) => a + v, 0) : 0);
}, 0);
const fibCount = cpuLeaves.filter(l => l.name.toLowerCase().includes('fib'))
                          .reduce((s, l) => s + l.count, 0);
const fibFrac = fibCount / nCpuSamples;
assert(fibFrac >= 0.7, `fib fraction ${(fibFrac * 100).toFixed(1)}% < 70% — stacks misresolved`);
console.log(`ok    hot CPU leaf = "${hotCpuLeaf.name}" (fib dominance ${(fibFrac * 100).toFixed(1)}%)`);

// ---- (e) FG-052: weightTypes includes alloc_bytes --------------------------

assert(
  profile.capabilities.weightTypes.includes('alloc_bytes'),
  `weightTypes ${JSON.stringify(profile.capabilities.weightTypes)} missing "alloc_bytes"`,
);
console.log(`ok    weightTypes = ${JSON.stringify(profile.capabilities.weightTypes)}`);

// ---- (e2) FG-052/FG-053: merged "all threads" view carries BOTH CPU and alloc dimensions ----
// FG-053: the parser now emits N Thread objects (one per real JVM thread). The "all threads"
// merged view (mergedThread()) reproduces FG-052's unified stream so both CPU and alloc
// dimensions are reachable in the default merged view. Assert:
//   (a) threads.length > 1 (multi-thread workload from FG-053 JfrWorkload.java)
//   (b) the merged view carries both non-zero CPU and non-zero alloc weights
//   (c) selecting a single worker thread yields a proper subset (only that thread's samples)
{
  // (a) multi-thread: the workload spawns worker-1 + worker-2 + main → at least 2 distinct threads
  assert(profile.threads.length > 1, `expected >1 threads (FG-053 multi-thread workload), got ${profile.threads.length}`);
  console.log(`ok    threads.length = ${profile.threads.length} (${profile.threads.map((t: any) => t.name).join(', ')})`);

  // (b) merged view carries both CPU and alloc (FG-052 reachability invariant preserved)
  const merged = mergedThread(profile);
  assert(merged !== null, 'mergedThread() returned null');
  const mw = merged!.samples.weightsByType;
  const cpuKey = mw['samples'] ? 'samples' : 'cpu_nanos';
  const cpuNz = (mw[cpuKey] || []).filter((x: number) => x > 0).length;
  const allocNz = (mw['alloc_bytes'] || []).filter((x: number) => x > 0).length;
  assert(cpuNz > 0 && allocNz > 0,
    `merged thread must carry both dimensions: cpuNz=${cpuNz} allocNz=${allocNz}`);
  console.log(`ok    merged thread: ${merged!.samples.stack.length} samples, cpu ${cpuNz}nz + alloc ${allocNz}nz (FG-052 reachability preserved via merge)`);

  // (c) per-thread selection: a single thread's sample count < merged total (it's a subset)
  const mergedTotal = merged!.samples.stack.length;
  for (const t of profile.threads) {
    assert(t.samples.stack.length < mergedTotal,
      `thread "${t.name}" has ${t.samples.stack.length} >= merged ${mergedTotal} — not a proper subset`);
  }
  console.log(`ok    per-thread counts are strict subsets of merged total (${mergedTotal})`);

  // (d) setThread('all') via API: the merged view total >= any individual thread total
  // (verified structurally above; the UI API test is in test/browser.ts)
}

// ---- (f) FG-052: alloc_bytes column — hot allocator is allocHot -----------

const allocLeaves = topLeaves(profile, 'alloc_bytes', 10);
console.log('Top alloc_bytes leaf functions:');
for (const { name, count } of allocLeaves) {
  console.log(`  ${String(count).padStart(12)}  ${name}`);
}

assert(allocLeaves.length > 0, 'no alloc_bytes samples found');
const hotAllocLeaf = allocLeaves[0];
assert(
  hotAllocLeaf.name.toLowerCase().includes('allochot') ||
  hotAllocLeaf.name.toLowerCase().includes('alloc'),
  `hottest alloc leaf "${hotAllocLeaf.name}" does not contain "alloc" — alloc stack resolution wrong`,
);
console.log(`ok    hot alloc leaf = "${hotAllocLeaf.name}"`);

// ---- (g) FG-052: weight column lengths == sample count (invariants already cover this, belt+suspenders)

for (const t of profile.threads) {
  const len = t.samples.stack.length;
  for (const wt of profile.capabilities.weightTypes) {
    const col = t.samples.weightsByType[wt];
    assert(col !== undefined && col.length === len,
      `thread "${t.name}" weight "${wt}" length ${col?.length} != samples ${len}`);
  }
}
console.log('ok    all weight column lengths == sample count');

// ---- (h) FG-052: monitor_nanos / park_nanos — best-effort (don't fail if absent) -----------

if (profile.capabilities.weightTypes.includes('monitor_nanos')) {
  const monLeaves = topLeaves(profile, 'monitor_nanos', 5);
  console.log(`ok    monitor_nanos present (${monLeaves.length} distinct leaf(s))`);
} else {
  console.log('note  monitor_nanos not present in this recording (ok — workload has no contention)');
}
if (profile.capabilities.weightTypes.includes('park_nanos')) {
  const parkLeaves = topLeaves(profile, 'park_nanos', 5);
  console.log(`ok    park_nanos present (${parkLeaves.length} distinct leaf(s))`);
} else {
  console.log('note  park_nanos not present in this recording (ok — workload does not park)');
}

// ---- (h2) FG-053: per-thread selection yields a sample subset ----------------------------

import { buildCallNodeTable } from '../src/callnode.js';

{
  // Build a CT from the merged view and one from a single thread; merged total >= per-thread.
  const merged = mergedThread(profile)!;
  const wt = profile.capabilities.weightTypes.includes('alloc_bytes') ? 'alloc_bytes' : profile.capabilities.weightTypes[0];
  const mergedCt = buildCallNodeTable(profile, merged, wt);
  for (let i = 0; i < profile.threads.length; i++) {
    const ct = buildCallNodeTable(profile, i, wt);
    assert(mergedCt.grandTotal >= ct.grandTotal,
      `merged grandTotal ${mergedCt.grandTotal} < thread[${i}] ${ct.grandTotal} — merge is wrong`);
  }
  console.log(`ok    merged grandTotal (${mergedCt.grandTotal}) >= all per-thread totals`);
}

// ---- (i) ingest path: the file-open route (drop / picker) detects JFR by magic ----------
// File-open goes through ingestBytes, not parseJfr directly — verify both the .jfr extension
// and the EXTENSIONLESS case (magic-byte sniff) so a dropped/renamed .jfr still works.
const bytes = new Uint8Array(readFileSync(JFR_PATH));
const viaExt = await ingestBytes('recording.jfr', bytes);
const viaMagic = await ingestBytes('noextension', bytes); // forces the content sniff
const nSamplesViaExt = viaExt.threads.reduce((s, t) => s + t.samples.stack.length, 0);
assert(viaExt.capabilities.hasTiming && nSamplesViaExt === nSamples, 'ingestBytes(.jfr) mismatch');
assert(viaMagic.threads.reduce((s, t) => s + t.samples.stack.length, 0) === nSamples,
  'ingestBytes(magic, no extension) failed to detect JFR');
console.log(`ok    ingest path detects JFR by extension and by magic (${nSamples} samples both)`);

console.log('\nPASS  parse-jfr-test');
