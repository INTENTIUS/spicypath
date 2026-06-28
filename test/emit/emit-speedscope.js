// Scene → speedscope's own "sampled" JSON format. Each sample is an array of frame
// indices ordered root→leaf (per the speedscope file-format spec).
export function emitSpeedscope(scene) {
  const frames = [];
  const idx = new Map();
  const fi = (name) => { let i = idx.get(name); if (i === undefined) { i = frames.length; frames.push({ name }); idx.set(name, i); } return i; };
  const samples = [];
  const weights = [];
  for (const s of scene.samples) { samples.push(s.stack.map(fi)); weights.push(s.weight); }
  const endValue = weights.reduce((a, b) => a + b, 0);
  return JSON.stringify({
    $schema: 'https://www.speedscope.app/file-format-schema.json',
    shared: { frames },
    profiles: [{ type: 'sampled', name: scene.name, unit: 'none', startValue: 0, endValue, samples, weights }],
  });
}
