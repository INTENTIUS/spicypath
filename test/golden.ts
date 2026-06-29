// Golden round-trip: Scene → emit(format) → parse(format) → canonical model, then assert
// the call-tree distribution matches the Scene. Fractions (not absolute weights) so unit
// differences (e.g. cpuprofile's µs→ns) cancel. Also writes inspectable fixtures.
//   node test/golden.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { PRESETS, sceneFractions } from './scene.js';
import { emitFolded } from './emit/emit-folded.js';
import { emitSpeedscope } from './emit/emit-speedscope.js';
import { emitSpeedscopeEvented } from './emit/emit-speedscope-evented.js';
import { emitCpuprofile } from './emit/emit-cpuprofile.js';
import { emitPprof } from './emit/emit-pprof.js';
import { emitOtlp } from './emit/emit-otlp.js';
import { emitPerfScript } from './emit/emit-perf.js';
import { parseFolded } from './parse-folded.ts';
import { parsePerf } from './parse-perf.ts';
import { parseSpeedscope } from './parse-speedscope.ts';
import { parseCpuProfile } from './parse-cpuprofile.ts';
import { parsePprof } from './parse-pprof.ts';
import { parseOtlp } from './parse-otlp.ts';
import type { Profile } from '../src/model.ts';

mkdirSync('test/testdata', { recursive: true });

function stackPath(p: Profile, s: number): string {
  const names: string[] = [];
  let n = s;
  while (n >= 0) { names.push(p.stringTable[p.funcTable.name[p.frameTable.func[p.stackTable.frame[n]]]]); n = p.stackTable.prefix[n]; }
  names.reverse();
  if (names[0] === '(root)') names.shift(); // V8 .cpuprofile wraps everything in a synthetic root
  return names.join(';');
}
function modelFractions(p: Profile): Map<string, number> {
  const t = p.threads[0];
  const col = t.samples.weightsByType[p.capabilities.weightTypes[0]] || [];
  const m = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < t.samples.stack.length; i++) { const k = stackPath(p, t.samples.stack[i]); const w = col[i] || 0; m.set(k, (m.get(k) || 0) + w); total += w; }
  const f = new Map<string, number>();
  for (const [k, v] of m) f.set(k, v / (total || 1));
  return f;
}
function diff(expected: Map<string, number>, actual: Map<string, number>): string | null {
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  for (const k of keys) {
    const a = expected.get(k) ?? -1, b = actual.get(k) ?? -1;
    if (a < 0) return `extra path: ${k}`;
    if (b < 0) return `missing path: ${k}`;
    if (Math.abs(a - b) > 1e-6) return `weight mismatch at ${k}: ${a.toFixed(6)} vs ${b.toFixed(6)}`;
  }
  return null;
}

const FORMATS = [
  { ext: 'folded', emit: emitFolded, parse: parseFolded, binary: false },
  { ext: 'speedscope.json', emit: emitSpeedscope, parse: parseSpeedscope, binary: false },
  { ext: 'evt.speedscope.json', emit: emitSpeedscopeEvented, parse: parseSpeedscope, binary: false },
  { ext: 'cpuprofile', emit: emitCpuprofile, parse: parseCpuProfile, binary: false },
  { ext: 'pprof', emit: emitPprof, parse: parsePprof, binary: true },
  { ext: 'otlp', emit: emitOtlp, parse: parseOtlp, binary: true },
  { ext: 'perf', emit: emitPerfScript, parse: parsePerf, binary: false },
];

let pass = 0, fail = 0;
for (const scene of PRESETS) {
  const expected = sceneFractions(scene);
  const notes: string[] = [];
  for (const fmt of FORMATS) {
    const path = `test/testdata/${scene.name}.${fmt.ext}`;
    const data = fmt.emit(scene as any);
    writeFileSync(path, fmt.binary ? Buffer.from(data as Uint8Array) : (data as string));
    let line = `  ${fmt.ext.padEnd(16)} `;
    try {
      const prof = fmt.parse(path);
      const d = diff(expected, modelFractions(prof));
      // capability checks
      const caps: string[] = [];
      if (fmt.ext === 'cpuprofile' && !prof.capabilities.hasTiming) caps.push('expected hasTiming');
      if ((fmt.ext === 'pprof' || fmt.ext === 'otlp') && scene.weightTypes.length > 1 && prof.capabilities.weightTypes.length < 2) caps.push('expected multi-value');
      if (d || caps.length) { fail++; line += `FAIL ${d || ''} ${caps.join('; ')}`; }
      else { pass++; line += `ok (${prof.threads[0].samples.stack.length} samp, hasTiming=${prof.capabilities.hasTiming}, wt=[${prof.capabilities.weightTypes.join(',')}])`; }
    } catch (e) { fail++; line += `ERROR ${(e as Error).message}`; }
    notes.push(line);
  }
  console.log(`\n● ${scene.name}  (${scene.samples.length} samples, ${expected.size} unique paths)`);
  for (const n of notes) console.log(n);
}
console.log(`\ngolden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
