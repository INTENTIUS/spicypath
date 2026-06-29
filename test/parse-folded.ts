// Node file wrapper. Pure core: parse-folded.js
import { readFileSync } from 'node:fs';
import { parseFoldedText } from '../src/parse-folded.js';
import { fmtWeight } from '../src/export.js';
import type { Profile } from '../src/model.ts';
export function parseFolded(path: string): Profile { return parseFoldedText(readFileSync(path, 'utf8')) as Profile; }

// FG-048: self-test — run only when invoked directly (not when imported by golden.ts)
if (process.argv[1] && process.argv[1].endsWith('parse-folded.ts')) {
  let failures = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name} — ${detail}`);
    if (!ok) failures++;
  };

  const FOLDED_TXT = 'a;b;c 1000\na;b 500\na 250\n';

  // 1. default (no opts) — weightTypes is ['samples'], count format
  const def = parseFoldedText(FOLDED_TXT) as Profile;
  check('default: weightTypes is [samples]', JSON.stringify(def.capabilities.weightTypes) === '["samples"]', JSON.stringify(def.capabilities.weightTypes));
  check('default: weightsByType has samples key', def.threads[0].samples.weightsByType['samples'] !== undefined, Object.keys(def.threads[0].samples.weightsByType).join(','));
  const defFmt = fmtWeight('samples', 1500);
  check('default: fmtWeight(samples, 1500) is a count string', defFmt === '1.5k samples', defFmt);

  // 2. opts.weightType = 'microseconds' — weightTypes carries the type, format is time
  const micro = parseFoldedText(FOLDED_TXT, { weightType: 'microseconds' }) as Profile;
  check('opts.weightType=microseconds: weightTypes is [microseconds]', JSON.stringify(micro.capabilities.weightTypes) === '["microseconds"]', JSON.stringify(micro.capabilities.weightTypes));
  check('opts.weightType=microseconds: weightsByType has microseconds key', micro.threads[0].samples.weightsByType['microseconds'] !== undefined, Object.keys(micro.threads[0].samples.weightsByType).join(','));
  check('opts.weightType=microseconds: no samples key', micro.threads[0].samples.weightsByType['samples'] === undefined, Object.keys(micro.threads[0].samples.weightsByType).join(','));
  // fmtWeight('microseconds', 1500) = 1.5ms (1500µs = 1.5ms)
  const microFmt = fmtWeight('microseconds', 1500);
  check('fmtWeight(microseconds, 1500) is a time string', /ms|µs|ns|s/.test(microFmt) && !microFmt.includes('samples'), microFmt);

  // 3. Numbers are preserved (same underlying data regardless of name)
  const defWeights = def.threads[0].samples.weightsByType['samples'];
  const microWeights = micro.threads[0].samples.weightsByType['microseconds'];
  check('numbers are identical regardless of weightType name', JSON.stringify(defWeights) === JSON.stringify(microWeights), `def=${JSON.stringify(defWeights)} micro=${JSON.stringify(microWeights)}`);

  console.log(`\nparse-folded: ${failures === 0 ? 'PASSED ✓' : `FAILED ✗ (${failures} failures)`}`);
  process.exit(failures ? 1 : 0);
}
