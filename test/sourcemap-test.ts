// FG-044: Unit + integration tests for src/sourcemap.js
//   node test/sourcemap-test.ts
import { parseSourceMap, remapProfile } from '../src/sourcemap.js';
import { ProfileBuilder, checkInvariants } from '../src/model.js';
import { buildCallNodeTable } from '../src/callnode.js';
import { packageOf } from '../src/colors.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok ' : 'NOK'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// Helper: encode a VLQ integer (for hand-building test mappings)
// ---------------------------------------------------------------------------
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function encodeVLQ(n: number): string {
  let out = '';
  // encode sign into the LSB of the first group
  let v = n < 0 ? ((-n) << 1) | 1 : (n << 1);
  do {
    let sextet = v & 0x1f;
    v >>>= 5;
    if (v > 0) sextet |= 0x20; // continuation
    out += BASE64[sextet];
  } while (v > 0);
  return out;
}
function encodeSegment(...nums: number[]): string {
  return nums.map(encodeVLQ).join('');
}

// ---------------------------------------------------------------------------
// 2.1 — Unit tests for parseSourceMap + lookup
// ---------------------------------------------------------------------------
console.log('\n=== parseSourceMap unit tests ===');

// Build a minimal source map with known mappings.
// Generated file has 3 lines; the mappings cover a few interesting positions.
//
// Line 1 (0-based: 0):
//   col 0 → src 0, origLine 5  (0-based: 4), origCol 0, name "originalFoo"
//   col 5 → src 0, origLine 10 (0-based: 9), origCol 2
//
// Line 2 (0-based: 1):
//   col 0 → src 1, origLine 20 (0-based: 19), origCol 8
//
// Line 3 (0-based: 2):
//   (empty — no segments)
//
// Mappings use delta encoding. The running state starts all at 0.
// Segment: [genColDelta, srcIdxDelta, origLineDelta, origColDelta, nameIdxDelta?]

// Line 1, seg 1: genCol=0, src=0(+0), origLine=4(+4), origCol=0(+0), name=0(+0)
const seg11 = encodeSegment(0, 0, 4, 0, 0);
// Line 1, seg 2: genCol=5(+5), src still 0(+0), origLine=9(+5), origCol=2(+2), no name
const seg12 = encodeSegment(5, 0, 5, 2);
// Line 2, seg 1: genCol=0(reset), src=1(+1), origLine=19(+10), origCol=8(+6), no name
const seg21 = encodeSegment(0, 1, 10, 6);

const mappings = `${seg11},${seg12};${seg21};`;

const sampleMap = {
  version: 3,
  file: 'dist/app.js',
  sourceRoot: 'src/',
  sources: ['foo.ts', 'bar.ts'],
  sourcesContent: ['// foo source', '// bar source'],
  names: ['originalFoo'],
  mappings,
};

{
  const parsed = parseSourceMap(sampleMap);

  check('parse: sources resolved against sourceRoot',
    parsed.sources[0] === 'src/foo.ts' && parsed.sources[1] === 'src/bar.ts',
    `sources=${JSON.stringify(parsed.sources)}`);

  check('parse: sourcesContent preserved',
    Array.isArray(parsed.sourcesContent) && parsed.sourcesContent![0] === '// foo source',
    `sc=${parsed.sourcesContent}`);

  check('parse: names preserved', parsed.names[0] === 'originalFoo', JSON.stringify(parsed.names));

  // Lookup: generated line 1 col 0 → origLine 5, name "originalFoo"
  const r1 = parsed.lookup(1, 0);
  check('lookup: line 1 col 0 → origLine=5, name=originalFoo',
    r1 !== null && r1.originalLine === 5 && r1.name === 'originalFoo' && r1.source === 'src/foo.ts',
    JSON.stringify(r1));

  // Lookup: generated line 1 col 5 → origLine 10, no name
  const r2 = parsed.lookup(1, 5);
  check('lookup: line 1 col 5 → origLine=10, name=null',
    r2 !== null && r2.originalLine === 10 && r2.name === null,
    JSON.stringify(r2));

  // Lookup: generated line 1 col 3 → falls back to last segment at col <=3, which is col 0
  const r3 = parsed.lookup(1, 3);
  check('lookup: line 1 col 3 → falls back to col-0 mapping (origLine=5)',
    r3 !== null && r3.originalLine === 5,
    JSON.stringify(r3));

  // Lookup: generated line 2 col 0 → origLine 20, bar.ts
  const r4 = parsed.lookup(2, 0);
  check('lookup: line 2 col 0 → origLine=20, source=src/bar.ts',
    r4 !== null && r4.originalLine === 20 && r4.source === 'src/bar.ts',
    JSON.stringify(r4));

  // Lookup: generated line 3 (empty, no segments) → null
  const r5 = parsed.lookup(3, 0);
  check('lookup: line 3 (no segments) → null', r5 === null, `got ${JSON.stringify(r5)}`);

  // Lookup: unknown line beyond the map → null
  const r6 = parsed.lookup(100, 0);
  check('lookup: line 100 (beyond map) → null', r6 === null, `got ${JSON.stringify(r6)}`);
}

