// Export a canonical Profile back to portable formats (reuses the model; round-trippable).
// Pure (browser + Node).
import { buildCallNodeTable } from './callnode.js';
import { functionStats } from './funcstats.js';

function pathFuncs(p, s) { const out = []; let n = s; while (n >= 0) { out.push(p.frameTable.func[p.stackTable.frame[n]]); n = p.stackTable.prefix[n]; } return out.reverse(); }

// Weight-type-aware value formatter — mirrors BaseView._fmtWeight/_fmtSeconds/_fmtBytes/_fmtCount
// in render-canvas.js but is self-contained so exportMarkdown stays pure (no DOM).
function fmtSeconds(s) {
  const a = Math.abs(s);
  if (a < 1e-6) return (s * 1e9).toFixed(0) + 'ns';
  if (a < 1e-3) return (s * 1e6).toFixed(a < 1e-4 ? 1 : 0) + 'µs';
  if (a < 1) return (s * 1e3).toFixed(a < 1e-2 ? 1 : 0) + 'ms';
  return s.toFixed(a < 10 ? 2 : 1) + 's';
}
function fmtCount(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'G';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return '' + Math.round(v);
}
function fmtBytes(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'GB';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'MB';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'KB';
  return Math.round(v) + 'B';
}
export function fmtWeight(weightType, v) {
  const wt = (weightType || '').toLowerCase();
  if (/nanos|nanosecond/.test(wt)) return fmtSeconds(v * 1e-9);
  if (/microsecond/.test(wt)) return fmtSeconds(v * 1e-6);
  if (/millisecond/.test(wt)) return fmtSeconds(v * 1e-3);
  if (/\bseconds?\b/.test(wt)) return fmtSeconds(v);
  if (/bytes/.test(wt)) return fmtBytes(v);
  return fmtCount(v) + ' ' + (weightType || 'samples');
}
// Human-readable unit label for the header line.
function unitLabel(weightType) {
  const wt = (weightType || '').toLowerCase();
  if (/nanos|nanosecond/.test(wt)) return 'time (ns raw)';
  if (/microsecond/.test(wt)) return 'time (µs raw)';
  if (/millisecond/.test(wt)) return 'time (ms raw)';
  if (/\bseconds?\b/.test(wt)) return 'time (s)';
  if (/bytes/.test(wt)) return 'bytes';
  return weightType || 'samples';
}

export function exportFolded(p, weightType) {
  const wt = weightType || p.capabilities.weightTypes[0];
  const t = p.threads[0], col = t.samples.weightsByType[wt] || [];
  const m = new Map();
  for (let i = 0; i < t.samples.stack.length; i++) {
    const key = pathFuncs(p, t.samples.stack[i]).map((f) => p.stringTable[p.funcTable.name[f]]).join(';');
    m.set(key, (m.get(key) || 0) + (col[i] || 0));
  }
  let out = '';
  for (const [k, v] of m) out += `${k} ${Math.round(v)}\n`;
  return out;
}

export function exportSpeedscope(p, weightType) {
  const wt = weightType || p.capabilities.weightTypes[0];
  const t = p.threads[0], col = t.samples.weightsByType[wt] || [];
  const frames = [], fmap = new Map();
  const fi = (func) => { let i = fmap.get(func); if (i === undefined) { i = frames.length; const fr = { name: p.stringTable[p.funcTable.name[func]] || '' }; const fl = p.funcTable.file[func]; if (fl >= 0 && p.stringTable[fl]) fr.file = p.stringTable[fl]; frames.push(fr); fmap.set(func, i); } return i; };
  const unit = wt.includes('nanos') ? 'nanoseconds' : 'none';
  const stacks = t.samples.stack, n = stacks.length;

  // Timed source → emit an `evented` profile so Timeline survives the round-trip (a
  // `sampled` profile carries no per-sample time, so re-import loses hasTiming). We lay the
  // samples on a contiguous time axis synthesized from their weights — speedscope's own
  // model for ordered samples — by diffing consecutive stacks into O/C events. Each sample k
  // occupies [cum, cum+w_k], so re-import recovers its (stack, weight) exactly while gaining
  // a chronological flame chart.
  if (p.capabilities.hasTiming && n > 0) {
    const events = [], open = []; // open = funcs root→leaf currently on the stack
    let cum = 0;
    for (let k = 0; k < n; k++) {
      const F = pathFuncs(p, stacks[k]), at = cum;
      let d = 0; while (d < open.length && d < F.length && open[d] === F[d]) d++;
      for (let j = open.length - 1; j >= d; j--) events.push({ type: 'C', frame: fi(open[j]), at });
      for (let j = d; j < F.length; j++) events.push({ type: 'O', frame: fi(F[j]), at });
      open.length = 0; for (const f of F) open.push(f);
      cum += col[k] || 0;
    }
    for (let j = open.length - 1; j >= 0; j--) events.push({ type: 'C', frame: fi(open[j]), at: cum });
    return JSON.stringify({
      $schema: 'https://www.speedscope.app/file-format-schema.json',
      shared: { frames },
      profiles: [{ type: 'evented', name: 'export', unit, startValue: 0, endValue: cum, events }],
    });
  }

  // Aggregated source → `sampled` (no time to preserve; stays hasTiming:false on re-import).
  const samples = [], weights = [];
  for (let i = 0; i < n; i++) { samples.push(pathFuncs(p, stacks[i]).map(fi)); weights.push(col[i] || 0); }
  return JSON.stringify({
    $schema: 'https://www.speedscope.app/file-format-schema.json',
    shared: { frames },
    profiles: [{ type: 'sampled', name: 'export', unit, startValue: 0, endValue: weights.reduce((a, b) => a + b, 0), samples, weights }],
  });
}

