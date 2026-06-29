// Sandwich default-focal selection must not crash on a hub-less profile. _defaultFocal()
// prefers a frame with both callees AND >=2 distinct callers; when none qualifies it falls
// back to the heaviest-self frame. A shallow tree (root -> {a, b}, both leaves) has no such
// hub, so it exercises that fallback — which used to throw ReferenceError (undeclared `bw`).
//   node test/sandwich-test.ts
import { FlameView } from '../src/render-canvas.js';
import { parseFoldedText } from '../src/parse-folded.js';

const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
const els: Record<string, any> = {};
const mk = () => ({ innerHTML: '', style: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 1000, parentElement: { clientWidth: 1000 }, getContext: () => ctx, width: 0, height: 0, offsetTop: 0 });
(globalThis as any).requestAnimationFrame = () => 1;
(globalThis as any).window = { devicePixelRatio: 1, addEventListener() {}, innerHeight: 800, requestAnimationFrame: () => 1 };
(globalThis as any).document = { getElementById: (id: string) => els[id] || (els[id] = mk()), addEventListener() {}, body: { style: {} } };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

// hub-less: root branches to two leaves; no frame has >=2 distinct callers + callees → fallback
const flat = parseFoldedText('root;a 5\nroot;b 3\n');
const vf = new FlameView(mk(), flat, 'samples', 'graph');
try {
  vf.setMode('sandwich');
  const okFocal = Number.isInteger(vf.focalFunc) && vf.focalFunc >= 0;
  check('hub-less profile: entering Sandwich picks a focal without throwing', okFocal, `focalFunc=${vf.focalFunc}`);
  check('hub-less fallback: focal is the heaviest-self frame (a, self=5)', flat.stringTable[flat.funcTable.name[vf.focalFunc]] === 'a', flat.stringTable[flat.funcTable.name[vf.focalFunc]]);
} catch (e: any) {
  check('hub-less profile: entering Sandwich picks a focal without throwing', false, `${e.constructor.name}: ${e.message}`);
}

// a profile WITH a real hub (h called from two places) should still prefer the hub, not the leaf
const hubbed = parseFoldedText('main;h;x 4\nother;h;y 4\nmain;solo 9\n');
const vh = new FlameView(mk(), hubbed, 'samples', 'graph');
vh.setMode('sandwich');
check('hubbed profile: prefers the >=2-caller hub (h) over the heaviest leaf', hubbed.stringTable[hubbed.funcTable.name[vh.focalFunc]] === 'h', hubbed.stringTable[hubbed.funcTable.name[vh.focalFunc]]);

console.log(`\nsandwich: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
