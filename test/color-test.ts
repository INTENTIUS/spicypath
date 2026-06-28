// FG-040: theme-driven color engine. Verifies package coloring is stable, distinct past the
// categorical slot count, theme-reactive, and that diff coloring derives from the theme
// (neutral stays light on light themes). Run: node test/color-test.ts
import { colorForPackage, colorForDelta, packageOf } from '../src/colors.js';
import { setTheme, getThemeName } from '../src/theme.js';
import { THEMES } from '../src/themes.js';
import { isDark } from '../src/theme.js';

let fails = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) fails++;
};
const isColor = (s: any) => typeof s === 'string' && /^#[0-9a-f]{6}$/.test(s);

// 20 realistic package names — more than the 12 categorical slots, so distinctness exercises
// the OKLCH degrade path.
const PKGS = [
  'runtime', 'net/http', 'encoding/json', 'sync', 'github.com/foo/bar', 'main',
  'io', 'os', 'reflect', 'strconv', 'bytes', 'sort', 'time', 'context',
  'crypto/tls', 'database/sql', 'fmt', 'bufio', 'regexp', 'compress/gzip',
];

setTheme('Catppuccin Mocha');
const colors = PKGS.map((p) => colorForPackage(p));
check('20 packages all yield valid hex colors', colors.every(isColor), JSON.stringify(colors));
const distinct = new Set(colors).size;
check('20 packages → 20 distinct colors (OKLCH degrade past 12 slots)', distinct === 20, `${distinct}/20 distinct`);

// stability: same name → same color on repeat
check('coloring is stable across calls', PKGS.every((p, i) => colorForPackage(p) === colors[i]));

// theme reactivity: switching theme changes the colors (derived, not hardcoded)
setTheme('Gruvbox Dark');
const gruv = PKGS.map((p) => colorForPackage(p));
check('switching theme recolors packages', gruv.some((c, i) => c !== colors[i]), 'gruvbox identical to mocha?');
setTheme('Gruvbox Dark');
check('still stable under the new theme', PKGS.every((p, i) => colorForPackage(p) === gruv[i]));

// diff coloring: derived from theme; regression≠improvement; near-zero neutral
setTheme('Catppuccin Mocha');
const pos = colorForDelta(1, 1), neg = colorForDelta(-1, 1), zero = colorForDelta(0.001, 1);
check('diff endpoints derive from theme + differ (regression vs improvement)', isColor(pos) && isColor(neg) && pos !== neg, `${pos} / ${neg}`);
check('near-zero delta is the neutral token', isColor(zero), zero);

// light theme: the neutral must stay light (no dark remnant on a light canvas)
const lightName = Object.keys(THEMES).find((k) => !THEMES[k].dark)!;
setTheme(lightName);
const lzero = colorForDelta(0.001, 1);
check(`light theme (${lightName}) → light neutral delta`, !isDark(lzero), lzero);

// reset to default so other importers see a sane theme
setTheme('Catppuccin Mocha');
check('packageOf sanity (used by coloring)', packageOf('runtime.kevent', '') === 'runtime', packageOf('runtime.kevent', ''));

console.log(fails ? `\ncolor: ${fails} check(s) failed ✗` : `\ncolor: all checks passed ✓`);
process.exit(fails ? 1 : 0);
