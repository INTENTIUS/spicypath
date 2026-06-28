// Scene → Brendan Gregg folded/collapsed stacks: "rootFunc;...;leafFunc count\n".
// Aggregates by stack path. (Lossy on names containing ';' — a real format limit.)
export function emitFolded(scene) {
  const m = new Map();
  for (const s of scene.samples) { const k = s.stack.join(';'); m.set(k, (m.get(k) || 0) + s.weight); }
  let out = '';
  for (const [k, v] of m) out += `${k} ${Math.round(v)}\n`;
  return out;
}
