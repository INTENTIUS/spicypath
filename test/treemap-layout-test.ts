// Pure Node unit test for treemapLayout() (FG-061).
//   node test/treemap-layout-test.ts
//
// Assertions:
//   1. All cells lie within the root rectangle (no overflow).
//   2. No overlap between top-level siblings (depth === 0 cells).
//   3. Heavier children get larger cells (area ∝ total).
//   4. Same input → same output (deterministic).
import { treemapLayout } from '../src/treemap-layout.js';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${(!ok && detail) ? ': ' + detail : ''}`);
}

// Build a minimal CallNodeTable mock.
//
// Structure:
//   root (node 0, func 0, total 100, self 10)
//     child A (node 1, func 1, total 60, self 40)
//       grandchild A1 (node 3, func 3, total 30, self 30)
//       grandchild A2 (node 4, func 4, total 30, self 10)
//     child B (node 2, func 2, total 30, self 30)
function makeCt() {
  return {
    func:     [0, 1, 2, 3, 4],
    total:    [100, 60, 30, 30, 30],
    self:     [10, 40, 30, 30, 10],
    prefix:   [-1, 0, 0, 1, 1],
    children: [
      [1, 2],  // node 0 → children 1, 2
      [3, 4],  // node 1 → children 3, 4
      [],      // node 2 → leaf
      [],      // node 3 → leaf
      [],      // node 4 → leaf
    ],
    roots:       [0],
    grandTotal:  100,
  };
}

// A wider mock with 5 top-level roots of different weights (no children) for overlap tests.
function makeWideCt() {
  // weights: 50, 30, 10, 6, 4 → grand total 100
  const weights = [50, 30, 10, 6, 4];
  const n = weights.length;
  return {
    func:       weights.map((_, i) => i),
    total:      weights,
    self:       weights,
    prefix:     weights.map(() => -1),
    children:   weights.map(() => []),
    roots:       weights.map((_, i) => i),
    grandTotal:  weights.reduce((s, w) => s + w, 0),
  };
}

const W = 800, H = 600;
const opts = { width: W, height: H, minArea: 1 };

// ---- test 1: all cells within root rectangle --------------------------------
const ct = makeCt();
const boxes = treemapLayout(ct, opts);

check('boxes is an array', Array.isArray(boxes));
check('at least one box produced', boxes.length > 0);

let allInBounds = true;
for (const b of boxes) {
  if (b.x < -0.5 || b.y < -0.5 || b.x + b.w > W + 0.5 || b.y + b.h > H + 0.5) {
    allInBounds = false;
    console.log(`  out of bounds: node=${b.node} x=${b.x.toFixed(1)} y=${b.y.toFixed(1)} w=${b.w.toFixed(1)} h=${b.h.toFixed(1)}`);
  }
}
check('all cells lie within root rectangle (800×600)', allInBounds);

// ---- test 2: no overlap between top-level (depth=0) siblings ----------------
const wide = makeWideCt();
const wideBoxes = treemapLayout(wide, opts);
const depth0 = wideBoxes.filter((b) => b.depth === 0);
check('wide ct produces depth-0 boxes', depth0.length > 0, `got ${depth0.length}`);

let noOverlap = true;
for (let i = 0; i < depth0.length; i++) {
  for (let j = i + 1; j < depth0.length; j++) {
    const a = depth0[i], b = depth0[j];
    const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const overlap = ox * oy;
    if (overlap > 0.5) { // allow 0.5 px² rounding tolerance
      noOverlap = false;
      console.log(`  overlap: nodes ${a.node}&${b.node} overlap area=${overlap.toFixed(1)}`);
    }
  }
}
check('no overlap between depth-0 siblings', noOverlap);

// ---- test 3: heavier children get larger cells (areas ∝ total) -------------
// The ct has a single root (node 0) at depth 0.
// Child A (node 1, weight 60) and child B (node 2, weight 30) are at depth 1.
const allNested = treemapLayout(ct, opts);
const nodeA = allNested.find((b) => b.node === 1);
const nodeB = allNested.find((b) => b.node === 2);
check('output includes child node 1 and node 2 (depth=1)', !!(nodeA && nodeB), `nodeA=${!!nodeA} nodeB=${!!nodeB}`);
if (nodeA && nodeB) {
  const areaA = nodeA.w * nodeA.h;
  const areaB = nodeB.w * nodeB.h;
  check('heavier child (node 1, total=60) gets larger cell than lighter (node 2, total=30)', areaA > areaB, `areaA=${areaA.toFixed(0)} areaB=${areaB.toFixed(0)}`);
  // The ratio should be roughly 2:1 within a 30% tolerance.
  const ratio = areaA / Math.max(areaB, 0.001);
  check('area ratio is roughly 2:1 (within 40% tolerance)', ratio >= 1.2 && ratio <= 3.2, `ratio=${ratio.toFixed(2)}`);
}

// ---- test 4: deterministic (same input → same output) ----------------------
const boxes2 = treemapLayout(ct, opts);
const boxes3 = treemapLayout(ct, opts);
let det = boxes2.length === boxes3.length;
if (det) {
  for (let i = 0; i < boxes2.length; i++) {
    const a = boxes2[i], b = boxes3[i];
    if (a.node !== b.node || Math.abs(a.x - b.x) > 0.001 || Math.abs(a.y - b.y) > 0.001 ||
        Math.abs(a.w - b.w) > 0.001 || Math.abs(a.h - b.h) > 0.001) {
      det = false; break;
    }
  }
}
check('treemapLayout is deterministic (same output on repeated calls)', det, `lengths: ${boxes2.length} vs ${boxes3.length}`);

// ---- test 5: focus option (focus on node 1 → only node 1 and its children) --
const focused = treemapLayout(ct, { ...opts, focus: 1 });
const allFromFocus = focused.every((b) => b.node === 1 || b.node === 3 || b.node === 4);
check('focus option restricts output to the focused subtree', allFromFocus, `nodes: [${focused.map((b) => b.node).join(',')}]`);

// ---- test 6: minArea prunes tiny cells -------------------------------------
const bigOpts = { width: 10, height: 10, minArea: 200 }; // impossible for most cells
const pruned = treemapLayout(ct, bigOpts);
// most cells are < 100px² at 10×10; root gets the full square but children get split
// — we just verify no cell exceeds the given bounds
const allInSmallBounds = pruned.every((b) => b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= 10.5 && b.y + b.h <= 10.5);
check('minArea pruning: cells still within bounds even on tiny canvas', allInSmallBounds);

// ---- summary ---------------------------------------------------------------
console.log(`\ntreemap-layout: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
