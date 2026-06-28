// Round-trip: parse a fixture → export (speedscope/folded) → re-parse → assert the
// call-tree distribution is unchanged.  node test/export-test.ts
import { readFileSync } from 'node:fs';
import { ingestBytes } from '../src/ingest.js';
import { exportSpeedscope, exportFolded } from '../src/export.js';
import { parseSpeedscopeText } from '../src/parse-speedscope.js';
import { parseFoldedText } from '../src/parse-folded.js';
import type { Profile } from '../src/model.ts';

function fractions(p: Profile): Map<string, number> {
  const t = p.threads[0], wt = p.capabilities.weightTypes[0], col = t.samples.weightsByType[wt] || [];
  const m = new Map<string, number>(); let tot = 0;
  for (let i = 0; i < t.samples.stack.length; i++) {
    const names: string[] = []; let n = t.samples.stack[i];
    while (n >= 0) { names.push(p.stringTable[p.funcTable.name[p.frameTable.func[p.stackTable.frame[n]]]]); n = p.stackTable.prefix[n]; }
    const k = names.reverse().join(';'); const w = col[i] || 0; m.set(k, (m.get(k) || 0) + w); tot += w;
  }
  const f = new Map<string, number>(); for (const [k, v] of m) f.set(k, v / (tot || 1)); return f;
}
function same(a: Map<string, number>, b: Map<string, number>): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) if (Math.abs((a.get(k) ?? -1) - (b.get(k) ?? -1)) > 1e-6) return false;
  return true;
}

const fixtures = ['tiny.cpuprofile', 'deep-recursion.pprof', 'wide-fanout.folded', 'multi-value.pprof', 'real-vertx.speedscope.json'];
let pass = 0, fail = 0;
for (const fx of fixtures) {
  const orig = await ingestBytes(fx, new Uint8Array(readFileSync(`test/testdata/${fx}`)));
  const want = fractions(orig);
  const ss = same(want, fractions(parseSpeedscopeText(exportSpeedscope(orig))));
  const fd = same(want, fractions(parseFoldedText(exportFolded(orig))));
  const ok = ss && fd; (ok ? pass++ : fail++);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${fx.padEnd(32)} speedscope=${ss} folded=${fd}`);
}
console.log(`\nexport round-trip: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
