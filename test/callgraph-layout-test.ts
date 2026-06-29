// Phase 2 call-graph layout tests (FG-051 / P2).
// Tests layoutCallGraph() — pure Sugiyama-style layered layout.
//   node test/callgraph-layout-test.ts
import { readFileSync } from 'node:fs';
import { ingestBytes } from '../src/ingest.js';
import { buildCallNodeTable } from '../src/callnode.js';
import { buildCallGraph } from '../src/callgraph.js';
import { layoutCallGraph } from '../src/callgraph-layout.js';
import { parseFoldedText } from '../src/parse-folded.js';
import type { Profile } from '../src/model.ts';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${(!ok && detail) ? ': ' + detail : ''}`);
}

function ct(p: Profile, wt?: string) {
  const weightType = wt ?? p.capabilities.weightTypes[0];
  return buildCallNodeTable(p, 0, weightType);
}

function funcName(p: Profile, funcIdx: number): string {
  return p.stringTable[p.funcTable.name[funcIdx]] ?? '';
}

// ---- Helper: check layering invariant for a laid-out graph -------------------
// Every forward (non-back) edge must go from a strictly lower rank to higher rank.
function checkLayeringValid(lg: any): boolean {
  for (const e of lg.edges) {
    if (e.backEdge) continue;
    const fromNode = lg.nodes.find((n: any) => n.func === e.from);
    const toNode   = lg.nodes.find((n: any) => n.func === e.to);
    if (!fromNode || !toNode) return false;
    if (fromNode.rank >= toNode.rank) return false;
  }
  return true;
}

// ---- Helper: check all nodes have finite numeric layout fields ---------------
function checkCompleteness(lg: any): boolean {
  for (const n of lg.nodes) {
    if (!Number.isFinite(n.rank) || n.rank < 0) return false;
    if (!Number.isFinite(n.order) || n.order < 0) return false;
    if (!Number.isFinite(n.x)) return false;
    if (!Number.isFinite(n.y)) return false;
    if (!Number.isFinite(n.w) || n.w <= 0) return false;
    if (!Number.isFinite(n.h) || n.h <= 0) return false;
  }
  return true;
}

// ---- Helper: minimum rank is 0 -----------------------------------------------
function checkRankStartsAtZero(lg: any): boolean {
  if (lg.nodes.length === 0) return true;
  return lg.nodes.some((n: any) => n.rank === 0);
}

// ---- Helper: layout is deterministic (call twice, compare) -------------------
function checkDeterministic(graph: any): boolean {
  const a = layoutCallGraph(graph);
  const b = layoutCallGraph(graph);
  for (let i = 0; i < a.nodes.length; i++) {
    const na = a.nodes[i], nb = b.nodes[i];
    if (na.rank !== nb.rank || na.order !== nb.order || na.x !== nb.x || na.y !== nb.y) return false;
  }
  for (let i = 0; i < a.edges.length; i++) {
    const ea = a.edges[i], eb = b.edges[i];
    if (ea.backEdge !== eb.backEdge) return false;
    if (ea.points.length !== eb.points.length) return false;
    for (let j = 0; j < ea.points.length; j++) {
      if (ea.points[j].x !== eb.points[j].x || ea.points[j].y !== eb.points[j].y) return false;
    }
  }
  return true;
}

// ============================================================================
// FIXTURE: wide-fanout
// Stacks: main;svc.dispatch;handler.hN — 3-level tree, no cycles.
// Expected: 3 distinct ranks (0=main, 1=svc.dispatch, 2=handler.hN).
// ============================================================================
{
  const p = await ingestBytes('wide-fanout.folded', new Uint8Array(readFileSync('test/testdata/wide-fanout.folded')));
  const table = ct(p);
  const graph = buildCallGraph(table, p);
  const lg = layoutCallGraph(graph);

  check('wide-fanout: layering valid (all forward edges rank(from) < rank(to))', checkLayeringValid(lg));
  check('wide-fanout: all nodes have finite rank/order/x/y/w/h', checkCompleteness(lg));
  check('wide-fanout: rank starts at 0', checkRankStartsAtZero(lg));

  // No cycles in this fixture → no back-edges (except possible self-edges, of which there are none)
  const backCount = lg.edges.filter((e: any) => e.backEdge).length;
  check('wide-fanout: no back-edges (acyclic fixture)', backCount === 0, `found ${backCount}`);

  // 3-level stacks → exactly 3 ranks (0,1,2)
  const ranks = new Set(lg.nodes.map((n: any) => n.rank));
  check('wide-fanout: exactly 3 distinct ranks', ranks.size === 3, `ranks: ${[...ranks].sort().join(',')}`);

  // main must be at rank 0
  const mainNode = lg.nodes.find((n: any) => n.name === 'main');
  check('wide-fanout: main is at rank 0', mainNode?.rank === 0, `rank=${mainNode?.rank}`);

  // svc.dispatch must be at rank 1
  const dispNode = lg.nodes.find((n: any) => n.name === 'svc.dispatch');
  check('wide-fanout: svc.dispatch is at rank 1', dispNode?.rank === 1, `rank=${dispNode?.rank}`);

  // All handler.hN nodes must be at rank 2
  const handlerNodes = lg.nodes.filter((n: any) => n.name.startsWith('handler.h'));
  const allRank2 = handlerNodes.every((n: any) => n.rank === 2);
  check(`wide-fanout: all 24 handler.hN nodes at rank 2`, allRank2 && handlerNodes.length === 24,
    `count=${handlerNodes.length} allRank2=${allRank2}`);

  // Each edge has points (2 points for straight lines)
  const allHavePoints = lg.edges.every((e: any) => Array.isArray(e.points) && e.points.length === 2);
  check('wide-fanout: every edge has 2 points', allHavePoints);

  // Determinism
  check('wide-fanout: layout is deterministic', checkDeterministic(graph));
}

// ============================================================================
// FIXTURE: deep-recursion
// app.fib calls itself → self-edge. The self-edge must be a back-edge and
// must not affect app.fib's rank assignment.
// ============================================================================
{
  const p = await ingestBytes('deep-recursion.pprof', new Uint8Array(readFileSync('test/testdata/deep-recursion.pprof')));
  const table = ct(p);
  const graph = buildCallGraph(table, p);
  const lg = layoutCallGraph(graph);

  check('deep-recursion: layering valid', checkLayeringValid(lg));
  check('deep-recursion: all nodes have finite layout fields', checkCompleteness(lg));
  check('deep-recursion: rank starts at 0', checkRankStartsAtZero(lg));

  // Self-edge on app.fib must be marked backEdge:true
  const selfEdges = lg.edges.filter((e: any) => e.selfEdge);
  check('deep-recursion: at least one self-edge', selfEdges.length > 0, `found ${selfEdges.length}`);
  const allSelfAreBack = selfEdges.every((e: any) => e.backEdge);
  check('deep-recursion: all self-edges are backEdge:true', allSelfAreBack);

  // app.fib should be at rank > 0 (main is at 0, app.handle at 1, app.fib at 2)
  const fibNode = lg.nodes.find((n: any) => n.name === 'app.fib');
  check('deep-recursion: app.fib has a rank > 0 (is not a root)', fibNode != null && fibNode.rank > 0,
    `rank=${fibNode?.rank}`);

  // main is a root → rank 0
  const mainNode = lg.nodes.find((n: any) => n.name === 'main');
  check('deep-recursion: main is at rank 0', mainNode?.rank === 0, `rank=${mainNode?.rank}`);

  // Determinism
  check('deep-recursion: layout is deterministic', checkDeterministic(graph));
}

// ============================================================================
// FIXTURE: tiny
// Stacks: main;http.serve;router.handle;db.query (wt 50)
//         main;http.serve;router.handle;json.encode (wt 30)
//         main;runtime.gc;gc.mark (wt 20)
// DAG, no cycles.
// ============================================================================
{
  const p = await ingestBytes('tiny.pprof', new Uint8Array(readFileSync('test/testdata/tiny.pprof')));
  const table = ct(p);
  const graph = buildCallGraph(table, p);
  const lg = layoutCallGraph(graph);

  check('tiny: layering valid', checkLayeringValid(lg));
  check('tiny: all nodes have finite layout fields', checkCompleteness(lg));
  check('tiny: rank starts at 0', checkRankStartsAtZero(lg));
  check('tiny: no back-edges (acyclic fixture)', lg.edges.every((e: any) => !e.backEdge));
  check('tiny: 7 nodes', lg.nodes.length === 7, String(lg.nodes.length));

  // main → rank 0
  const mainNode = lg.nodes.find((n: any) => n.name === 'main');
  check('tiny: main at rank 0', mainNode?.rank === 0, `rank=${mainNode?.rank}`);

  // db.query and json.encode are at the same rank (longest path = 3)
  const dbNode   = lg.nodes.find((n: any) => n.name === 'db.query');
  const jsonNode = lg.nodes.find((n: any) => n.name === 'json.encode');
  check('tiny: db.query and json.encode at the same rank', dbNode?.rank === jsonNode?.rank,
    `db=${dbNode?.rank} json=${jsonNode?.rank}`);

  // gc.mark: main;runtime.gc;gc.mark → rank 2
  const gcMarkNode = lg.nodes.find((n: any) => n.name === 'gc.mark');
  check('tiny: gc.mark at rank 2', gcMarkNode?.rank === 2, `rank=${gcMarkNode?.rank}`);

  check('tiny: layout is deterministic', checkDeterministic(graph));
}

// ============================================================================
// HAND-BUILT CYCLE: A→B→C→A
// Three functions in a cycle. The DFS will find exactly one back-edge to
// break the cycle. The remaining two forward edges must satisfy rank(from) < rank(to).
// All three nodes must receive finite ranks.
// ============================================================================
{
  // Build a minimal profile with stacks that produce the A→B→C→A cycle.
  // Folded format: each line is a stack (root→leaf separated by ;).
  // Stack A;B;C;A produces: A→B, B→C, C→A (which is a back-edge in DFS from A).
  // We also need a root entry to give A some self weight.
  const cycleText = [
    'A;B;C;A 10',  // produces edges A→B, B→C, C→A
  ].join('\n');
  const p = parseFoldedText(cycleText);
  const table = buildCallNodeTable(p, 0, 'samples');
  const graph = buildCallGraph(table, p);
  const lg = layoutCallGraph(graph);

  check('cycle A→B→C→A: all nodes have finite layout fields', checkCompleteness(lg));
  check('cycle A→B→C→A: rank starts at 0', checkRankStartsAtZero(lg));
  check('cycle A→B→C→A: layering valid (forward edges strict rank increase)', checkLayeringValid(lg));

  // Count back-edges among the 3 cycle edges.
  // A→B→C→A has 3 edges in the graph; the DFS from A will visit A(gray)→B→C→A(gray=back).
  // So exactly 1 back-edge (C→A).
  const cycleEdgeCount = graph.edges.length;
  const backEdges = lg.edges.filter((e: any) => e.backEdge);
  check('cycle A→B→C→A: exactly 3 edges in graph model', cycleEdgeCount === 3, String(cycleEdgeCount));
  check('cycle A→B→C→A: exactly 1 back-edge to break cycle', backEdges.length === 1,
    `backEdges=${backEdges.length}`);

  // All 3 nodes must be ranked
  check('cycle A→B→C→A: all 3 nodes get a rank', lg.nodes.length === 3 && lg.nodes.every((n: any) => n.rank >= 0),
    `nodes=${lg.nodes.length}`);

  // The forward DAG A→B→C is a simple chain; A=rank0, B=rank1, C=rank2.
  const nodeA = lg.nodes.find((n: any) => n.name === 'A');
  const nodeB = lg.nodes.find((n: any) => n.name === 'B');
  const nodeC = lg.nodes.find((n: any) => n.name === 'C');
  check('cycle A→B→C→A: A at rank 0', nodeA?.rank === 0, `rank=${nodeA?.rank}`);
  check('cycle A→B→C→A: B at rank 1', nodeB?.rank === 1, `rank=${nodeB?.rank}`);
  check('cycle A→B→C→A: C at rank 2', nodeC?.rank === 2, `rank=${nodeC?.rank}`);

  // Back-edge should be C→A (not A→B or B→C)
  const backEdge = backEdges[0];
  const backFromName = lg.nodes.find((n: any) => n.func === backEdge?.from)?.name;
  const backToName   = lg.nodes.find((n: any) => n.func === backEdge?.to)?.name;
  check('cycle A→B→C→A: back-edge is C→A', backFromName === 'C' && backToName === 'A',
    `back-edge: ${backFromName}→${backToName}`);

  check('cycle A→B→C→A: layout is deterministic', checkDeterministic(graph));
}

// ============================================================================
// HAND-BUILT: Self-edge only (recursive leaf)
// A self-calling function A (A→A). Self-edge must be backEdge:true and A
// should be at rank 0 (no incoming forward edges → source).
// ============================================================================
{
  // Stack: A;A — produces a self-call edge A→A.
  const selfText = 'A;A 5\nA 3\n';
  const p = parseFoldedText(selfText);
  const table = buildCallNodeTable(p, 0, 'samples');
  const graph = buildCallGraph(table, p);
  const lg = layoutCallGraph(graph);

  check('self-edge: all nodes have finite layout fields', checkCompleteness(lg));
  check('self-edge: A is at rank 0 (self-edge excluded from ranking)', lg.nodes[0]?.rank === 0,
    `rank=${lg.nodes[0]?.rank}`);

  const selfEdge = lg.edges.find((e: any) => e.selfEdge);
  check('self-edge: self-edge is backEdge:true', selfEdge?.backEdge === true);
  check('self-edge: layering valid', checkLayeringValid(lg));
  check('self-edge: layout is deterministic', checkDeterministic(graph));
}

// ============================================================================
// INVARIANT: opts forwarded — custom nodeW/nodeH/rankGap/orderGap honored
// ============================================================================
{
  const p = await ingestBytes('tiny.folded', new Uint8Array(readFileSync('test/testdata/tiny.folded')));
  const table = ct(p);
  const graph = buildCallGraph(table, p);
  const opts = { nodeW: 200, nodeH: 60, rankGap: 100, orderGap: 30 };
  const lg = layoutCallGraph(graph, opts);

  // Every node should have w=200, h=60.
  const allSized = lg.nodes.every((n: any) => n.w === 200 && n.h === 60);
  check('custom opts: every node has w=200, h=60', allSized);

  // main is at rank 0, order 0 → x=0, y=0.
  const mainNode = lg.nodes.find((n: any) => n.name === 'main');
  check('custom opts: main is at x=0, y=0', mainNode?.x === 0 && mainNode?.y === 0,
    `x=${mainNode?.x} y=${mainNode?.y}`);

  // A node at rank 1 should have y = 1 * (60 + 100) = 160.
  const rank1Nodes = lg.nodes.filter((n: any) => n.rank === 1);
  const allRank1Y = rank1Nodes.every((n: any) => n.y === 160);
  check('custom opts: rank-1 nodes have y=160 (1*(h+rankGap))', allRank1Y && rank1Nodes.length > 0,
    `count=${rank1Nodes.length} y=${rank1Nodes[0]?.y}`);

  check('custom opts: layering valid', checkLayeringValid(lg));
}

// ============================================================================
// MUTUAL RECURSION: A→B→A (2-node cycle)
// ============================================================================
{
  const mutualText = 'A;B;A 8\nA 2\n';
  const p = parseFoldedText(mutualText);
  const table = buildCallNodeTable(p, 0, 'samples');
  const graph = buildCallGraph(table, p);
  const lg = layoutCallGraph(graph);

  check('mutual A↔B: layering valid', checkLayeringValid(lg));
  check('mutual A↔B: all nodes finite layout fields', checkCompleteness(lg));
  check('mutual A↔B: rank starts at 0', checkRankStartsAtZero(lg));

  // 2 edges: A→B (forward), B→A (back)
  const backEdges = lg.edges.filter((e: any) => e.backEdge);
  check('mutual A↔B: exactly 1 back-edge', backEdges.length === 1, String(backEdges.length));

  check('mutual A↔B: layout is deterministic', checkDeterministic(graph));
}

// ---- summary ---------------------------------------------------------------
console.log(`\ncallgraph-layout: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
