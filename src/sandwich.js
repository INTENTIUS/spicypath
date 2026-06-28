// Sandwich view: for a focal function F, build two aggregated trees (both rooted at F):
//   callees — merge the subtrees below every occurrence of F (what F calls)
//   callers — merge the inverted ancestor paths above every occurrence (who calls F)
// Both come out CallNodeTable-shaped, so layout()/paint are reused. Pure JS, shared.

function newTree(focalFunc) {
  return { func: [focalFunc], prefix: [-1], total: [0], children: [[]], _map: [new Map()] };
}
function getOrCreate(T, parent, func) {
  let d = T._map[parent].get(func);
  if (d === undefined) {
    d = T.func.length;
    T.func.push(func); T.prefix.push(parent); T.total.push(0); T.children.push([]); T._map.push(new Map());
    T.children[parent].push(d); T._map[parent].set(func, d);
  }
  return d;
}
function finalize(T) {
  const n = T.func.length;
  const depth = new Array(n);
  for (let i = 0; i < n; i++) depth[i] = T.prefix[i] < 0 ? 0 : depth[T.prefix[i]] + 1;
  const self = T.total.slice();
  for (let i = 0; i < n; i++) for (const c of T.children[i]) self[i] -= T.total[c];
  for (let i = 0; i < n; i++) if (self[i] < 0) self[i] = 0;
  const byTotal = (a, b) => T.total[b] - T.total[a];
  for (const c of T.children) c.sort(byTotal);
  return { func: T.func, prefix: T.prefix, depth, self, total: T.total, children: T.children, roots: [0], grandTotal: T.total[0] };
}

function buildCallees(ct, focalFunc, occ) {
  const T = newTree(focalFunc);
  const mergeDown = (src, dst) => {
    for (const c of ct.children[src]) {
      const d = getOrCreate(T, dst, ct.func[c]);
      T.total[d] += ct.total[c];
      mergeDown(c, d);
    }
  };
  for (const o of occ) { T.total[0] += ct.total[o]; mergeDown(o, 0); }
  return finalize(T);
}

function buildCallers(ct, focalFunc, occ) {
  const T = newTree(focalFunc);
  for (const o of occ) {
    const w = ct.total[o];
    T.total[0] += w;
    let cur = 0, p = ct.prefix[o];
    while (p >= 0) { const d = getOrCreate(T, cur, ct.func[p]); T.total[d] += w; cur = d; p = ct.prefix[p]; }
  }
  return finalize(T);
}

export function buildSandwich(p, ct, focalFunc) {
  const occ = [];
  for (let n = 0; n < ct.func.length; n++) if (ct.func[n] === focalFunc) occ.push(n);
  return { focalFunc, callers: buildCallers(ct, focalFunc, occ), callees: buildCallees(ct, focalFunc, occ), occurrences: occ.length };
}
