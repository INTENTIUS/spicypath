// FG-025 pass 3 — windowed re-aggregation for metric-brush.
// Pure JS, no DOM — importable by Node tests and the browser renderer alike.
//
// aggregateWindow(profile, threadIndex, weightType, t0, t1)
//   Returns { funcs, windowTotal } where funcs is an array of
//   { func, name, self, totalFrac } sorted descending by self.
//
// Half-open interval: sample at t0 is INCLUDED, sample at t1 is EXCLUDED.
// Only the LEAF frame (the stack node referenced by samples.stack[i]) is
// credited self weight — same convention as buildCallNodeTable.

import { funcName } from './colors.js';

/**
 * @param {object} profile  canonical Profile
 * @param {number} threadIndex
 * @param {string} weightType
 * @param {number} t0  window start (inclusive)
 * @param {number} t1  window end   (exclusive)
 * @returns {{ funcs: Array<{func:number, name:string, self:number, totalFrac:number}>, windowTotal: number }}
 */
export function aggregateWindow(profile, threadIndex, weightType, t0, t1) {
  const thread = profile.threads[threadIndex];
  const { stack: stacks, time: times, weightsByType } = thread.samples;
  const weights = weightsByType[weightType] || [];
  const n = stacks.length;

  // func index → accumulated self weight within the window
  const selfByFunc = new Map();
  let windowTotal = 0;

  for (let i = 0; i < n; i++) {
    const t = times ? times[i] : 0;
    // half-open: include t0, exclude t1
    if (t < t0 || t >= t1) continue;
    const s = stacks[i];
    if (s < 0) continue;
    // leaf frame's function gets the self credit
    const frame = profile.stackTable.frame[s];
    const func = profile.frameTable.func[frame];
    const w = weights[i] || 0;
    selfByFunc.set(func, (selfByFunc.get(func) || 0) + w);
    windowTotal += w;
  }

  const wt = windowTotal || 1; // avoid division by zero
  const funcs = [...selfByFunc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([func, self]) => ({
      func,
      name: funcName(profile, func),
      self,
      totalFrac: self / wt,
    }));

  return { funcs, windowTotal };
}
