// JFR ingestion test (FG-031). Requires a JDK on PATH.
// If java/jfr are absent, prints "SKIP (no JDK)" and exits 0.
// Otherwise: ensures the reference recording exists (regenerates it if missing),
// parses it, and asserts correctness against the `jfr print` oracle.
//   node test/parse-jfr-test.ts
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { checkInvariants } from '../src/model.js';
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

function topLeaves(p: ReturnType<typeof parseJfr>, n = 5): { name: string; count: number }[] {
  const t = p.threads[0];
  const col = t.samples.weightsByType.samples;
  const m = new Map<number, number>();
  for (let i = 0; i < t.samples.stack.length; i++) {
    const st = t.samples.stack[i];
    if (st < 0) continue;
    const fn = p.frameTable.func[p.stackTable.frame[st]];
    m.set(fn, (m.get(fn) ?? 0) + (col?.[i] ?? 1));
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

const OUT_DIR  = 'test/out';
const JFR_PATH = `${OUT_DIR}/jfr-workload.jfr`;
const SRC_PATH = 'test/gen/JfrWorkload.java';

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

if (!existsSync(JFR_PATH)) {
  console.log('Generating jfr-workload.jfr …');
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

const nSamples = profile.threads.reduce((s, t) => s + t.samples.stack.length, 0);
assert(nSamples >= 150 && nSamples <= 400, `sample count ${nSamples} out of range [150,400]`);
console.log(`ok    sample count = ${nSamples}`);

// ---- (c) Time array --------------------------------------------------------

for (const t of profile.threads) {
  const time = t.samples.time!;
  assert(time.length === t.samples.stack.length, 'time.length == stack.length');
  for (let i = 1; i < time.length; i++) {
    assert(time[i] >= time[i - 1], `time not monotonic at ${i}`);
  }
}
console.log('ok    time array monotonic');

// ---- (d) Hot leaf is fib ---------------------------------------------------

const leaves = topLeaves(profile);
console.log('Top leaf functions:');
for (const { name, count } of leaves) {
  console.log(`  ${String(count).padStart(5)}  ${name}`);
}

const hotLeaf = leaves[0];
assert(!!hotLeaf, 'no samples found');
assert(
  hotLeaf.name.toLowerCase().includes('fib'),
  `hottest leaf "${hotLeaf.name}" does not contain "fib" — constant-pool resolution is wrong`,
);
console.log(`ok    hot leaf = "${hotLeaf.name}" (${hotLeaf.count}/${nSamples} samples)`);

// ---- (e) fib dominance (oracle says 226/227) --------------------------------

const fibCount = leaves.filter(l => l.name.toLowerCase().includes('fib'))
                       .reduce((s, l) => s + l.count, 0);
const fibFrac = fibCount / nSamples;
assert(fibFrac >= 0.7, `fib fraction ${(fibFrac * 100).toFixed(1)}% < 70% — stacks misresolved`);
console.log(`ok    fib dominance = ${(fibFrac * 100).toFixed(1)}% of ${nSamples} samples`);

// ---- (f) ingest path: the file-open route (drop / picker) detects JFR by magic ----------
// File-open goes through ingestBytes, not parseJfr directly — verify both the .jfr extension
// and the EXTENSIONLESS case (magic-byte sniff) so a dropped/renamed .jfr still works.
const bytes = new Uint8Array(readFileSync(JFR_PATH));
const viaExt = await ingestBytes('recording.jfr', bytes);
const viaMagic = await ingestBytes('noextension', bytes); // forces the content sniff
assert(viaExt.capabilities.hasTiming && viaExt.threads[0].samples.stack.length === nSamples, 'ingestBytes(.jfr) mismatch');
assert(viaMagic.threads[0].samples.stack.length === nSamples, 'ingestBytes(magic, no extension) failed to detect JFR');
console.log(`ok    ingest path detects JFR by extension and by magic (${nSamples} samples both)`);

console.log('\nPASS  parse-jfr-test');
