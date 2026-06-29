// FG-030: per-line aggregation unit tests. Drives aggregateByLine() on fixtures with known
// file/line and asserts exact per-line self/total distributions.
//
// Model semantics (see src/sourceline.js): frameTable.line is the line within the frame's
// OWN function. So to get the hot lines of function f we set the line on f's OWN frames.
// f executing at two different lines interns to two distinct frames → distinct stack nodes,
// which is how call sites within f are separated. A callee's frame line is a line in the
// CALLEE's file and must NOT leak into f's aggregation.
//   node test/sourceline-test.ts
import { ProfileBuilder } from '../src/model.js';
import { buildCallNodeTable } from '../src/callnode.js';
import { aggregateByLine, funcBasename } from '../src/sourceline.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// Basic: A (foo.js) executes at line 10 calling B, and at line 20 calling C.
//   A@10 → B  weight 5      A@20 → C  weight 3
// Expected for A: total[10]=5, total[20]=3, no self (A is never the leaf).
// B/C carry their own (different-file) lines, which must NOT appear in A's result.
// ---------------------------------------------------------------------------
{
  const pb = new ProfileBuilder();
  const funcA = pb.internFunc(pb.internString('A'), pb.internString('foo.js'), 1);
  const funcB = pb.internFunc(pb.internString('B'), pb.internString('bar.js'), 50);
  const funcC = pb.internFunc(pb.internString('C'), pb.internString('baz.js'), 70);

  const sA10 = pb.internStack(pb.internFrame(funcA, 10, 0), -1);   // A executing at line 10
  const sAB  = pb.internStack(pb.internFrame(funcB, 55, 0), sA10); // → B (line 55 in bar.js)
  const sA20 = pb.internStack(pb.internFrame(funcA, 20, 0), -1);   // A executing at line 20
  const sAC  = pb.internStack(pb.internFrame(funcC, 77, 0), sA20); // → C (line 77 in baz.js)

  const profile = pb.finish(
    [{ name: 'main', samples: { stack: [sAB, sAC], weightsByType: { samples: [5, 3] } } }],
    { hasTiming: false, weightTypes: ['samples'], isDiff: false, timeUnit: 'none' },
  );
  const ct = buildCallNodeTable(profile, 0, 'samples');
  const lines = aggregateByLine(ct, profile, funcA);

  check('basic: total[10]=5 (A on stack at line 10)', (lines.get(10)?.total ?? 0) === 5, `got ${lines.get(10)?.total}`);
  check('basic: total[20]=3 (A on stack at line 20)', (lines.get(20)?.total ?? 0) === 3, `got ${lines.get(20)?.total}`);
  check('basic: A has no self (never a leaf)', (lines.get(10)?.self ?? 0) === 0 && (lines.get(20)?.self ?? 0) === 0, `self[10]=${lines.get(10)?.self} self[20]=${lines.get(20)?.self}`);
  check('basic: callee lines (55,77) do NOT leak into A', !lines.has(55) && !lines.has(77) && lines.size === 2, `keys=${[...lines.keys()].join(',')}`);
}

// ---------------------------------------------------------------------------
// Self: A executes at line 30 as a leaf (weight 8), and at line 10 calling B (weight 5).
// Expected: self[30]=8, total[30]=8, total[10]=5.
// ---------------------------------------------------------------------------
{
  const pb = new ProfileBuilder();
  const funcA = pb.internFunc(pb.internString('A'), pb.internString('foo.js'), 1);
  const funcB = pb.internFunc(pb.internString('B'), pb.internString('bar.js'), 50);

  const sA10 = pb.internStack(pb.internFrame(funcA, 10, 0), -1);   // A@10 → B
  const sAB  = pb.internStack(pb.internFrame(funcB, 55, 0), sA10);
  const sA30 = pb.internStack(pb.internFrame(funcA, 30, 0), -1);   // A@30 as leaf

  const profile = pb.finish(
    [{ name: 'main', samples: { stack: [sAB, sA30], weightsByType: { samples: [5, 8] } } }],
    { hasTiming: false, weightTypes: ['samples'], isDiff: false, timeUnit: 'none' },
  );
  const ct = buildCallNodeTable(profile, 0, 'samples');
  const lines = aggregateByLine(ct, profile, funcA);

  check('self: total[10]=5 (A at line 10 calling B)', (lines.get(10)?.total ?? 0) === 5, `got ${lines.get(10)?.total}`);
  check('self: self[30]=8 (A is the leaf at line 30)', (lines.get(30)?.self ?? 0) === 8, `got ${lines.get(30)?.self}`);
  check('self: total[30]=8 (self included in total)', (lines.get(30)?.total ?? 0) === 8, `got ${lines.get(30)?.total}`);
}

