// FG-040: theme parser + vendored roster. Verifies parseTheme() on raw Ghostty text
// (exact hexes, normalization, rejection), the vendored roster's completeness, the derived
// UI tokens, and the OKLCH round-trip. Run: node test/theme-test.ts
import { parseTheme, tokensFor, hexToOklch, oklchToHex, mix, isDark } from '../src/theme.js';
import { THEMES, DEFAULT_THEME } from '../src/themes.js';

let fails = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) fails++;
};
const isHex = (s: any) => typeof s === 'string' && /^#[0-9a-f]{6}$/.test(s);

// --- parseTheme on a real Ghostty file (Catppuccin Mocha, verbatim from the corpus) ------
const MOCHA = `palette = 0=#45475a
palette = 1=#f38ba8
palette = 2=#a6e3a1
palette = 3=#f9e2af
palette = 4=#89b4fa
palette = 5=#f5c2e7
palette = 6=#94e2d5
palette = 7=#bac2de
palette = 8=#585b70
palette = 9=#f7aec2
palette = 10=#c2ecbf
palette = 11=#fcd682
palette = 12=#aeccfc
palette = 13=#f398da
palette = 14=#b1eae1
palette = 15=#a6adc8
background = #1e1e2e
foreground = #cdd6f4
cursor-color = #f5e0dc
cursor-text = #1e1e2e
selection-background = #f5e0dc
selection-foreground = #1e1e2e`;
const m = parseTheme(MOCHA, 'Catppuccin Mocha');
check('parseTheme returns a theme for Catppuccin Mocha', !!m, 'got null');
check('Catppuccin Mocha palette has all 16 entries', m!.palette.length === 16 && m!.palette.every(isHex), JSON.stringify(m?.palette));
check('Catppuccin Mocha exact hexes (bg/fg/palette 1/15)',
  m!.bg === '#1e1e2e' && m!.fg === '#cdd6f4' && m!.palette[1] === '#f38ba8' && m!.palette[15] === '#a6adc8',
  `bg=${m?.bg} fg=${m?.fg} p1=${m?.palette[1]} p15=${m?.palette[15]}`);
check('Catppuccin Mocha is detected as dark', m!.dark === true && isDark(m!.bg));
check('cursor + selection captured', m!.cursor === '#f5e0dc' && m!.selection === '#f5e0dc');

// normalization: hex without '#', uppercase, and stray comment/blank lines
const NO_HASH = MOCHA.replace(/#1e1e2e/g, '1E1E2E').replace(/^/, '# a comment\n\n');
const n = parseTheme(NO_HASH, 'x');
check('parseTheme normalizes bare/uppercase hex + ignores comments', n!.bg === '#1e1e2e', `bg=${n?.bg}`);

// rejection: an incomplete palette → null
check('parseTheme rejects an incomplete file', parseTheme('background = #000000\nforeground = #ffffff', 'bad') === null);

// --- vendored roster (these were all produced by parseTheme from real corpus files) ------
const names = Object.keys(THEMES);
check('roster has >=10 themes', names.length >= 10, `${names.length}`);
check('default theme exists in roster', !!THEMES[DEFAULT_THEME], DEFAULT_THEME);
let bad = '';
for (const name of names) {
  const t = THEMES[name];
  if (!(t.palette.length === 16 && t.palette.every(isHex) && isHex(t.bg) && isHex(t.fg))) bad += name + ' ';
}
check('every roster theme has 16 valid palette colors + bg + fg', !bad, 'malformed: ' + bad);
check('roster has both dark and light themes',
  names.some((k) => THEMES[k].dark) && names.some((k) => !THEMES[k].dark),
  'darks=' + names.filter((k) => THEMES[k].dark).length + ' lights=' + names.filter((k) => !THEMES[k].dark).length);

// --- derived UI tokens ------------------------------------------------------------------
const tok = tokensFor(THEMES[DEFAULT_THEME]);
check('tokensFor exposes bg/fg/cat/delta endpoints',
  isHex(tok.bg) && isHex(tok.fg) && tok.cat.length === 12 && tok.cat.every(isHex) && isHex(tok.deltaPos) && isHex(tok.deltaNeg),
  JSON.stringify({ cat: tok.cat.length, dp: tok.deltaPos, dn: tok.deltaNeg }));
const lightTok = tokensFor(THEMES[Object.keys(THEMES).find((k) => !THEMES[k].dark)!]);
check('light theme yields a light deltaZero (neutral stays light)', !isDark(lightTok.deltaZero), lightTok.deltaZero);

// --- color math sanity ------------------------------------------------------------------
check('mix endpoints are exact', mix('#000000', '#ffffff', 0) === '#000000' && mix('#000000', '#ffffff', 1) === '#ffffff');
const rt = oklchToHex(hexToOklch('#89b4fa'));
check('OKLCH round-trip is near-lossless', rt === '#89b4fa' || colorClose(rt, '#89b4fa', 2), `#89b4fa → ${rt}`);

function colorClose(a: string, b: string, tol: number) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const da = [(pa >> 16) & 255, (pa >> 8) & 255, pa & 255], db = [(pb >> 16) & 255, (pb >> 8) & 255, pb & 255];
  return da.every((v, i) => Math.abs(v - db[i]) <= tol);
}

console.log(fails ? `\ntheme: ${fails} check(s) failed ✗` : `\ntheme: all checks passed ✓`);
process.exit(fails ? 1 : 0);
