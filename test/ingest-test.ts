// Smoke test for ingest.js: run every fixture through ingestBytes (the same path the
// browser file-drop uses — DecompressionStream/TextDecoder are web APIs Node also has).
//   node test/ingest-test.ts
import { readdirSync, readFileSync } from 'node:fs';
import { ingestBytes } from '../src/ingest.js';

const dir = 'test/testdata';
let ok = 0, fail = 0;
for (const f of readdirSync(dir).sort()) {
  if (/\.(svg|png)$/.test(f)) continue;
  try {
    const p = await ingestBytes(f, new Uint8Array(readFileSync(`${dir}/${f}`)));
    const n = p.threads[0].samples.stack.length;
    console.log(`ok    ${f.padEnd(34)} ${String(n).padStart(5)} samples  hasTiming=${p.capabilities.hasTiming}  wt=[${p.capabilities.weightTypes.join(',')}]`);
    ok++;
  } catch (e) { console.log(`FAIL  ${f}: ${(e as Error).message}`); fail++; }
}
console.log(`\ningest: ${ok} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
