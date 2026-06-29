// Flame CHART (time-ordered): x = real time, stacks NOT merged. Built from per-sample
// data by walking samples left→right and extending boxes whose frames match the previous
// sample at the same depth (speedscope-style). Requires hasTiming. Pure JS, shared.

// Frames of a stack index, root→leaf (memoized).
function framesOf(p, s, cache) {
  let f = cache.get(s);
  if (!f) { f = []; let n = s; while (n >= 0) { f.push(p.stackTable.frame[n]); n = p.stackTable.prefix[n]; } f.reverse(); cache.set(s, f); }
  return f;
}

// Returns { spans:[{frame, depth, x0, x1}], start, end, maxDepth } in the time domain.
// FG-053: threadIndex may be a number or a Thread object (e.g. mergedThread result).
export function buildFlameChart(p, threadIndex) {
  const t = (typeof threadIndex === 'object' && threadIndex !== null) ? threadIndex : p.threads[threadIndex];
  const stacks = t.samples.stack, time = t.samples.time;
  if (!time || stacks.length === 0) return null;
  const n = stacks.length;
  const cache = new Map();
  const spans = [];
  const open = []; // index = depth → { frame, x0 }
  const start = time[0];
  let end = start;

  for (let k = 0; k < n; k++) {
    const f = framesOf(p, stacks[k], cache);
    const t0 = time[k];
    const t1 = k < n - 1 ? time[k + 1] : time[k] + (n > 1 ? time[k] - time[k - 1] : 1); // forward interval
    end = t1;
    // shared prefix depth between currently-open boxes and this sample's frames
    let d = 0;
    while (d < open.length && d < f.length && open[d].frame === f[d]) d++;
    // close boxes deeper than the divergence point (they ended at t0)
    for (let j = open.length - 1; j >= d; j--) spans.push({ frame: open[j].frame, depth: j, x0: open[j].x0, x1: t0 });
    open.length = d;
    // open new boxes from the divergence point down
    for (let j = d; j < f.length; j++) open.push({ frame: f[j], x0: t0 });
  }
  for (let j = open.length - 1; j >= 0; j--) spans.push({ frame: open[j].frame, depth: j, x0: open[j].x0, x1: end });

  let maxDepth = 0;
  for (const s of spans) if (s.depth > maxDepth) maxDepth = s.depth;
  return { spans, start, end, maxDepth };
}

// Time spans → pixel boxes for a [winStart,winEnd] window (zoom). Same box shape as the
// graph layout (func/depth/x/w) so the SVG/Canvas paint is reused; plus frame/t0/t1.
export function chartLayout(chart, p, opts) {
  const width = opts.width;
  const minWidth = opts.minWidth == null ? 0.5 : opts.minWidth;
  const winStart = opts.winStart == null ? chart.start : opts.winStart;
  const winEnd = opts.winEnd == null ? chart.end : opts.winEnd;
  const span = winEnd - winStart;
  if (span <= 0) return [];
  const px = width / span;
  const boxes = [];
  for (const s of chart.spans) {
    const x0 = Math.max(s.x0, winStart), x1 = Math.min(s.x1, winEnd);
    if (x1 <= x0) continue; // outside the window
    const w = (x1 - x0) * px;
    if (w < minWidth) continue;
    boxes.push({ func: p.frameTable.func[s.frame], depth: s.depth, x: (x0 - winStart) * px, w, frame: s.frame, t0: s.x0, t1: s.x1 });
  }
  return boxes;
}
