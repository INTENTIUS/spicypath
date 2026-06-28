// Scene → `perf script` text. Monotonic timestamps; period field carries the weight;
// frames emitted leaf-first (perf convention). Round-trips through parse-perf.
export function emitPerfScript(scene) {
  let out = '', t = 0;
  for (const s of scene.samples) {
    t += 0.001;
    out += `app 0 [000] ${t.toFixed(6)}: ${Math.round(s.weight)} cpu-clock:\n`;
    for (let i = s.stack.length - 1; i >= 0; i--) out += `\t0 ${s.stack[i]} (app.so)\n`;
    out += '\n';
  }
  return out;
}
