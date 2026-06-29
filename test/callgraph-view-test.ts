// GraphView headless test (FG-051 phase 3).
// Verifies: relayout produces positioned nodes, draw() throws no exception,
// _hit() returns a node inside a rect and null outside, clicking sets selectedFunc,
// and GraphView.capabilities is correct.
//   node test/callgraph-view-test.ts
import { GraphView } from '../src/view-callgraph.js';
import { parseFoldedText } from '../src/parse-folded.js';

// ---- Headless canvas stub (same pattern as escape-test.ts / sandwich-test.ts) ----
const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
const els: Record<string, any> = {};
const mk = () => ({
  innerHTML: '',
  style: {},
  addEventListener() {},
  removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
  clientWidth: 1000,
  parentElement: { clientWidth: 1000 },
  getContext: () => ctx,
  width: 0,
  height: 0,
  offsetTop: 0,
  dataset: {},
  querySelectorAll: () => [],
});
(globalThis as any).requestAnimationFrame = () => 1;
(globalThis as any).window = {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  innerHeight: 800,
  requestAnimationFrame: () => 1,
};
(globalThis as any).document = {
  getElementById: (id: string) => els[id] || (els[id] = mk()),
  addEventListener() {},
  body: { style: {} },
};

// ---- Assertions ----
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

// ---- Fixture: a simple tree with a few functions ----
// Stacks: main;http.serve;router.handle;db.query (wt 50)
//         main;http.serve;router.handle;json.encode (wt 30)
//         main;runtime.gc;gc.mark (wt 20)
const profile = parseFoldedText(
  'main;http.serve;router.handle;db.query 50\n' +
  'main;http.serve;router.handle;json.encode 30\n' +
  'main;runtime.gc;gc.mark 20\n'
);

const canvas = mk();
let view: any;
try {
  view = new GraphView(canvas, profile, 'samples', 'graph');
} catch (e: any) {
  console.error('constructor threw:', e.message);
  process.exit(1);
}

// 1. relayout produced positioned nodes.
const nodes: any[] = view._nodes;
check('relayout: nodes array is non-empty', nodes.length > 0, `count=${nodes.length}`);

// The folded fixture has 7 distinct functions (main, http.serve, router.handle,
// db.query, json.encode, runtime.gc, gc.mark).
check('relayout: 7 nodes for 7 distinct functions', nodes.length === 7, String(nodes.length));

// Every node must have finite numeric layout fields.
const allFinite = nodes.every(
  (n: any) => Number.isFinite(n.x) && Number.isFinite(n.y) &&
               Number.isFinite(n.w) && n.w > 0 &&
               Number.isFinite(n.h) && n.h > 0
);
check('relayout: every node has finite x/y/w/h', allFinite);

// 2. draw() must not throw.
let drawOk = false;
try { view.draw(); drawOk = true; } catch (e: any) { console.error('draw() threw:', e.message); }
check('draw(): no exception on headless stub', drawOk);

// 3. _hit() returns the node whose rect contains the point, null otherwise.
// Pick the first node and hit its centre.
const firstNode = nodes[0];
const cx = firstNode.x + firstNode.w / 2;
const cy = firstNode.y + firstNode.h / 2;
const hitInside = view._hit(cx, cy);
check('_hit(centre of first node) returns that node', hitInside === firstNode,
  hitInside ? `got func=${hitInside.func} expected func=${firstNode.func}` : 'got null');

// Hit well outside the graph bounding box → null.
const hitOutside = view._hit(-999, -999);
check('_hit(-999,-999) returns null', hitOutside === null);

// Hit beyond the last node's bottom-right → null.
const lastNode = nodes[nodes.length - 1];
const hitFarRight = view._hit(lastNode.x + lastNode.w + 500, lastNode.y + lastNode.h + 500);
check('_hit far past last node returns null', hitFarRight === null);

// 4. Clicking inside a node sets selectedFunc on the view.
// Simulate a click event at the centre of the first node.
const fakeClickEvent = {
  clientX: cx,           // getBoundingClientRect returns { left:0, top:0 }, so px=cx
  clientY: cy,
};
view._onClick(fakeClickEvent);
check('_onClick on first node sets selectedFunc', view.selectedFunc === firstNode.func,
  `selectedFunc=${view.selectedFunc} firstNode.func=${firstNode.func}`);

// Clicking in empty space should not throw (selectedFunc stays as-is or changes).
let clickEmptyOk = false;
try {
  view._onClick({ clientX: -100, clientY: -100 });
  clickEmptyOk = true;
} catch (e: any) { console.error('_onClick empty space threw:', e.message); }
check('_onClick on empty space does not throw', clickEmptyOk);

// 5. GraphView.capabilities.
check("GraphView.capabilities.modes is ['graph']",
  Array.isArray((GraphView as any).capabilities.modes) &&
  (GraphView as any).capabilities.modes.length === 1 &&
  (GraphView as any).capabilities.modes[0] === 'graph',
  JSON.stringify((GraphView as any).capabilities.modes));
check('GraphView.capabilities.minimap is false',
  (GraphView as any).capabilities.minimap === false);

// 6. dispose() should not throw.
let disposeOk = false;
try { view.dispose(); disposeOk = true; } catch (e: any) { console.error('dispose() threw:', e.message); }
check('dispose() does not throw', disposeOk);

// ---- Summary ----
console.log(`\ncallgraph-view: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
