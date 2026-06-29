// FG-047: perf-script frames carry their DSO → packageOf groups by binary.
// Verifies: funcFile holds the normalized DSO, packageOf groups by binary, kernel
// frames map to the 'kernel' label, and same-named symbols in different DSOs are
// distinct funcs.
//   node test/parse-perf-dso-test.ts
import { parsePerfScriptText } from '../src/parse-perf.js';
import { packageOf, funcName, funcFile } from '../src/colors.js';
import { funcBasename } from '../src/sourceline.js';

let fails = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) fails++;
};

// A hand-written perf script block with frames across three DSOs:
//   main binary (/usr/bin/postgres), libc, and the kernel.
// Same symbol name "__memcpy" appears in both libc and the kernel to test
// that distinct DSOs produce distinct func entries.
const PERF_TEXT = `
postgres 1234 [000] 1.000000: 1000 cpu-clock:
\t7f00 ExecInsert+0x1a (/usr/bin/postgres)
\t7f01 ExecutorRun+0x3c (/usr/bin/postgres)
\t7f02 __memcpy+0x0 (/lib/x86_64-linux-gnu/libc.so.6)

postgres 1234 [000] 2.000000: 1000 cpu-clock:
\t7f03 pg_qsort+0x22 (/usr/bin/postgres)
\t7f04 __memcpy+0x0 ([kernel.kallsyms])
\t7f05 system_call+0x7b ([kernel.kallsyms])

postgres 1234 [000] 3.000000: 1000 cpu-clock:
\t7f06 malloc+0x12 (/lib/x86_64-linux-gnu/libc.so.6)
\t7f07 ExecInsert+0x1a (/usr/bin/postgres)

`.trimStart();

const p = parsePerfScriptText(PERF_TEXT);

// Build a map: symbolName → { funcIdx, dsoLabel } for all funcs in the profile.
const funcsByName = new Map<string, Array<{ idx: number; file: string }>>();
for (let i = 0; i < p.funcTable.name.length; i++) {
  const name = funcName(p, i);
  const file = funcFile(p, i);
  const arr = funcsByName.get(name) || [];
  arr.push({ idx: i, file });
  funcsByName.set(name, arr);
}

// (a) funcFile carries the normalized DSO — spot-check a few symbols.
const execInsertEntries = funcsByName.get('ExecInsert') || [];
check(
  '(a) ExecInsert funcFile is "postgres" (basename of /usr/bin/postgres)',
  execInsertEntries.some((e) => e.file === 'postgres'),
  JSON.stringify(execInsertEntries),
);

const mallocEntries = funcsByName.get('malloc') || [];
check(
  '(a) malloc funcFile is "libc.so.6" (basename of /lib/x86_64-linux-gnu/libc.so.6)',
  mallocEntries.some((e) => e.file === 'libc.so.6'),
  JSON.stringify(mallocEntries),
);

const syscallEntries = funcsByName.get('system_call') || [];
check(
  '(a) system_call funcFile is "kernel" ([kernel.kallsyms] → normalized)',
  syscallEntries.some((e) => e.file === 'kernel'),
  JSON.stringify(syscallEntries),
);

// (b) packageOf(funcName, funcFile) returns the DSO module for bare symbols.
// ExecInsert has no dots or slashes → packageOf falls back to the file basename stripped of ext.
// 'postgres' has no extension, so packageOf returns 'postgres'.
const execInsertFunc = execInsertEntries.find((e) => e.file === 'postgres');
if (execInsertFunc) {
  const pkg = packageOf('ExecInsert', execInsertFunc.file);
  check(
    '(b) packageOf("ExecInsert", "postgres") === "postgres"',
    pkg === 'postgres',
    `got "${pkg}"`,
  );
}

const mallocFunc = mallocEntries.find((e) => e.file === 'libc.so.6');
if (mallocFunc) {
  const pkg = packageOf('malloc', mallocFunc.file);
  check(
    '(b) packageOf("malloc", "libc.so.6") === "libc.so" (ext stripped by packageOf)',
    pkg === 'libc.so',
    `got "${pkg}"`,
  );
}

// (c) Kernel frames map to the 'kernel' label via packageOf.
const kernelMemcpyEntries = (funcsByName.get('__memcpy') || []).filter((e) => e.file === 'kernel');
check(
  '(c) __memcpy in kernel → funcFile is "kernel"',
  kernelMemcpyEntries.length > 0,
  JSON.stringify(funcsByName.get('__memcpy')),
);
if (kernelMemcpyEntries.length) {
  const pkg = packageOf('__memcpy', kernelMemcpyEntries[0].file);
  check(
    '(c) packageOf("__memcpy", "kernel") === "kernel"',
    pkg === 'kernel',
    `got "${pkg}"`,
  );
}

// Same-named symbol "__memcpy" in libc vs kernel → two distinct func entries.
const allMemcpy = funcsByName.get('__memcpy') || [];
const memcpyFiles = allMemcpy.map((e) => e.file).sort();
check(
  '(c) __memcpy appears as TWO distinct funcs (libc.so.6 + kernel)',
  allMemcpy.length === 2 && memcpyFiles.includes('libc.so.6') && memcpyFiles.includes('kernel'),
  `entries: ${JSON.stringify(allMemcpy)}`,
);

// (d) FG-030 sourceline view: funcBasename on a native frame returns a string (no crash),
// and the returned string is the DSO basename (not null), so the "source not loaded" path
// in the source-line view is taken rather than crashing.
const execFuncIdx = execInsertEntries.find((e) => e.file === 'postgres')?.idx ?? -1;
if (execFuncIdx >= 0) {
  let result: string | null | undefined;
  let threw = false;
  try { result = funcBasename(p, execFuncIdx); } catch { threw = true; }
  check(
    '(d) funcBasename on native func does not throw',
    !threw,
    'threw unexpectedly',
  );
  check(
    '(d) funcBasename returns a non-null string (DSO basename → "source not loaded" path)',
    typeof result === 'string' && result.length > 0,
    `got ${JSON.stringify(result)}`,
  );
}

// Edge case: a frame with no DSO in the regex match → funcFile is '' → packageOf → '(app)'.
const NO_DSO_TEXT = `
app 1 [000] 1.000000: 1 cpu-clock:
\t0 bare_symbol (/some/binary)

`.trimStart();

// Use a synthesized frame with NO parenthesized DSO at all (malformed line).
// The fallback branch in parse-perf.js sets dso='' and fileIdx=-1.
const SYNTH_TEXT = `
app 1 [000] 1.000000: 1 cpu-clock:
\t0 bare_symbol_no_dso

`.trimStart();

const pSynth = parsePerfScriptText(SYNTH_TEXT);
const synthFuncIdx = pSynth.funcTable.name[0];  // first func
const synthFile = funcFile(pSynth, 0);
check(
  '(d) frame with no DSO → funcFile is "" → packageOf returns "(app)"',
  synthFile === '' && packageOf(pSynth.stringTable[pSynth.funcTable.name[0]] || '', synthFile) === '(app)',
  `file="${synthFile}"`,
);

console.log(fails ? `\nparse-perf-dso: ${fails} check(s) failed ✗` : `\nparse-perf-dso: all checks passed ✓`);
process.exit(fails ? 1 : 0);
