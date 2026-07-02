// FG-055 — unit test for src/parse-sample.js (macOS `sample`(1) call-tree text).
// Pure Node, no DOM.  node test/parse-sample-test.ts
import { readFileSync } from 'node:fs';
import { parseSampleText } from '../src/parse-sample.js';
import { ingestBytes } from '../src/ingest.js';
import { funcName } from '../src/colors.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// Fold a thread's samples into a { "a;b;c": weight } map (self weights along leaf→root paths).
function fold(p: any, ti: number) {
  const t = p.threads[ti], m = new Map<string, number>();
  for (let i = 0; i < t.samples.stack.length; i++) {
    const path: string[] = [];
    for (let s = t.samples.stack[i]; s >= 0; s = p.stackTable.prefix[s]) path.push(funcName(p, p.frameTable.func[p.stackTable.frame[s]]));
    const key = path.reverse().join(';');
    m.set(key, (m.get(key) || 0) + (t.samples.weightsByType.samples[i] || 0));
  }
  return m;
}

const text = readFileSync('test/testdata/basic-sample.txt', 'utf8');
const p = parseSampleText(text);

// Two threads, one per `Thread_` header.
check('two threads parsed', p.threads.length === 2, `threads=${p.threads.length}`);
check('thread names extracted', /main-thread/.test(p.threads[0].name) && /Worker/.test(p.threads[1].name),
  `[${p.threads.map((t: any) => t.name).join(' | ')}]`);
check('capabilities: samples weight, no timing', p.capabilities.weightTypes[0] === 'samples' && p.capabilities.hasTiming === false);

// Thread 1: start(100)→main(100)→{foo(60)→bar(40); baz(40)}.
// Self weights: bar=40, baz=40, foo self=60-40=20, main self=100-60-40=0, start self=0.
const t0 = fold(p, 0);
check('subtree total preserved (Σ self == root count)', [...t0.values()].reduce((a, b) => a + b, 0) === 100, `Σ=${[...t0.values()].reduce((a, b) => a + b, 0)}`);
check('leaf self weight: start;main;foo;bar = 40', t0.get('start;main;foo;bar') === 40, `${t0.get('start;main;foo;bar')}`);
check('interior self weight: start;main;foo = 20 (60−40 children)', t0.get('start;main;foo') === 20, `${t0.get('start;main;foo')}`);
check('sibling leaf: start;main;baz = 40', t0.get('start;main;baz') === 40, `${t0.get('start;main;baz')}`);
check('zero-self interior main NOT emitted', !t0.has('start;main'), 'main self=0 → no sample');

// Thread 2: thread_start(30)→work(30) → work self 30.
const t1 = fold(p, 1);
check('thread 2: thread_start;work = 30', t1.get('thread_start;work') === 30, `${t1.get('thread_start;work')}`);

// Module kept as the func's file → colours by shared object. `baz` was "(in libwork)".
const bazFunc = p.funcTable.name.findIndex((_: any, fi: number) => funcName(p, fi) === 'baz');
const bazFile = p.funcTable.file[bazFunc];
check('module captured as func file', bazFile >= 0 && p.stringTable[bazFile] === 'libwork', `file=${bazFile >= 0 ? p.stringTable[bazFile] : '(none)'}`);

// End markers ignored: the "Total number in stack" section's `130 main` line must NOT be parsed.
check('graph end-markers ignored (no stray 130)', ![...t0.values(), ...t1.values()].includes(130));

// Routes through ingest by content sniff (a .txt that is NOT folded).
const viaIngest = await ingestBytes('capture.txt', new Uint8Array(readFileSync('test/testdata/basic-sample.txt')));
check('ingest content-sniff routes sample .txt (not folded)', viaIngest.threads.length === 2 && viaIngest.threads[0].samples.stack.length > 0,
  `threads=${viaIngest.threads.length}`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  parse-sample-test — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
