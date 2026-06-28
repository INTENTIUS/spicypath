// Diff proof: A (baseline) vs B (db.query tripled, gc shrunk). Render diff SVG + assert
// the deltas have the right signs.  node test/diff-test.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseFoldedText } from '../src/parse-folded.js';
import { buildDiff } from '../src/diff.js';
import { layout } from '../src/layout.js';
import { renderSVG } from '../src/render-svg.js';

const A = parseFoldedText('main;svc.handle;db.query 100\nmain;svc.handle;json.encode 100\nmain;gc.collect 50\n');
const B = parseFoldedText('main;svc.handle;db.query 300\nmain;svc.handle;json.encode 100\nmain;gc.collect 20\n');

const { ct, profile, maxAbsDelta } = buildDiff(A, B);
const boxes = layout(ct, { width: 1000, minWidth: 0.5 });
mkdirSync('test/out', { recursive: true });
writeFileSync('test/out/diff.svg', renderSVG(boxes, profile, { width: 1000, diff: true, maxAbsDelta, title: 'diff: B − A  (red = more in B / regression, blue = less)' }));

const deltaOf = (name: string) => { for (let i = 0; i < ct.func.length; i++) if (profile.stringTable[profile.funcTable.name[ct.func[i]]] === name) return ct.delta[i]; return NaN; };
const dq = deltaOf('db.query'), js = deltaOf('json.encode'), gc = deltaOf('gc.collect');
console.log(`db.query Δ=${dq.toFixed(3)} (want >0)  json.encode Δ=${js.toFixed(3)} (want <0)  gc.collect Δ=${gc.toFixed(3)} (want <0)  maxAbs=${maxAbsDelta.toFixed(3)}`);
const ok = dq > 0 && js < 0 && gc < 0;
console.log(ok ? 'diff OK ✓ (wrote test/out/diff.svg)' : 'diff FAIL ✗');
process.exit(ok ? 0 : 1);
