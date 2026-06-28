// Validate that THIS app derives the same call-tree quantities speedscope would, from the
// real evented sample. Strategy: an INDEPENDENT oracle walks the O/C events directly and
// computes, per function name, self (time as stack top) and total (time anywhere on the
// stack, recursion counted once per interval) — speedscope's getSelfWeight/getTotalWeight
// semantics. Then compare to our parse-speedscope → CallNodeTable aggregates, and check
// speedscope's invariant: Σ self == endValue − startValue (total profile weight).
//   node test/validate-speedscope.ts
import { readFileSync, existsSync } from 'node:fs';
import { parseSpeedscopeText } from '../src/parse-speedscope.js';
import { buildCallNodeTable } from '../src/callnode.js';

const path = 'test/testdata/real-vertx.speedscope.json';
if (!existsSync(path)) { console.log(`skip: ${path} not present (run verify.ts with the Downloads file once)`); process.exit(0); }
const text = readFileSync(path, 'utf8');
const j = JSON.parse(text);
const names: string[] = j.shared.frames.map((f: any) => f.name);
const prof = j.profiles[0];

// ---- independent oracle over the events ----
const oSelf = new Map<string, number>(), oTotal = new Map<string, number>();
const stack: number[] = [];
let prev = prof.startValue ?? 0, totalTime = 0;
const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) || 0) + v);
for (const e of prof.events) {
  const dt = e.at - prev;
  if (dt > 0 && stack.length) {
    add(oSelf, names[stack[stack.length - 1]], dt);                 // self → current leaf
    const seen = new Set<string>();
    for (const fi of stack) seen.add(names[fi]);                    // total → each distinct name once
    for (const nm of seen) add(oTotal, nm, dt);
    totalTime += dt;
  }
  if (e.type === 'O') stack.push(e.frame); else { const k = stack.lastIndexOf(e.frame); if (k >= 0) stack.splice(k, 1); }
  prev = e.at;
}

// ---- our app's derivation ----
const p = parseSpeedscopeText(text);
const ct = buildCallNodeTable(p, 0, 'samples');
const nameOf = (func: number) => p.stringTable[p.funcTable.name[func]];
const mSelf = new Map<string, number>(), mTotal = new Map<string, number>();
for (let i = 0; i < ct.func.length; i++) add(mSelf, nameOf(ct.func[i]), ct.self[i]);
// total per name: time where the name is anywhere on the path (recursion once per sample)
for (let f = 0; f < p.funcTable.name.length; f++) {
  const nm = nameOf(f); if (mTotal.has(nm)) continue;
  const contains = new Uint8Array(ct.func.length); let tot = 0;
  for (let i = 0; i < ct.func.length; i++) { const pf = ct.prefix[i]; contains[i] = (nameOf(ct.func[i]) === nm || (pf >= 0 && contains[pf])) ? 1 : 0; if (contains[i]) tot += ct.self[i]; }
  mTotal.set(nm, tot);
}

// ---- compare ----
let fails = 0; const keys = new Set([...oSelf.keys(), ...oTotal.keys(), ...mSelf.keys(), ...mTotal.keys()]);
for (const k of keys) {
  const os = oSelf.get(k) || 0, ms = mSelf.get(k) || 0, otot = oTotal.get(k) || 0, mtot = mTotal.get(k) || 0;
  if (os !== ms || otot !== mtot) { if (fails < 8) console.log(`MISMATCH ${k}: self ${os} vs ${ms} | total ${otot} vs ${mtot}`); fails++; }
}
const selfSum = [...mSelf.values()].reduce((a, b) => a + b, 0);
const endSpan = (prof.endValue ?? 0) - (prof.startValue ?? 0);
console.log(`functions: ${keys.size}  oracle vs app self/total: ${fails === 0 ? 'all match ✓' : fails + ' mismatches ✗'}`);
console.log(`Σ self = ${selfSum}  oracle on-stack time = ${totalTime}  endValue−startValue = ${endSpan}  ${selfSum === endSpan ? '✓' : '(note: profile has idle gaps)'}`);
process.exit(fails === 0 && selfSum === totalTime ? 0 : 1);
