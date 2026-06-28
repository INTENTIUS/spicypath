// Semantic color: hue = module/package (not a random per-function hash). Colors are derived
// from the ACTIVE theme (FG-040) — the categorical hues come from the theme's terminal
// palette, so switching theme recolors every frame. Pure JS, shared by Node verifier and
// browser renderer.
import { getTokens, hexToOklch, oklchToHex, mix } from './theme.js';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export function funcName(p, func) { return p.stringTable[p.funcTable.name[func]] || ''; }
export function funcFile(p, func) { const i = p.funcTable.file[func]; return i >= 0 ? (p.stringTable[i] || '') : ''; }

// Derive a "module" from a frame name across the common conventions:
//   path/colon style (JVM/perf):  "org/mozilla/javascript/ScriptableObject:get(...)" → "org/mozilla/javascript"
//   dot style (Go/native):        "runtime.kevent" / "main.(*T).M"                     → "runtime" / "main"
//   else fall back to the file's basename, else "(app)".
export function packageOf(name, file) {
  if (!name) return '(anon)';
  if (name.includes('/')) {
    // strip the method/args (after ':' , '(' , or whitespace), then drop the class (last path segment)
    const cut = name.search(/[:( ]/);
    const sym = cut > 0 ? name.slice(0, cut) : name;
    const slash = sym.lastIndexOf('/');
    if (slash > 0) return sym.slice(0, slash);
  }
  const d = name.indexOf('.');
  if (d > 0) return name.slice(0, d);
  if (file) { const b = file.split('/').pop() || file; return b.replace(/\.[a-z0-9]+$/i, '') || '(app)'; }
  return '(app)';
}

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// A package's color is one of the theme's ~12 categorical hues, perturbed in OKLCH by a
// deterministic, bounded amount keyed on the full hash. The perturbation keeps colors in the
// theme family while staying distinct well past 12 packages (the categorical slot count).
export function colorForPackage(pkg) {
  const { cat } = getTokens();
  const h = hash(pkg);
  const base = cat[h % cat.length];
  const { L, C, H } = hexToOklch(base);
  const dH = (((h >>> 4) % 31) - 15) * 1.6;   // ±24°, 31 steps
  const dL = (((h >>> 9) % 5) - 2) * 0.035;   // ±0.07, 5 steps
  return oklchToHex({ L: clamp(L + dL, 0.20, 0.92), C, H: (H + dH + 360) % 360 });
}
export function colorForFunc(p, func) { return colorForPackage(packageOf(funcName(p, func), funcFile(p, func))); }

// Diff coloring, from the theme: red = more in B (regression), blue = less (improvement),
// theme-grey ≈ unchanged (stays light on light themes, so neutrals don't read as dark).
export function colorForDelta(delta, maxAbs) {
  const { deltaPos, deltaNeg, deltaZero } = getTokens();
  const t = maxAbs ? clamp(delta / maxAbs, -1, 1) : 0;
  if (Math.abs(t) < 0.03) return deltaZero;
  const m = Math.abs(t);
  return mix(deltaZero, t > 0 ? deltaPos : deltaNeg, 0.35 + 0.55 * m);
}
