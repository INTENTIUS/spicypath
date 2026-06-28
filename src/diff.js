// Diff two profiles: merge their call trees by function-NAME path (the profiles have
// independent func tables), normalize each to fractions, and produce a layout-compatible
// CallNodeTable with per-node `delta` = fracB − fracA, plus a synthetic profile (string/
// func tables) for labels. Width = max(fracA, fracB) so added AND removed frames show.
// Pure (browser + Node).
import { buildCallNodeTable } from './callnode.js';

export function buildDiff(pA, pB, wtA, wtB) {
  const ctA = buildCallNodeTable(pA, 0, wtA || pA.capabilities.weightTypes[0]);
  const ctB = buildCallNodeTable(pB, 0, wtB || pB.capabilities.weightTypes[0]);

  // synthetic label tables (unified across both profiles)
  const stringTable = [], funcTable = { name: [], file: [], line: [] }, funcByName = new Map();
  const unifiedFunc = (nm) => { let i = funcByName.get(nm); if (i === undefined) { const s = stringTable.length; stringTable.push(nm); i = funcTable.name.length; funcTable.name.push(s); funcTable.file.push(-1); funcTable.line.push(-1); funcByName.set(nm, i); } return i; };
  const nameOf = (srcP, srcCt, node) => srcP.stringTable[srcP.funcTable.name[srcCt.func[node]]] || '';

  // union tree (index 0 = synthetic root)
  const func = [unifiedFunc('all')], prefix = [-1], fracA = [0], fracB = [0], children = [[]], byName = [new Map()];
  function add(srcP, srcCt, srcNode, uni, gt, which) {
    const fr = srcCt.total[srcNode] / gt;
    if (which === 'A') fracA[uni] += fr; else fracB[uni] += fr;
    for (const c of srcCt.children[srcNode]) {
      const nm = nameOf(srcP, srcCt, c);
      let u = byName[uni].get(nm);
      if (u === undefined) { u = func.length; func.push(unifiedFunc(nm)); prefix.push(uni); fracA.push(0); fracB.push(0); children.push([]); byName.push(new Map()); children[uni].push(u); byName[uni].set(nm, u); }
      add(srcP, srcCt, c, u, gt, which);
    }
  }
  for (const r of ctA.roots) add(pA, ctA, r, 0, ctA.grandTotal || 1, 'A');
  for (const r of ctB.roots) add(pB, ctB, r, 0, ctB.grandTotal || 1, 'B');

  const n = func.length, total = new Array(n), delta = new Array(n), self = new Array(n);
  for (let i = 0; i < n; i++) { total[i] = Math.max(fracA[i], fracB[i]); delta[i] = fracB[i] - fracA[i]; }
  for (let i = 0; i < n; i++) { let s = total[i]; for (const c of children[i]) s -= total[c]; self[i] = s < 0 ? 0 : s; }
  const depth = new Array(n); depth[0] = -1;
  for (let i = 1; i < n; i++) depth[i] = prefix[i] === 0 ? 0 : depth[prefix[i]] + 1;
  const byTotal = (a, b) => total[b] - total[a];
  for (const c of children) c.sort(byTotal);
  const roots = children[0].slice().sort(byTotal);
  let grandTotal = 0; for (const r of roots) grandTotal += total[r];
  let maxAbsDelta = 0; for (let i = 1; i < n; i++) if (Math.abs(delta[i]) > maxAbsDelta) maxAbsDelta = Math.abs(delta[i]);

  const ct = { func, prefix, depth, self, total, delta, children, roots, grandTotal };
  const profile = { stringTable, funcTable, frameTable: { func: [], line: [], inlineDepth: [] }, stackTable: { frame: [], prefix: [] }, threads: [], metrics: [], capabilities: { hasTiming: false, weightTypes: ['diff'], isDiff: true } };
  return { ct, profile, maxAbsDelta, fracA, fracB };
}
