// FG-045: Markdown hotspot report export tests.
// Verifies exportMarkdown output against known fixtures:
//   (a) rank-1 row is the heaviest-self function
//   (b) percentages are sane (top self% <= 100; total >= self for every row)
//   (c) units match the weight type (cpu_nanos -> time; samples -> count)
//   node test/markdown-test.ts
import { readFileSync } from 'node:fs';
import { ingestBytes } from '../src/ingest.js';
import { exportMarkdown, fmtWeight } from '../src/export.js';
import { functionStats } from '../src/funcstats.js';
import { buildCallNodeTable } from '../src/callnode.js';
import type { Profile } from '../src/model.ts';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${(!ok && detail) ? ': ' + detail : ''}`);
}

// ---- helpers ----
function grandTotal(p: Profile, wt: string): number {
  const ct = buildCallNodeTable(p, 0, wt);
  return ct.grandTotal;
}

// Parse the rank-1 function name from a Markdown table row (skips header + separator).
function rank1Name(md: string): string {
  const rows = md.split('\n').filter((l) => l.startsWith('| 1 |'));
  if (!rows.length) return '';
  // format: | 1 | `name` | ...
  const m = rows[0].match(/\|\s*1\s*\|\s*`([^`]*)`/);
  return m ? m[1] : '';
}

// Parse ALL data rows from the Top functions table (rows starting with | <number> |).
function tableRows(md: string): Array<{ rank: number; name: string; selfPct: number; totalPct: number }> {
  return md.split('\n')
    .filter((l) => /^\|\s*\d+\s*\|/.test(l))
    .map((l) => {
      const parts = l.split('|').map((s) => s.trim()).filter(Boolean);
      // parts: rank, name (backtick-quoted), selfVal, selfPct, totalVal, totalPct, loc
      const rank = parseInt(parts[0], 10);
      const name = (parts[1] || '').replace(/`/g, '');
      const selfPct = parseFloat((parts[3] || '0').replace('%', ''));
      const totalPct = parseFloat((parts[5] || '0').replace('%', ''));
      return { rank, name, selfPct, totalPct };
    });
}

// ---- fixture: tiny.folded ----
// Stacks: db.query=50, json.encode=30, gc.mark=20 → heaviest-self = db.query
{
  const p = await ingestBytes('tiny.folded', new Uint8Array(readFileSync('test/testdata/tiny.folded')));
  const wt = p.capabilities.weightTypes[0];
  check('tiny.folded: weightType is samples', wt === 'samples', wt);

  const md = exportMarkdown(p, wt);
  const rows = tableRows(md);
  check('tiny.folded: rank-1 is db.query', rank1Name(md) === 'db.query', rank1Name(md));
  check('tiny.folded: rank-1 self% is 50.0', rows[0]?.selfPct === 50.0, String(rows[0]?.selfPct));
  check('tiny.folded: rank-1 total% >= rank-1 self%', (rows[0]?.totalPct ?? 0) >= (rows[0]?.selfPct ?? 1), `${rows[0]?.totalPct} vs ${rows[0]?.selfPct}`);

  // All rows: self% <= 100, total% >= self%
  let sane = true;
  for (const r of rows) {
    if (r.selfPct > 100.001) { sane = false; console.log(`  bad self% ${r.selfPct} for ${r.name}`); }
    if (r.totalPct < r.selfPct - 0.01) { sane = false; console.log(`  total% ${r.totalPct} < self% ${r.selfPct} for ${r.name}`); }
  }
  check('tiny.folded: all rows have sane self%/total%', sane);

  // Unit check: samples → value string contains "samples"
  check('tiny.folded: grand-total line contains "samples"', md.includes('samples (samples)'));

  // Hottest stacks section present with correct rank-1 stack
  check('tiny.folded: hottest stacks section present', md.includes('## Hottest stacks'));
  check('tiny.folded: hottest stack rank-1 contains db.query', md.includes('db.query'));
}

// ---- fixture: multi-value.pprof ----
// cpu_nanos: sql.exec=200, serialize.marshal=60, rows.scan=40 → heaviest = sql.exec
{
  const p = await ingestBytes('multi-value.pprof', new Uint8Array(readFileSync('test/testdata/multi-value.pprof')));
  const wt = 'cpu_nanos';
  check('multi-value: cpu_nanos available', p.capabilities.weightTypes.includes(wt), p.capabilities.weightTypes.join(','));

  const md = exportMarkdown(p, wt);
  const rows = tableRows(md);
  check('multi-value/cpu_nanos: rank-1 is sql.exec', rank1Name(md) === 'sql.exec', rank1Name(md));
  check('multi-value/cpu_nanos: rank-1 self% ~66.7', Math.abs((rows[0]?.selfPct ?? 0) - 66.7) < 0.2, String(rows[0]?.selfPct));

  // Unit check: cpu_nanos → time unit in the output (ns/µs/ms/s suffix in values)
  check('multi-value/cpu_nanos: grand-total shows time unit', /\d+(ns|µs|ms|s)\b/.test(md));
  // "samples" weight type
  const mdS = exportMarkdown(p, 'samples');
  check('multi-value/samples: unit shows "samples"', mdS.includes('samples ('));

  // Cross-check: rank-1 self matches functionStats directly
  const ct = buildCallNodeTable(p, 0, wt);
  const stats = functionStats(ct, p);
  check('multi-value/cpu_nanos: funcStats rank-1 name matches md rank-1', stats[0]?.name === rank1Name(md), `funcStats[0]=${stats[0]?.name} md=${rank1Name(md)}`);

  // All sane
  let sane = true;
  for (const r of rows) {
    if (r.selfPct > 100.001) { sane = false; }
    if (r.totalPct < r.selfPct - 0.01) { sane = false; }
  }
  check('multi-value/cpu_nanos: all rows sane', sane);
}

// ---- fixture: deep-recursion.pprof ----
// Under recursion, total% must still be <= 100 (once-per-sample guarantee)
{
  const p = await ingestBytes('deep-recursion.pprof', new Uint8Array(readFileSync('test/testdata/deep-recursion.pprof')));
  const wt = p.capabilities.weightTypes[0];
  const md = exportMarkdown(p, wt);
  const rows = tableRows(md);

  let sane = true;
  for (const r of rows) {
    if (r.selfPct > 100.001 || r.totalPct > 100.001) { sane = false; console.log(`  recursion bad: self=${r.selfPct} total=${r.totalPct} for ${r.name}`); }
    if (r.totalPct < r.selfPct - 0.01) { sane = false; console.log(`  recursion total<self: ${r.name}`); }
  }
  check('deep-recursion: total% never exceeds 100 (once-per-sample)', sane);

  // rank-1 should have self% == total% == 100 (app.fib takes everything)
  check('deep-recursion: rank-1 self% == 100', Math.abs((rows[0]?.selfPct ?? 0) - 100) < 0.2, String(rows[0]?.selfPct));
}

// ---- topN option ----
{
  const p = await ingestBytes('wide-fanout.folded', new Uint8Array(readFileSync('test/testdata/wide-fanout.folded')));
  const wt = p.capabilities.weightTypes[0];
  const md5 = exportMarkdown(p, wt, { topN: 5, hotStacks: 0 });
  const rows5 = tableRows(md5);
  check('topN=5 limits table to 5 rows', rows5.length === 5, String(rows5.length));
  check('topN=5: hotStacks=0 suppresses hottest-stacks section', !md5.includes('## Hottest stacks'));
}

console.log(`\nmarkdown export: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
