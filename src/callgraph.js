// Call-graph model: fold the CallNodeTable into a function-level directed graph.
// Pure JS (browser + Node) — no DOM, no node: imports.
//
// buildCallGraph(ct, profile) → { nodes, edges, byFunc, grandTotal }
//
// NODES
//   One per distinct function that appears in the CallNodeTable. Each node is
//   sourced directly from functionStats() so self/total are computed with the
//   same recursion-safe once-per-sample semantics used everywhere else:
//     node = { func, name, file, line, self, total }
//   `byFunc` is a Map<funcIndex, node> for O(1) lookup.
//
// EDGES
//   One per distinct (callerFunc → calleeFunc) function pair.  Built by scanning
//   every call-node i with a parent p = ct.prefix[i] >= 0; the function-level edge
//   is (ct.func[p] → ct.func[i]).
//     edge = { from, to, cost, count, selfEdge }
//   `cost`     — sum of ct.total[i] over all call-nodes i that map to this
//                (from, to) pair.  Represents the total weight flowing through
//                this caller→callee transition in the call tree.  Under recursion
//                this can be less than the callee node's `total` (because total is
//                deduplicated per sample by functionStats, but cost is a raw sum of
//                call-tree totals).
//   `count`    — number of distinct call-tree edges (call-node pairs) that were
//                collapsed into this function-pair edge.
//   `selfEdge` — true when from === to (the function calls itself directly or
//                indirectly within a single contiguous run on the stack).  Marked
//                so later phases (layout, render) can handle it distinctly.
//
// ROOTS
//   Call-nodes with prefix === -1 have no caller; they contribute no edge.  The
//   model does not add a synthetic root node.  Callers can identify root functions
//   by looking for functions whose func index never appears as the `to` of any edge
//   (or by checking byFunc vs the set of all edge targets).
//
// CYCLES
//   The edge set faithfully represents the call graph, which may contain cycles
//   (e.g. mutual recursion).  Cycle detection and back-edge marking are a Phase 2
//   (layout) concern; this module does not break cycles.

import { functionStats } from './funcstats.js';

/**
 * @param {object} ct  - CallNodeTable from buildCallNodeTable()
 * @param {object} profile - canonical Profile
 * @returns {{ nodes: Array, edges: Array, byFunc: Map, grandTotal: number }}
 */
export function buildCallGraph(ct, profile) {
  // ---- nodes ----------------------------------------------------------------
  // Reuse functionStats for the authoritative, recursion-safe self/total values.
  const stats = functionStats(ct, profile);

  /** @type {Map<number, object>} func index → node */
  const byFunc = new Map();
  for (const s of stats) {
    byFunc.set(s.func, { func: s.func, name: s.name, file: s.file, line: s.line, self: s.self, total: s.total });
  }
  const nodes = [...byFunc.values()];

  // ---- edges ----------------------------------------------------------------
  // Key: `${from}#${to}` → accumulated { from, to, cost, count, selfEdge }
  /** @type {Map<string, object>} */
  const edgeMap = new Map();

  const n = ct.func.length;
  for (let i = 0; i < n; i++) {
    const p = ct.prefix[i];
    if (p < 0) continue; // root call-node — no caller edge

    const from = ct.func[p];
    const to   = ct.func[i];
    const key  = `${from}#${to}`;

    let e = edgeMap.get(key);
    if (!e) {
      e = { from, to, cost: 0, count: 0, selfEdge: from === to };
      edgeMap.set(key, e);
    }
    e.cost  += ct.total[i];
    e.count += 1;
  }

  const edges = [...edgeMap.values()];

  return { nodes, edges, byFunc, grandTotal: ct.grandTotal };
}