// Multi-byte VLQ edge case: encode a value that requires more than one sextet (>= 16).
// We'll encode origLine delta = 63 (requires continuation bits).
{
  // Single segment: genCol=0(+0), src=0(+0), origLine=63(+63), origCol=0(+0)
  const bigSeg = encodeSegment(0, 0, 63, 0);
  // Verify encodeVLQ(63) = 2+ chars (63 << 1 = 126; 126 = 0x7e; first 5 bits = 0x1e | 0x20 = 0x3e, cont bit set; next = 0x03)
  const largeMap = {
    version: 3, sources: ['orig.ts'], names: [], sourcesContent: null,
    mappings: bigSeg,
  };
  const parsed = parseSourceMap(largeMap);
  const r = parsed.lookup(1, 0);
  check('VLQ multi-byte: origLine delta=63 decodes correctly (origLine=64)',
    r !== null && r.originalLine === 64,
    `origLine=${r && r.originalLine}`);
}

// Negative delta edge case: encode origLine that goes backward.
{
  // Line 1: origLine=10, then on same line col=5: origLine delta=-3 → origLine=7
  const s1 = encodeSegment(0, 0, 9, 0);  // origLine delta=9 → abs=9 (0-based) → 1-based=10
  const s2 = encodeSegment(5, 0, -3, 0); // origLine delta=-3 → abs=6 (0-based) → 1-based=7
  const negMap = { version: 3, sources: ['orig.ts'], names: [], sourcesContent: null, mappings: `${s1},${s2}` };
  const parsed = parseSourceMap(negMap);
  const r1 = parsed.lookup(1, 0);
  const r2 = parsed.lookup(1, 5);
  check('VLQ negative delta: first seg origLine=10', r1 !== null && r1.originalLine === 10, JSON.stringify(r1));
  check('VLQ negative delta: second seg origLine=7', r2 !== null && r2.originalLine === 7, JSON.stringify(r2));
}

