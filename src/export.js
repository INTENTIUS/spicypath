// Export a canonical Profile back to portable formats (reuses the model; round-trippable).
// Pure (browser + Node).

function pathFuncs(p, s) { const out = []; let n = s; while (n >= 0) { out.push(p.frameTable.func[p.stackTable.frame[n]]); n = p.stackTable.prefix[n]; } return out.reverse(); }

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
