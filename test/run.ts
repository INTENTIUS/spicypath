// Validation spike: parse REAL pprof + .cpuprofile into the canonical model, check
// invariants, and prove both planes (aggregated graph vs timed chart).
//   node test/run.ts
import { parseCpuProfile } from './parse-cpuprofile.ts';
import { parsePprof } from './parse-pprof.ts';
import { checkInvariants } from '../src/model.js';
import type { Profile } from '../src/model.ts';

function maxDepth(p: Profile): number {
  const d = new Array<number>(p.stackTable.frame.length);
  let max = 0;
  for (let i = 0; i < d.length; i++) { const pf = p.stackTable.prefix[i]; d[i] = pf < 0 ? 1 : d[pf] + 1; if (d[i] > max) max = d[i]; }
  return max;
}

function topSelf(p: Profile, type: string, n = 6): { name: string; w: number }[] {
  const t = p.threads[0], col = t.samples.weightsByType[type];
  const m = new Map<number, number>();
  for (let i = 0; i < t.samples.stack.length; i++) {
    const st = t.samples.stack[i];
    if (st < 0) continue;
    const fn = p.frameTable.func[p.stackTable.frame[st]];
    m.set(fn, (m.get(fn) || 0) + (col ? col[i] : 0));
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([fn, w]) => ({ name: p.stringTable[p.funcTable.name[fn]] || '(anon)', w }));
}

function reportOne(label: string, p: Profile): boolean {
  const errs = checkInvariants(p);
  const t = p.threads[0];
  console.log(`\n=== ${label} ===`);
  console.log(`  tables : strings=${p.stringTable.length} funcs=${p.funcTable.name.length} frames=${p.frameTable.func.length} stacks=${p.stackTable.frame.length}`);
  console.log(`  samples: ${t.samples.stack.length}   maxDepth=${maxDepth(p)}`);
  console.log(`  caps   : hasTiming=${p.capabilities.hasTiming}  weightTypes=[${p.capabilities.weightTypes.join(', ')}]  isDiff=${p.capabilities.isDiff}`);
  console.log(`  views  : graph=YES  chart=${p.capabilities.hasTiming ? 'YES' : 'no (aggregated)'}  multiValue=${p.capabilities.weightTypes.length > 1 ? 'YES' : 'no'}`);
  console.log(`  inlined frames (inlineDepth>0): ${p.frameTable.inlineDepth.filter((d) => d > 0).length}`);
  const at = p.capabilities.weightTypes[0];
  console.log(`  top self by ${at}:`);
  for (const f of topSelf(p, at)) console.log(`     ${String(f.w).padStart(12)}  ${f.name}`);
  console.log(`  invariants: ${errs.length ? `❌ ${errs.length} violation(s)\n    - ${errs.slice(0, 6).join('\n    - ')}` : 'all pass ✓'}`);
  return errs.length === 0;
}

let ok = true;
ok = reportOne('Go pprof  (aggregated, multi-value, no timing)', parsePprof('test/data/go.pprof')) && ok;
ok = reportOne('V8 .cpuprofile  (timed → flame chart capable)', parseCpuProfile('test/data/node.cpuprofile')) && ok;
console.log(`\nspike ${ok ? 'PASSED ✓ — model represents both planes from real data' : 'FAILED ✗'}`);
process.exit(ok ? 0 : 1);
