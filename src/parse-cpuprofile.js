// V8 .cpuprofile (text) → canonical model (timed plane). Pure (browser + Node).
import { ProfileBuilder } from './model.js';

export function parseCpuProfileText(text) {
  const j = JSON.parse(text);
  const b = new ProfileBuilder();

  const parent = new Map();
  for (const n of j.nodes) if (n.children) for (const c of n.children) parent.set(c, n.id);

  const frameOf = new Map();
  for (const n of j.nodes) {
    const cf = n.callFrame;
    const fn = b.internFunc(b.internString(cf.functionName || '(anonymous)'), b.internString(cf.url || ''), cf.lineNumber == null ? -1 : cf.lineNumber);
    frameOf.set(n.id, b.internFrame(fn, cf.lineNumber == null ? -1 : cf.lineNumber, 0));
  }

  const stackOf = new Map();
  const stackForNode = (id) => {
    const cached = stackOf.get(id);
    if (cached !== undefined) return cached;
    const p = parent.get(id);
    const prefix = p === undefined ? -1 : stackForNode(p);
    const s = b.internStack(frameOf.get(id), prefix);
    stackOf.set(id, s);
    return s;
  };
  for (const n of j.nodes) stackForNode(n.id);

  const stack = [], cpu_nanos = [], time = [];
  let cur = j.startTime || 0;
  const samples = j.samples || [], deltas = j.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    const d = deltas[i] || 0;
    cur += d;
    const st = stackOf.get(samples[i]);
    if (st === undefined) continue;
    stack.push(st); cpu_nanos.push(d * 1000); time.push(cur);
  }
  return b.finish([{ name: 'Main', samples: { stack, weightsByType: { cpu_nanos }, time } }], { hasTiming: true, weightTypes: ['cpu_nanos'], timeUnit: 'microseconds', isDiff: false });
}