// Markdown hotspot report (FG-045).
// opts: { topN?: number (default 50), hotStacks?: number (default 10, 0 to suppress) }
export function exportMarkdown(p, weightType, opts) {
  const wt = weightType || p.capabilities.weightTypes[0];
  const { topN = 50, hotStacks = 10 } = opts || {};
  const ct = buildCallNodeTable(p, 0, wt);
  const stats = functionStats(ct, p);
  const gt = ct.grandTotal || 1;
  const t = p.threads[0];
  const sampleCount = t.samples.stack.length;
  const funcCount = stats.length;

  const fmt = (v) => fmtWeight(wt, v);
  const pct = (v) => (gt ? ((v / gt) * 100).toFixed(1) : '0.0') + '%';

  // ---- Header ----
  const lines = [];
  lines.push(`# Profile hotspot report`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Weight type | ${wt} (${unitLabel(wt)}) |`);
  lines.push(`| Grand total | ${fmt(ct.grandTotal)} |`);
  lines.push(`| Samples | ${sampleCount} |`);
  lines.push(`| Functions | ${funcCount} |`);
  lines.push('');

  // ---- Top functions table ----
  const topFuncs = stats.slice(0, topN);
  lines.push(`## Top functions (by self)`);
  lines.push('');
  lines.push(`| Rank | Function | Self | Self % | Total | Total % | Location |`);
  lines.push(`|---:|---|---:|---:|---:|---:|---|`);
  for (let i = 0; i < topFuncs.length; i++) {
    const s = topFuncs[i];
    const loc = (s.file && s.file !== '' && s.line >= 0) ? `${s.file}:${s.line}` : (s.file || '');
    lines.push(`| ${i + 1} | \`${s.name || '(anon)'}\` | ${fmt(s.self)} | ${pct(s.self)} | ${fmt(s.total)} | ${pct(s.total)} | ${loc} |`);
  }
  lines.push('');

  // ---- Hottest stacks (top-K leaf call paths by self weight) ----
  if (hotStacks > 0) {
    // Collect self weight per leaf call-node path (root→leaf names joined by ' > ').
    const pathMap = new Map();
    const col = t.samples.weightsByType[wt] || [];
    for (let i = 0; i < t.samples.stack.length; i++) {
      const s = t.samples.stack[i];
      if (s < 0) continue;
      const w = col[i] || 0;
      if (!w) continue;
      const names = pathFuncs(p, s).map((f) => p.stringTable[p.funcTable.name[f]] || '(anon)');
      const key = names.join(' > ');
      pathMap.set(key, (pathMap.get(key) || 0) + w);
    }
    const sorted = [...pathMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, hotStacks);
    if (sorted.length > 0) {
      lines.push(`## Hottest stacks (root > ... > leaf)`);
      lines.push('');
      lines.push(`| Rank | Self | Self % | Stack |`);
      lines.push(`|---:|---:|---:|---|`);
      for (let i = 0; i < sorted.length; i++) {
        const [path, w] = sorted[i];
        lines.push(`| ${i + 1} | ${fmt(w)} | ${pct(w)} | \`${path}\` |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
