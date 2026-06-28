// Render the real parsed profiles through the pure layout → SVG (headless proof), and
// emit the canonical model as JSON (the wire format the browser renderer fetches).
//   node test/verify.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { parsePprof } from './parse-pprof.ts';
import { parseCpuProfile } from './parse-cpuprofile.ts';
import { buildCallNodeTable } from '../src/callnode.js';
import { layout } from '../src/layout.js';
import { buildFlameChart, chartLayout } from '../src/flamechart.js';
import { buildSandwich } from '../src/sandwich.js';
import { renderSVG, renderSandwichSVG, renderChartMinimapSVG } from '../src/render-svg.js';
import { parseSpeedscope } from './parse-speedscope.ts';
import { existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Profile } from '../src/model.ts';

mkdirSync('test/out', { recursive: true });
const W = 1000;

const maxDepth = (bs: { depth: number }[]): number => { let m = 0; for (const b of bs) if (b.depth > m) m = b.depth; return m; };

function emit(label: string, p: Profile, base: string): void {
  const wt = p.capabilities.weightTypes.includes('cpu_nanos') ? 'cpu_nanos' : p.capabilities.weightTypes[0];
  const ct = buildCallNodeTable(p, 0, wt);
  const flat = layout(ct, { width: W, minWidth: 0.5 });
  const coll = layout(ct, { width: W, minWidth: 0.5, collapse: true });
  writeFileSync(`test/out/${base}.svg`, renderSVG(coll, p, { width: W, title: `${label} — flame graph, auto-collapsed (${wt}) · ${coll.length} boxes` }));
  writeFileSync(`test/out/${base}-flat.svg`, renderSVG(flat, p, { width: W, title: `${label} — flame graph, flat (${wt}) · ${flat.length} boxes` }));
  console.log(`${base}: ${ct.frame.length} call-nodes → graph boxes ${flat.length}→${coll.length} (collapsed), maxDepth ${maxDepth(flat)}→${maxDepth(coll)}`);

  // Left-Heavy minimap proof: aggregated overview + a fraction crop window (x = 30%–70%)
  let gmd = 0; for (const b of coll) if (b.depth > gmd) gmd = b.depth;
  const gwin: [number, number] = [0.3, 0.7];
  const gCrop = layout(ct, { width: W, minWidth: 0.5, collapse: true, winFrac: gwin });
  writeFileSync(`test/out/${base}-graph-minimap.svg`, renderChartMinimapSVG(coll, gmd, gCrop, p, { width: W, win: gwin, start: 0, end: 1, title: `${label} — Aggregated + minimap crop (x = 30%–70%)` }));

  // search proof: query "fib"
  const re = /fib/i;
  const matched = new Set<number>();
  for (let f = 0; f < p.funcTable.name.length; f++) if (re.test(p.stringTable[p.funcTable.name[f]] || '')) matched.add(f);
  writeFileSync(`test/out/${base}-search.svg`, renderSVG(coll, p, { width: W, title: `${label} — search "fib" · ${matched.size} fns matched`, matched }));
  console.log(`  ${base} search "fib": ${matched.size} functions matched`);

  // sandwich proof: focal = a function with branching callees
  let focal = -1;
  for (let f = 0; f < p.funcTable.name.length; f++) if ((p.stringTable[p.funcTable.name[f]] || '').includes('handleRequest')) { focal = f; break; }
  if (focal >= 0) {
    const sw = buildSandwich(p, ct, focal);
    const cb = layout(sw.callers, { width: W, minWidth: 0.5 });
    const eb = layout(sw.callees, { width: W, minWidth: 0.5 });
    const name = p.stringTable[p.funcTable.name[focal]];
    writeFileSync(`test/out/${base}-sandwich.svg`, renderSandwichSVG(cb, eb, p, { width: W, focalName: name, title: `${label} — sandwich: ${name} (${sw.occurrences} occ)` }));
    console.log(`  ${base} sandwich "${name}": ${sw.occurrences} occ → ${cb.length} caller + ${eb.length} callee boxes`);
  }

  if (p.capabilities.hasTiming) {
    const chart = buildFlameChart(p, 0);
    const cb = chartLayout(chart, p, { width: W, minWidth: 0.5 });
    writeFileSync(`test/out/${base}-chart.svg`, renderSVG(cb, p, { width: W, title: `${label} — flame CHART (time-ordered) · ${cb.length} boxes` }));
    console.log(`  ${base} chart: ${chart.spans.length} time-spans → ${cb.length} chart boxes`);
    // minimap crop proof: window = middle 30%
    const mini = chartLayout(chart, p, { width: W, minWidth: 0.5, winStart: chart.start, winEnd: chart.end });
    let mmd = 0; for (const b of mini) if (b.depth > mmd) mmd = b.depth;
    const span = chart.end - chart.start; const win: [number, number] = [chart.start + span * 0.3, chart.start + span * 0.6];
    const cw = chartLayout(chart, p, { width: W, minWidth: 0.5, winStart: win[0], winEnd: win[1] });
    writeFileSync(`test/out/${base}-minimap.svg`, renderChartMinimapSVG(mini, mmd, cw, p, { width: W, win, start: chart.start, end: chart.end, title: `${label} — chart + minimap crop (window = middle 30%)` }));
  } else {
    console.log(`  ${base} chart: n/a (aggregated, no per-sample time)`);
  }
}

emit('Go pprof', parsePprof('test/data/go.pprof'), 'go');
emit('V8 .cpuprofile', parseCpuProfile('test/data/node.cpuprofile'), 'node');

// real-world evented speedscope export (FG-018): prove the actual Downloads file loads
const real = `${homedir()}/Downloads/perf_vertx_stacks_01_collapsed_all.speedscope.json`;
if (existsSync(real)) {
  copyFileSync(real, 'test/testdata/real-vertx.speedscope.json');
  const p = parseSpeedscope('test/testdata/real-vertx.speedscope.json');
  const ct = buildCallNodeTable(p, 0, p.capabilities.weightTypes[0]);
  const boxes = layout(ct, { width: W, minWidth: 0.5, collapse: true });
  writeFileSync('test/out/real-vertx.svg', renderSVG(boxes, p, { width: W, title: `real perf→speedscope (evented) · ${boxes.length} boxes, ${ct.frame.length} nodes` }));
  console.log(`real-vertx: evented, ${p.threads[0].samples.stack.length} samples, hasTiming=${p.capabilities.hasTiming} → ${boxes.length} boxes`);
}

console.log('wrote test/out/*.svg (proofs)');
