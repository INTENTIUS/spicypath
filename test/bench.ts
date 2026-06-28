// Scale benchmark (renderer-baseline.md §8): how do model-build and layout scale with N,
// and does sub-pixel pruning keep the drawn box count bounded regardless of N?
//   node test/bench.ts
import { ProfileBuilder } from '../src/model.js';
import { buildCallNodeTable } from '../src/callnode.js';
import { layout } from '../src/layout.js';
import type { Profile } from '../src/model.ts';

function gen(nSamples: number, depth: number, vocab: number): Profile {
  const b = new ProfileBuilder();
  const frames: number[] = [];
  for (let i = 0; i < vocab; i++) frames.push(b.internFrame(b.internFunc(b.internString(`pkg${i % 8}.fn${i}`), -1, -1), -1, 0));
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const stack: number[] = [], w: number[] = [];
  for (let s = 0; s < nSamples; s++) {
    let prefix = -1; const d = 2 + ((rnd() * depth) | 0);
    for (let k = 0; k < d; k++) prefix = b.internStack(frames[(rnd() * vocab) | 0], prefix);
    stack.push(prefix); w.push(1 + ((rnd() * 5) | 0));
  }
  return b.finish([{ name: 'b', samples: { stack, weightsByType: { cpu_nanos: w }, time: null } }], { hasTiming: false, weightTypes: ['cpu_nanos'], isDiff: false });
}

const W = 1400;
console.log(`width=${W}px, minWidth=0.5px (sub-pixel pruning)`);
for (const [N, depth, vocab] of [[10_000, 20, 200], [100_000, 30, 400], [1_000_000, 40, 800]] as const) {
  const t0 = performance.now(); const p = gen(N, depth, vocab); const t1 = performance.now();
  const ct = buildCallNodeTable(p, 0, 'cpu_nanos'); const t2 = performance.now();
  const boxes = layout(ct, { width: W, minWidth: 0.5, collapse: true }); const t3 = performance.now();
  const fmt = (x: number) => String(Math.round(x)).padStart(5);
  console.log(`N=${String(N).padStart(9)}  callNodes=${String(ct.func.length).padStart(8)}  drawnBoxes=${String(boxes.length).padStart(5)}   gen=${fmt(t1 - t0)}ms  build=${fmt(t2 - t1)}ms  layout=${fmt(t3 - t2)}ms`);
}