// ---------------------------------------------------------------------------
// SAME-LINE recursion (the once-per-sample regression): A recurses from line 15.
//   A@15 → A@15 (leaf)  weight 7
// Line 15 of A is on the stack at TWO depths in this one sample, but total[15] must be 7,
// NOT 14 — counted once per sample. (This is the case a naive subtree-sum double-counts.)
// ---------------------------------------------------------------------------
{
  const pb = new ProfileBuilder();
  const funcA = pb.internFunc(pb.internString('A'), pb.internString('foo.js'), 1);
  const frameA15 = pb.internFrame(funcA, 15, 0);               // A executing at line 15
  const sOuter = pb.internStack(frameA15, -1);                 // A@15
  const sInner = pb.internStack(frameA15, sOuter);             // A@15 → A@15 (same line, deeper)

  const profile = pb.finish(
    [{ name: 'main', samples: { stack: [sInner], weightsByType: { samples: [7] } } }],
    { hasTiming: false, weightTypes: ['samples'], isDiff: false, timeUnit: 'none' },
  );
  const ct = buildCallNodeTable(profile, 0, 'samples');
  const lines = aggregateByLine(ct, profile, funcA);

  check('recursion(same line): total[15]=7 once, not 14 (recursion-safe)', (lines.get(15)?.total ?? 0) === 7, `got ${lines.get(15)?.total}`);
  check('recursion(same line): self[15]=7 (inner A is the leaf)', (lines.get(15)?.self ?? 0) === 7, `got ${lines.get(15)?.self}`);
  check('recursion(same line): only line 15 appears', lines.size === 1, `keys=${[...lines.keys()].join(',')}`);
}

// ---------------------------------------------------------------------------
// DIFFERENT-line recursion: A@5 → A@15 → B (leaf)  weight 7. A is on the stack at two
// DISTINCT lines (5 and 15), so both totals are 7 (each genuinely on the stack once).
// ---------------------------------------------------------------------------
{
  const pb = new ProfileBuilder();
  const funcA = pb.internFunc(pb.internString('A'), pb.internString('foo.js'), 1);
  const funcB = pb.internFunc(pb.internString('B'), pb.internString('bar.js'), 50);
  const sA5  = pb.internStack(pb.internFrame(funcA, 5, 0), -1);    // A@5
  const sA15 = pb.internStack(pb.internFrame(funcA, 15, 0), sA5);  // A@5 → A@15
  const sB   = pb.internStack(pb.internFrame(funcB, 55, 0), sA15); // → B

  const profile = pb.finish(
    [{ name: 'main', samples: { stack: [sB], weightsByType: { samples: [7] } } }],
    { hasTiming: false, weightTypes: ['samples'], isDiff: false, timeUnit: 'none' },
  );
  const ct = buildCallNodeTable(profile, 0, 'samples');
  const lines = aggregateByLine(ct, profile, funcA);

  check('recursion(diff lines): total[5]=7 and total[15]=7', (lines.get(5)?.total ?? 0) === 7 && (lines.get(15)?.total ?? 0) === 7, `5=${lines.get(5)?.total} 15=${lines.get(15)?.total}`);
  check('recursion(diff lines): no self (B is the leaf, not A)', (lines.get(5)?.self ?? 0) === 0 && (lines.get(15)?.self ?? 0) === 0, `self5=${lines.get(5)?.self} self15=${lines.get(15)?.self}`);
}

// ---------------------------------------------------------------------------
// No-lines: every frame line = -1 → empty result, no crash.
// ---------------------------------------------------------------------------
{
  const pb = new ProfileBuilder();
  const funcA = pb.internFunc(pb.internString('A'), -1, -1);
  const funcB = pb.internFunc(pb.internString('B'), -1, -1);
  const sA  = pb.internStack(pb.internFrame(funcA, -1, 0), -1);
  const sAB = pb.internStack(pb.internFrame(funcB, -1, 0), sA);
  const profile = pb.finish(
    [{ name: 'main', samples: { stack: [sAB], weightsByType: { samples: [10] } } }],
    { hasTiming: false, weightTypes: ['samples'], isDiff: false, timeUnit: 'none' },
  );
  const ct = buildCallNodeTable(profile, 0, 'samples');
  const lines = aggregateByLine(ct, profile, funcA);
  check('no-lines: empty map (no crash) when all lines=-1', lines.size === 0, `size=${lines.size}`);
}

// ---------------------------------------------------------------------------
// funcBasename: basename extraction for source-file matching.
// ---------------------------------------------------------------------------
{
  const pb = new ProfileBuilder();
  const funcA = pb.internFunc(pb.internString('A'), pb.internString('/home/user/project/src/foo.js'), 1);
  const p = pb.finish([], { hasTiming: false, weightTypes: ['samples'], isDiff: false, timeUnit: 'none' });
  check('funcBasename: extracts basename from full path', funcBasename(p, funcA) === 'foo.js', funcBasename(p, funcA) ?? 'null');
  const pb2 = new ProfileBuilder();
  const funcX = pb2.internFunc(pb2.internString('X'), -1, -1);
  const p2 = pb2.finish([], { hasTiming: false, weightTypes: ['samples'], isDiff: false, timeUnit: 'none' });
  check('funcBasename: returns null when file=-1', funcBasename(p2, funcX) === null, 'expected null');
}

console.log(`\nsourceline: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
