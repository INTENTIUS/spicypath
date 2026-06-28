// The hover tooltip builds innerHTML, so it MUST escape function names — they can contain
// <, >, & (e.g. <init>, <clinit>, C++ vector<int>, lambdas). Regression guard for the bug
// where the tooltip injected raw names.  node test/escape-test.ts
import { FlameView } from '../src/render-canvas.js';
import { parseSpeedscopeText } from '../src/parse-speedscope.js';

const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
const els: Record<string, any> = {};
const mk = () => ({ innerHTML: '', style: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 1000, parentElement: { clientWidth: 1000 }, getContext: () => ctx, width: 0, height: 0, offsetTop: 0 });
(globalThis as any).requestAnimationFrame = () => 1;
(globalThis as any).window = { devicePixelRatio: 1, addEventListener() {}, innerHeight: 800, requestAnimationFrame: () => 1 };
(globalThis as any).document = { getElementById: (id: string) => els[id] || (els[id] = mk()), addEventListener() {}, body: { style: {} } };

const EVIL = '<img src=x onerror=alert(1)> & vector<int>';
const ss = JSON.stringify({
  $schema: 'x', shared: { frames: [{ name: 'root' }, { name: EVIL }] },
  profiles: [{ type: 'sampled', unit: 'none', startValue: 0, endValue: 2, samples: [[0, 1], [0, 1]], weights: [1, 1] }],
});
const p = parseSpeedscopeText(ss);
const v = new FlameView(mk(), p, 'samples', 'graph');
v.setCollapse(false); // keep the EVIL leaf as its own box so we test the name path directly
const evilFunc = p.funcTable.name.findIndex((s: number) => p.stringTable[s] === EVIL);
const box = v.boxes.find((b: any) => b.func === evilFunc) || v.boxes[v.boxes.length - 1];
v._tooltip(box, { clientX: 0, clientY: 0 });
const html = els.tt.innerHTML || '';
const ok = !/<img/i.test(html) && html.includes('&lt;img');
console.log('tooltip html:', html.replace(/\s+/g, ' ').slice(0, 90));
console.log(ok ? 'escape: PASS — tooltip escapes <,>,&' : 'escape: FAIL — raw HTML leaked into the tooltip');
process.exit(ok ? 0 : 1);
