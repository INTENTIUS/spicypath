// Scene → speedscope "evented" JSON (O/C open/close events). Walks samples left→right,
// closing diverged frames and opening new ones at each time boundary (the flame-chart
// construction, emitted as events). Round-trips through parse-speedscope's evented branch.
export function emitSpeedscopeEvented(scene) {
  const frames = [];
  const idx = new Map();
  const fi = (name) => { let i = idx.get(name); if (i === undefined) { i = frames.length; frames.push({ name }); idx.set(name, i); } return i; };
  const events = [];
  const open = []; // frame indices
  let t = 0;
  for (const s of scene.samples) {
    const f = s.stack.map(fi);
    let d = 0;
    while (d < open.length && d < f.length && open[d] === f[d]) d++;
    for (let j = open.length - 1; j >= d; j--) events.push({ type: 'C', frame: open[j], at: t });
    open.length = d;
    for (let j = d; j < f.length; j++) { events.push({ type: 'O', frame: f[j], at: t }); open.push(f[j]); }
    t += s.weight;
  }
  for (let j = open.length - 1; j >= 0; j--) events.push({ type: 'C', frame: open[j], at: t });
  return JSON.stringify({
    $schema: 'https://www.speedscope.app/file-format-schema.json',
    shared: { frames },
    profiles: [{ type: 'evented', name: scene.name, unit: 'none', startValue: 0, endValue: t, events }],
  });
}
