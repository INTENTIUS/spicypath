// FG-025 pass 3 — unit tests for src/metrics-window.js (aggregateWindow).
// Pure Node, no DOM, no browser.
//   node test/metrics-window-test.ts

// Stub theme so funcName/colors.js can import getTokens without a DOM.
// colors.js uses funcName which only reads stringTable/funcTable — no theme calls needed
// for this test, but the module-level import of theme.js calls getTokens() at parse time.
(globalThis as any).window = undefined; // ensure no accidental DOM access

import { ProfileBuilder } from '../src/model.js';
import { aggregateWindow } from '../src/metrics-window.js';

// Minimal theme stub — getTokens() is called lazily by colorForPackage, but funcName doesn't need it
import { setTheme } from '../src/theme.js';
try { setTheme('Catppuccin Mocha'); } catch { /* ignore if stub env doesn't like it */ }

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// ---- build a known profile ----
// Stack shape:
//   root (func 0) → A (func 1) → B (func 2)   [deep]
//   root (func 0) → C (func 3)                  [shallow]
//
// Samples with times: 10, 20, 30, 40, 50
// stacks: B, B, C, C, A  (leaf weight goes to B/C/A)
// weights: 1 for each sample

function buildTestProfile() {
  const pb = new ProfileBuilder();
  const sRoot = pb.internString('root');
  const sA = pb.internString('A');
  const sB = pb.internString('B');
  const sC = pb.internString('C');
  const sFile = pb.internString('');

  const fRoot = pb.internFunc(sRoot, -1, -1);
  const fA = pb.internFunc(sA, -1, -1);
  const fB = pb.internFunc(sB, -1, -1);
  const fC = pb.internFunc(sC, -1, -1);

  const frRoot = pb.internFrame(fRoot, -1, 0);
  const frA = pb.internFrame(fA, -1, 0);
  const frB = pb.internFrame(fB, -1, 0);
  const frC = pb.internFrame(fC, -1, 0);

  // call stacks (prefix tree)
  const stRoot = pb.internStack(frRoot, -1);   // root
  const stA = pb.internStack(frA, stRoot);      // root → A
  const stB = pb.internStack(frB, stA);         // root → A → B
  const stC = pb.internStack(frC, stRoot);      // root → C

  // 5 samples: times 10,20,30,40,50 — stacks B, B, C, C, A
  const time = [10, 20, 30, 40, 50];
  const stack = [stB, stB, stC, stC, stA];
  const weights = [1, 1, 1, 1, 1];

  const thread = {
    name: 'main',
    samples: {
      stack,
      time,
      weightsByType: { samples: weights },
    },
  };

  return pb.finish([thread], { hasTiming: true, weightTypes: ['samples'], isDiff: false, timeUnit: 'milliseconds' });
}

const profile = buildTestProfile();
// func indices: fRoot=0, fA=1, fB=2, fC=3

// ---- test 1: window [10, 30) — includes t=10,20 (both B), excludes t=30 ----
{
  const { funcs, windowTotal } = aggregateWindow(profile, 0, 'samples', 10, 30);
  check('t1: windowTotal is 2 for [10,30)', windowTotal === 2, `got ${windowTotal}`);
  check('t1: exactly one func (B)', funcs.length === 1, `got ${funcs.length} funcs`);
  check('t1: top func is B with self=2', funcs[0].name === 'B' && funcs[0].self === 2, `${funcs[0].name} self=${funcs[0].self}`);
  check('t1: totalFrac for B is 1.0', Math.abs(funcs[0].totalFrac - 1.0) < 1e-9, `${funcs[0].totalFrac}`);
}

// ---- test 2: window [30, 50) — includes t=30,40 (both C), excludes t=50 ----
{
  const { funcs, windowTotal } = aggregateWindow(profile, 0, 'samples', 30, 50);
  check('t2: windowTotal is 2 for [30,50)', windowTotal === 2, `got ${windowTotal}`);
  check('t2: exactly one func (C)', funcs.length === 1, `got ${funcs.length} funcs`);
  check('t2: top func is C with self=2', funcs[0].name === 'C' && funcs[0].self === 2, `${funcs[0].name} self=${funcs[0].self}`);
}

// ---- test 3: window [10, 51) — all 5 samples; B has 2, C has 2, A has 1 ----
{
  const { funcs, windowTotal } = aggregateWindow(profile, 0, 'samples', 10, 51);
  check('t3: windowTotal is 5 for full range', windowTotal === 5, `got ${windowTotal}`);
  check('t3: 3 distinct funcs', funcs.length === 3, `got ${funcs.length}`);
  // sorted descending by self: B=2, C=2, A=1 (B or C first, then A)
  check('t3: A is last (self=1)', funcs[funcs.length - 1].name === 'A' && funcs[funcs.length - 1].self === 1, `last=${funcs[funcs.length - 1].name} self=${funcs[funcs.length - 1].self}`);
  check('t3: first two are B and C (both self=2)', funcs[0].self === 2 && funcs[1].self === 2, `${funcs[0].name}=${funcs[0].self} ${funcs[1].name}=${funcs[1].self}`);
}

// ---- test 4: boundary — sample at exactly t0=20 INCLUDED, at exactly t1=30 EXCLUDED ----
{
  const { funcs, windowTotal } = aggregateWindow(profile, 0, 'samples', 20, 30);
  // t=20 → stB (included); t=30 → stC (excluded)
  check('t4: boundary [20,30) includes t=20', windowTotal === 1, `windowTotal=${windowTotal}`);
  check('t4: boundary [20,30) func is B', funcs.length === 1 && funcs[0].name === 'B', `funcs=${funcs.map((f: any) => f.name).join(',')}`);
}

// ---- test 5: empty window — no samples ----
{
  const { funcs, windowTotal } = aggregateWindow(profile, 0, 'samples', 60, 100);
  check('t5: empty window → 0 funcs', funcs.length === 0, `got ${funcs.length}`);
  check('t5: empty window → windowTotal=0', windowTotal === 0, `got ${windowTotal}`);
}

// ---- test 6: single-sample window [50, 51) — leaf is stA → func A ----
{
  const { funcs, windowTotal } = aggregateWindow(profile, 0, 'samples', 50, 51);
  check('t6: [50,51) includes t=50 → leaf A', funcs.length === 1 && funcs[0].name === 'A', `funcs=${funcs.map((f: any) => f.name).join(',')}`);
  check('t6: totalFrac for A is 1.0', Math.abs(funcs[0].totalFrac - 1.0) < 1e-9, `${funcs[0].totalFrac}`);
}

// ---- test 7: ranking — verify descending sort by self ----
{
  const { funcs } = aggregateWindow(profile, 0, 'samples', 10, 51);
  let sorted = true;
  for (let i = 1; i < funcs.length; i++) {
    if (funcs[i].self > funcs[i - 1].self) { sorted = false; break; }
  }
  check('t7: funcs sorted descending by self', sorted, `${funcs.map((f: any) => `${f.name}=${f.self}`).join(',')}`);
}

console.log(`\nmetrics-window: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