// Generated-only segment (1 field) → lookup returns null.
{
  const genOnly = encodeVLQ(4); // single delta, no source fields
  const goMap = { version: 3, sources: ['orig.ts'], names: [], sourcesContent: null, mappings: genOnly };
  const parsed = parseSourceMap(goMap);
  const r = parsed.lookup(1, 0);
  check('generated-only segment: lookup returns null', r === null, JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// 2.2 — Integration tests for remapProfile
// ---------------------------------------------------------------------------
console.log('\n=== remapProfile integration tests ===');

{
  // Build a profile with generated-file frames:
  //   funcA: name="a_0", file="dist/app.js", defLine=100
  //   funcB: name="b_0", file="dist/app.js", defLine=200
  //   funcC: name="c_original", file="src/other.ts", defLine=5  (unmapped, different file)
  //
  // Build a source map: dist/app.js maps:
  //   line 100 col 0 → src/module.ts origLine=10 name="actualA"
  //   line 200 col 0 → src/module.ts origLine=50 (no name → keep "b_0")
  //
  // Frames have their own sample lines (different from defLine):
  //   frameA: func=funcA, line=105 (maps to origLine ?)
  //   frameB: func=funcB, line=202 (maps to origLine ?)
  //   frameC: func=funcC, line=6   (no map → unchanged)

  const sA = encodeSegment(0, 0, 9,  0, 0); // line 100 col 0 → src[0] origLine=9(0-based)=10, name[0]
  const sA2 = encodeSegment(5, 0, 0, 0);    // line 100 col 5 → same src, origLine=10, no name (delta=0)
  // We need line 105 and 202 covered too. Let's build a map that covers them.
  // Lines (0-based: 99, 104, 199, 201)
  // Build separate lines for each:
  //   line 100 (idx 99): col 0 → origLine 10, name "actualA"
  //   line 105 (idx 104): col 0 → origLine 15
  //   line 200 (idx 199): col 0 → origLine 50, no name
  //   line 202 (idx 201): col 0 → origLine 52, no name

  // Build mappings string manually using semicolons for line separators.
  // Running state tracking:
  let curSrcIdx = 0, curOrigLine = 0, curOrigCol = 0, curNameIdx = 0;

  function makeLineMappings(targetLine0: number, curLine: number, srcIdxAbs: number, origLineAbs: number, nameIdxAbs: number | null) {
    // returns { segs, newLine, newSrcIdx, newOrigLine, newNameIdx }
    // We need to advance genLine from curLine to targetLine0 with semicolons.
    // But we can't easily do that in a single string — we'll build an array of per-line strings instead.
    return null; // placeholder
  }

  // Simpler approach: build a mini-map that covers exactly the lines we need.
  // We'll use a ProfileBuilder to build a very small profile and a Map that
  // covers both the definition lines (for funcTable.line remap) and the sample
  // frame lines (for frameTable.line remap).
  //
  // We'll construct the mappings array directly (bypassing string building) by
  // creating a ParsedMap-like object with a custom lookup function instead.

  const pb = new ProfileBuilder();
  const fnA = pb.internFunc(pb.internString('a_0'), pb.internString('dist/app.js'), 100);
  const fnB = pb.internFunc(pb.internString('b_0'), pb.internString('dist/app.js'), 200);
  const fnC = pb.internFunc(pb.internString('c_original'), pb.internString('src/other.ts'), 5);

  // Frames: funcA at line 105, funcB at line 202, funcC at line 6
  const frA = pb.internFrame(fnA, 105, 0);
  const frB = pb.internFrame(fnB, 202, 0);
  const frC = pb.internFrame(fnC, 6, 0);

  // Stack: [frC → frA → frB] (root frC, then frA, then leaf frB)
  const sRootC = pb.internStack(frC, -1);
  const sMidA  = pb.internStack(frA, sRootC);
  const sLeafB = pb.internStack(frB, sMidA);

  const origProfile = pb.finish(
    [{ name: 'main', samples: { stack: [sLeafB], weightsByType: { samples: [10] } } }],
    { hasTiming: false, weightTypes: ['samples'], isDiff: false, timeUnit: 'none' },
  );

  // Verify invariants on original profile.
  const errs0 = checkInvariants(origProfile);
  check('integration: original profile passes invariants', errs0.length === 0, errs0.join('; '));

  // Build a custom ParsedMap with a lookup function that covers our test lines.
  const testMap = {
    file: 'dist/app.js',
    sourceRoot: '',
    sources: ['src/module.ts'],
    sourcesContent: ['// module source content\nfunction actualA() {}\nfunction b_renamed() {}'],
    names: ['actualA'],
    decoded: [],
    lookup(genLine1: number, _genCol0: number) {
      // defLine for funcA is 100 → origLine 10, name "actualA"
      if (genLine1 === 100) return { source: 'src/module.ts', originalLine: 10, originalColumn: 0, name: 'actualA' };
      // frame line 105 → origLine 15
      if (genLine1 === 105) return { source: 'src/module.ts', originalLine: 15, originalColumn: 0, name: null };
      // defLine for funcB is 200 → origLine 50, no name
      if (genLine1 === 200) return { source: 'src/module.ts', originalLine: 50, originalColumn: 0, name: null };
      // frame line 202 → origLine 52
      if (genLine1 === 202) return { source: 'src/module.ts', originalLine: 52, originalColumn: 0, name: null };
      return null;
    },
  };

  const mapsByGenFile = new Map([['app.js', testMap]]);
  const remapped = remapProfile(origProfile, mapsByGenFile);

  // Verify invariants on remapped profile.
  const errs1 = checkInvariants(remapped);
  check('integration: remapped profile passes invariants', errs1.length === 0, errs1.join('; '));

  // funcA should be remapped: name="actualA", file="src/module.ts", defLine=10
  // Find the func in remapped.funcTable that has name "actualA"
  const { stringTable, funcTable } = remapped;
  const funcNames = funcTable.name.map((ni: number) => stringTable[ni]);
  const funcFiles = funcTable.file.map((fi: number) => fi >= 0 ? stringTable[fi] : '');

  const idxActualA = funcNames.indexOf('actualA');
  check('integration: funcA remapped to name "actualA"', idxActualA >= 0, `funcNames=${JSON.stringify(funcNames)}`);
  if (idxActualA >= 0) {
    check('integration: funcA remapped to file "src/module.ts"',
      funcFiles[idxActualA] === 'src/module.ts', `file=${funcFiles[idxActualA]}`);
    check('integration: funcA defLine remapped to 10',
      funcTable.line[idxActualA] === 10, `defLine=${funcTable.line[idxActualA]}`);
  }

  // funcB should be remapped: name kept "b_0" (no name in map), file="src/module.ts", defLine=50
  const idxB0 = funcNames.indexOf('b_0');
  check('integration: funcB keeps original name "b_0" (no name mapping)',
    idxB0 >= 0, `funcNames=${JSON.stringify(funcNames)}`);
  if (idxB0 >= 0) {
    check('integration: funcB remapped to file "src/module.ts"',
      funcFiles[idxB0] === 'src/module.ts', `file=${funcFiles[idxB0]}`);
    check('integration: funcB defLine remapped to 50',
      funcTable.line[idxB0] === 50, `defLine=${funcTable.line[idxB0]}`);
  }

  // funcC is from "src/other.ts" (no matching map) → unchanged
  const idxC = funcNames.indexOf('c_original');
  check('integration: unmapped funcC name unchanged', idxC >= 0, `funcNames=${JSON.stringify(funcNames)}`);
  if (idxC >= 0) {
    check('integration: unmapped funcC file unchanged',
      funcFiles[idxC] === 'src/other.ts', `file=${funcFiles[idxC]}`);
    check('integration: unmapped funcC defLine unchanged',
      funcTable.line[idxC] === 5, `defLine=${funcTable.line[idxC]}`);
  }

  // Frame lines: the leaf frame (funcB) had frameLine=202 → should remap to 52
  // Find the frame whose func is idxB0
  const { frameTable } = remapped;
  let frameLineB = -1;
  for (let i = 0; i < frameTable.func.length; i++) {
    if (frameTable.func[i] === idxB0) { frameLineB = frameTable.line[i]; break; }
  }
  check('integration: frame line for funcB remapped from 202 → 52',
    frameLineB === 52, `frameLine=${frameLineB}`);

  // packageOf now uses original file/name for funcA
  if (idxActualA >= 0) {
    const pkg = packageOf('actualA', 'src/module.ts');
    check('integration: packageOf after remap uses original file (src/module)',
      pkg === 'module' || pkg.includes('module'), `packageOf=${pkg}`);
  }

  // Sample count preserved (1 sample with weight 10)
  const t = remapped.threads[0];
  const wt = t.samples.weightsByType['samples'];
  check('integration: sample count preserved', t.samples.stack.length === 1, `n=${t.samples.stack.length}`);
  check('integration: weight preserved', wt[0] === 10, `w=${wt[0]}`);
}

// No-map case: remapProfile with empty map returns the same object.
{
  const pb = new ProfileBuilder();
  const fn = pb.internFunc(pb.internString('f'), -1, -1);
  pb.internStack(pb.internFrame(fn, -1, 0), -1);
  const p = pb.finish(
    [{ name: 'main', samples: { stack: [0], weightsByType: { samples: [1] } } }],
    { hasTiming: false, weightTypes: ['samples'], isDiff: false, timeUnit: 'none' },
  );
  const result = remapProfile(p, new Map());
  check('no-map: empty mapsByGenFile returns original profile unchanged', result === p, 'expected identity');
}

// Multiple source files: only files with matching basenames get remapped.
{
  const pb = new ProfileBuilder();
  const fnX = pb.internFunc(pb.internString('x_mangled'), pb.internString('dist/x.js'), 8);
  const fnY = pb.internFunc(pb.internString('y_original'), pb.internString('src/y.ts'), 12);
  const frX = pb.internFrame(fnX, 8, 0);
  const frY = pb.internFrame(fnY, 12, 0);
  const s0 = pb.internStack(frX, -1);
  const s1 = pb.internStack(frY, s0);
  const p = pb.finish(
    [{ name: 't', samples: { stack: [s1], weightsByType: { samples: [5] } } }],
    { hasTiming: false, weightTypes: ['samples'], isDiff: false, timeUnit: 'none' },
  );

  const xMap = {
    file: 'dist/x.js', sourceRoot: '', sources: ['src/x.ts'], sourcesContent: null, names: ['realX'], decoded: [],
    lookup(line: number, _col: number) {
      if (line === 8) return { source: 'src/x.ts', originalLine: 3, originalColumn: 0, name: 'realX' };
      return null;
    },
  };

  const remapped = remapProfile(p, new Map([['x.js', xMap]]));
  const errs = checkInvariants(remapped);
  check('multi-file: invariants pass', errs.length === 0, errs.join('; '));

  const names = remapped.funcTable.name.map((i: number) => remapped.stringTable[i]);
  const files = remapped.funcTable.file.map((i: number) => i >= 0 ? remapped.stringTable[i] : '');
  check('multi-file: x_mangled → realX', names.includes('realX'), JSON.stringify(names));
  check('multi-file: y_original unchanged', names.includes('y_original'), JSON.stringify(names));
  check('multi-file: y file src/y.ts unchanged', files.includes('src/y.ts'), JSON.stringify(files));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nsourcemap: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
