// Theme engine (FG-040). Parses Ghostty theme files into a normalized 16-color palette,
// derives semantic UI tokens, and holds the active theme. Pure JS — runs in Node (data,
// tests) and the browser (live recolor). Theme data is vendored in ./themes.js, generated
// by test/make-themes.ts from mbadolato/iTerm2-Color-Schemes (see that file's header).
import { THEMES, DEFAULT_THEME } from './themes.js';

// --- low-level color math ------------------------------------------------
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
// straight sRGB mix (good enough for UI chrome); t=0 → a, t=1 → b
export function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
export function luminance(hex) { const [r, g, b] = hexToRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
export const isDark = (hex) => luminance(hex) < 0.5;

// --- OKLCH (perceptual hue rotation for >palette package counts) ----------
const s2l = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const l2s = (c) => { const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; return clamp(v, 0, 1) * 255; };
export function hexToOklch(hex) {
  const [R, G, B] = hexToRgb(hex).map(s2l);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { L, C: Math.hypot(a, bb), H: (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360 };
}
export function oklchToHex({ L, C, H }) {
  const h = H * Math.PI / 180, a = C * Math.cos(h), bb = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3;
  return rgbToHex(
    l2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    l2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    l2s(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s));
}

// --- parse a Ghostty theme file ------------------------------------------
// Lines look like `palette = N=#rrggbb`, `background = #rrggbb`, plus `foreground`,
// `cursor-color`, `selection-background`. The hex may omit the leading '#'. Returns null
// if the file lacks a full 16-color palette + background + foreground.
export function parseTheme(text, name) {
  const palette = new Array(16).fill(null);
  let bg = null, fg = null, cursor = null, selection = null;
  const norm = (v) => { v = v.trim().toLowerCase(); return /^#/.test(v) ? v : '#' + v; };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim(), val = line.slice(eq + 1).trim();
    if (key === 'palette') {
      const m = /^(\d+)\s*=\s*(.+)$/.exec(val);
      if (m) { const i = +m[1]; if (i >= 0 && i < 16) palette[i] = norm(m[2]); }
    } else if (key === 'background') bg = norm(val);
    else if (key === 'foreground') fg = norm(val);
    else if (key === 'cursor-color') cursor = norm(val);
    else if (key === 'selection-background') selection = norm(val);
  }
  if (!bg || !fg || palette.some((c) => c == null)) return null;
  return { name: name || 'theme', palette, bg, fg, cursor: cursor || fg, selection: selection || palette[8], dark: isDark(bg) };
}

// --- semantic UI tokens derived from a theme -----------------------------
// The single place that maps a 16-color terminal palette onto the workbench's surfaces.
// Both the canvas renderers (BaseView.T) and the CSS chrome (CSS vars in index.html) read
// these, so one theme swap recolors everything from a single source.
export function tokensFor(th) {
  const fgMix = (t) => mix(th.bg, th.fg, t);
  return {
    dark: th.dark,
    bg: th.bg,                       // canvas + page background
    bg2: fgMix(0.05),                // minimap / sunken panels
    panel: fgMix(0.09),             // floating overlays (legend/detail/palette)
    fg: th.fg,                       // primary text / box labels
    dim: fgMix(0.55),               // secondary text (axis ticks, stats)
    faint: fgMix(0.38),             // hints / disabled
    line: fgMix(0.16),              // borders / gridlines
    sel: th.fg,                      // selection stroke
    accent: th.palette[4],           // minimap viewport + focus highlight (blue slot)
    // diff endpoints: ANSI red (bright 9 / normal 1) = regression, blue (12 / 4) =
    // improvement, theme-grey ≈ 0 (stays light on light themes, dark on dark).
    deltaPos: th.palette[9] || th.palette[1],
    deltaNeg: th.palette[12] || th.palette[4],
    deltaZero: fgMix(0.30),
    // categorical hues for packages: skip 0/7/8/15 (the greys/fg) — use the 6 normal +
    // 6 bright chromatic slots. >12 packages degrade via OKLCH rotation (see colors.js).
    cat: [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14].map((i) => th.palette[i]),
  };
}

// --- active theme state ---------------------------------------------------
let _active = THEMES[DEFAULT_THEME] || Object.values(THEMES)[0] || null; // null only during converter bootstrap
let _tokens = _active ? tokensFor(_active) : null;
const _subs = new Set();
export function listThemes() { return Object.keys(THEMES); }
export function getTheme() { return _active; }
export function getTokens() { return _tokens; }
export function getThemeName() { return _active.name; }
export function onThemeChange(cb) { _subs.add(cb); return () => _subs.delete(cb); }
export function setTheme(nameOrObj) {
  const th = typeof nameOrObj === 'string' ? THEMES[nameOrObj] : nameOrObj;
  if (!th) return false;
  _active = th; _tokens = tokensFor(th);
  for (const cb of _subs) cb(th, _tokens);
  return true;
}
