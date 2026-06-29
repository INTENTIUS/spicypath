// FG-027 acceptance: the pprof <-> OTLP lossless edge holds in our canonical model.
// Because emit-otlp.js mirrors emit-pprof.js's frame layout, the SAME payload encoded as
// pprof and as OTLP must parse to the SAME canonical model — not just the same distribution,
// but identical interned tables, stacks, and per-weight columns.
//   node test/otlp-test.ts
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PRESETS } from './scene.js';
import { emitPprof } from './emit/emit-pprof.js';
import { emitOtlp } from './emit/emit-otlp.js';
import { parsePprofBytes } from '../src/parse-pprof.js';
import { parseOtlpBytes } from '../src/parse-otlp.js';
import type { Profile } from '../src/model.ts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

// Strict model equality (ignoring the cosmetic thread name 'cpu' vs 'otlp'): same string/func/
// frame/stack tables, same weight columns, same per-sample stacks.
function modelKey(p: Profile) {
  const t = p.threads[0];
  return JSON.stringify({
    strings: p.stringTable,
    func: p.funcTable,
    frame: p.frameTable,
    stack: p.stackTable,
    weightTypes: p.capabilities.weightTypes,
    samplesStack: t.samples.stack,
    weights: p.capabilities.weightTypes.map((wt) => t.samples.weightsByType[wt]),
  });
}

// (1) Same-payload structural equivalence across every preset (incl. multi-value).
for (const scene of PRESETS) {
  const mp = parsePprofBytes(emitPprof(scene as any));
  const mo = parseOtlpBytes(emitOtlp(scene as any));
  const same = modelKey(mp) === modelKey(mo);
  check(`equiv: ${scene.name} — pprof and OTLP yield the identical model`, same,
    same ? `${mp.stackTable.frame.length} nodes, wt=[${mp.capabilities.weightTypes.join(',')}]`
         : `pprof nodes=${mp.stackTable.frame.length} wt=[${mp.capabilities.weightTypes.join(',')}] vs otlp nodes=${mo.stackTable.frame.length} wt=[${mo.capabilities.weightTypes.join(',')}]`);
}

// (2) Multi-value totals are preserved per weight type (explicit per-type check, not just
// structural identity — guards the sample_type/value column mapping).
const mv = PRESETS.find((s: any) => s.weightTypes.length > 1)!;
const a = parsePprofBytes(emitPprof(mv as any)), b = parseOtlpBytes(emitOtlp(mv as any));
const totals = (p: Profile, wt: string) => (p.threads[0].samples.weightsByType[wt] || []).reduce((x, y) => x + y, 0);
const allTypesMatch = a.capabilities.weightTypes.every((wt) => totals(a, wt) === totals(b, wt));
check('multi-value: every weight type total matches across pprof/OTLP', allTypesMatch,
  a.capabilities.weightTypes.map((wt) => `${wt}=${totals(a, wt)}/${totals(b, wt)}`).join('  '));

// (3) Real .pprof flavour: a real Go pprof capture, converted to OTLP and back, preserves the
// function-name stack distribution per weight type. (Our emitters are name-level, so this is a
// distribution check, not full structural identity — the real capture carries file/line our
// name-level OTLP emitter doesn't reproduce.)
function nameDist(p: Profile, wt: string) {
  const t = p.threads[0], col = t.samples.weightsByType[wt] || [], m = new Map<string, number>();
  for (let i = 0; i < t.samples.stack.length; i++) {
    const names: string[] = []; let n = t.samples.stack[i];
    while (n >= 0) { names.push(p.stringTable[p.funcTable.name[p.frameTable.func[p.stackTable.frame[n]]]]); n = p.stackTable.prefix[n]; }
    const k = names.reverse().join(';'); m.set(k, (m.get(k) || 0) + (col[i] || 0));
  }
  return m;
}
// Build a name-level scene from a parsed model, re-emit as OTLP, parse back.
function modelToScene(p: Profile) {
  const t = p.threads[0], wts = p.capabilities.weightTypes;
  const col0 = t.samples.weightsByType[wts[0]] || [];
  const samples = t.samples.stack.map((s, i) => {
    const names: string[] = []; let n = s;
    while (n >= 0) { names.push(p.stringTable[p.funcTable.name[p.frameTable.func[p.stackTable.frame[n]]]]); n = p.stackTable.prefix[n]; }
    const vals: Record<string, number> = {};
    for (const wt of wts) vals[wt] = (t.samples.weightsByType[wt] || [])[i] || 0;
    return { stack: names.reverse(), weight: col0[i] || 0, _vals: vals };
  });
  const extraValues: Record<string, (s: any) => number> = {};
  for (const wt of wts.slice(1)) extraValues[wt] = (s: any) => s._vals[wt];
  return { name: 'real', weightTypes: wts, samples, extraValues };
}
try {
  const raw = readFileSync('test/data/go.pprof');
  const data = (raw[0] === 0x1f && raw[1] === 0x8b) ? gunzipSync(raw) : raw;
  const real = parsePprofBytes(new Uint8Array(data));
  const back = parseOtlpBytes(emitOtlp(modelToScene(real) as any));
  let ok = true, why = '';
  for (const wt of real.capabilities.weightTypes) {
    const A = nameDist(real, wt), B = nameDist(back, wt);
    const keys = new Set([...A.keys(), ...B.keys()]);
    for (const k of keys) if (Math.abs((A.get(k) || 0) - (B.get(k) || 0)) > 1e-6) { ok = false; why = `wt=${wt} path ${k}: ${A.get(k)} vs ${B.get(k)}`; break; }
    if (!ok) break;
  }
  check('real go.pprof: pprof→OTLP→model preserves the name-path distribution', ok,
    ok ? `${real.threads[0].samples.stack.length} samples, wt=[${real.capabilities.weightTypes.join(',')}]` : why);
} catch (e) {
  check('real go.pprof: pprof→OTLP→model preserves the name-path distribution', false, `setup error: ${(e as Error).message}`);
}

console.log(`\notlp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
