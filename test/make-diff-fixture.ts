// Generate a slightly-perturbed copy of real-vertx.speedscope.json to diff against, so the
// comparison view shows meaningful red (regression) / blue (improvement) frames.
// Deterministic (no RNG). Writes to test/testdata and ~/Downloads (next to the original, so
// it's easy to pick in the "compare…" dialog).
//   node test/make-diff-fixture.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSpeedscopeText } from '../src/parse-speedscope.js';
import { exportSpeedscope } from '../src/export.js';
import { buildCallNodeTable } from '../src/callnode.js';
import { buildDiff } from '../src/diff.js';

const SRC = 'test/testdata/real-vertx.speedscope.json';
if (!existsSync(SRC)) { console.log(`skip: ${SRC} not present`); process.exit(0); }

const text = readFileSync(SRC, 'utf8');
const A = parseSpeedscopeText(text);
const B = parseSpeedscopeText(text); // independent copy to mutate

const nameOf = (p: any, stack: number) => { // leaf-frame name of a stack
  const fr = p.stackTable.frame[stack];
  return p.stringTable[p.funcTable.name[p.frameTable.func[fr]]] || '';
};
const pathHas = (p: any, stack: number, re: RegExp) => {
  for (let s = stack; s >= 0; s = p.stackTable.prefix[s]) if (re.test(p.stringTable[p.funcTable.name[p.frameTable.func[p.stackTable.frame[s]]]] || '')) return true;
  return false;
};
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

const t = B.threads[0], col = t.samples.weightsByType.samples;
// The diff is share-of-total (zero-sum), so to get clear red AND blue we MOVE weight between
// two halves of the leaves and keep the grand total constant. Split leaves by a hash of their
// name: deflate side 0 (blue), inflate side 1 (red) by an equal amount. Shared ancestors net
// out toward grey; divergent leaves show the change.
const side = (stack: number) => hash(nameOf(B, stack)) % 2;
let s0 = 0, s1 = 0;
for (let i = 0; i < col.length; i++) (side(t.samples.stack[i]) ? (s1 += col[i]) : (s0 += col[i]));
const T = Math.round(Math.min(s0, s1) * 0.45);   // weight moved side0 → side1
const newW = Math.max(1, Math.round(T * 0.2));    // a slice funds a brand-new frame
const downScale = (s0 - T - newW) / s0, upScale = (s1 + T) / s1;
for (let i = 0; i < col.length; i++) {
  col[i] = Math.max(1, Math.round(col[i] * (side(t.samples.stack[i]) ? upScale : downScale)));
}
console.log(`transfer: side0 (${s0}) → side1 (${s1}), T=${T} + new-frame ${newW}; total preserved`);

// inject one brand-new frame (present only in B → pure red), nested under a busy stack
const busy = t.samples.stack[col.indexOf(Math.max(...col))];
const sIdx = B.stringTable.push('regressed_hotpath()') - 1;
const fnIdx = B.funcTable.name.push(sIdx) - 1; B.funcTable.file.push(-1); B.funcTable.line.push(-1);
const frIdx = B.frameTable.func.push(fnIdx) - 1; B.frameTable.line.push(-1); B.frameTable.inlineDepth.push(0);
const stIdx = B.stackTable.frame.push(frIdx) - 1; B.stackTable.prefix.push(busy);
t.samples.stack.push(stIdx); col.push(newW); if (t.samples.time) t.samples.time.push(t.samples.time[t.samples.time.length - 1]);

// re-export as a valid speedscope file, name it so it's recognizable in the dialog
const out = JSON.parse(exportSpeedscope(B, 'samples'));
out.profiles[0].name = 'real-vertx (modified)';
const json = JSON.stringify(out);

const targets = ['test/testdata/real-vertx-modified.speedscope.json', join(homedir(), 'Downloads', 'real-vertx-modified.speedscope.json')];
for (const path of targets) { writeFileSync(path, json); console.log('wrote', path); }

// report the resulting diff so we know it's meaningful
const ctA = buildCallNodeTable(A, 0, 'samples');
const d = buildDiff(A, parseSpeedscopeText(json), 'samples', 'samples');
// count only frames past the view's grey dead-zone (|delta| >= 3% of maxAbs) — what you'll see
let reg = 0, imp = 0; const vis = d.maxAbsDelta * 0.03;
for (let i = 0; i < d.ct.func.length; i++) { const dv = d.ct.delta[i]; if (dv > vis) reg++; else if (dv < -vis) imp++; }
console.log(`diff vs original: ${d.ct.func.length} merged nodes · ${reg} visibly heavier (red) · ${imp} visibly lighter (blue) · maxΔ ${(d.maxAbsDelta * 100).toFixed(1)}% · (ctA ${ctA.func.length} nodes)`);
