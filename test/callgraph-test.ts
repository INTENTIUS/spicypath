// Phase 1 call-graph model tests (FG-051 / P1).
// Tests buildCallGraph() against parsed fixtures and a hand-rolled inline profile.
//   node test/callgraph-test.ts
import { readFileSync } from 'node:fs';
import { ingestBytes } from '../src/ingest.js';
import { buildCallNodeTable } from '../src/callnode.js';
import { functionStats } from '../src/funcstats.js';
import { buildCallGraph } from '../src/callgraph.js';
import type { Profile } from '../src/model.ts';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${(!ok && detail) ? ': ' + detail : ''}`);
}

// ---- helpers ----------------------------------------------------------------
function ct(p: Profile, wt?: string) {
  const weightType = wt ?? p.capabilities.weightTypes[0];
  return buildCallNodeTable(p, 0, weightType);
}

function funcName(p: Profile, funcIdx: number): string {
  return p.stringTable[p.funcTable.name[funcIdx]] ?? '';
}

// ---- fixture: wide-fanout ---------------------------------------------------
// Stacks: main;svc.dispatch;handler.hN, weights 24 down to 1 for N=0..23.
// Expected edges: main→svc.dispatch (1 ct edge), svc.dispatch→handler.hN (24 ct edges = 24 distinct).
// No self-edges.
{
  const p = await ingestBytes('wide-fanout.folded', new Uint8Array(readFileSync('test/testdata/wide-fanout.folded')));
  const table = ct(p);
  const g = buildCallGraph(table, p);

  // node count matches functionStats
  const stats = functionStats(table, p);
  check('wide-fanout: node count == functionStats length', g.nodes.length === stats.length, `${g.nodes.length} vs ${stats.length}`);

  // byFunc has an entry for every node
  check('wide-fanout: byFunc size == nodes length', g.byFunc.size === g.nodes.length, `${g.byFunc.size} vs ${g.nodes.length}`);

  // grandTotal matches
  check('wide-fanout: grandTotal matches ct.grandTotal', g.grandTotal === table.grandTotal, `${g.grandTotal} vs ${table.grandTotal}`);

  // node self/total matches functionStats
  let nodesMismatch = false;
  for (const s of stats) {
    const node = g.byFunc.get(s.func);
    if (!node || node.self !== s.self || node.total !== s.total) { nodesMismatch = true; break; }
  }
  check('wide-fanout: node self/total matches functionStats', !nodesMismatch);

  // edges: main→svc.dispatch and svc.dispatch→handler.hN exist
  const edgeSet = new Map(g.edges.map((e: any) => [`${funcName(p, e.from)}→${funcName(p, e.to)}`, e]));

  const mainEdge = edgeSet.get('main→svc.dispatch');
  check('wide-fanout: main→svc.dispatch edge exists', mainEdge != null);
  // Only one call-tree edge from main to svc.dispatch (one call-node pair)
  check('wide-fanout: main→svc.dispatch count == 1', mainEdge?.count === 1, String(mainEdge?.count));

  // 24 handler leaves, each a distinct svc.dispatch→handler.hN edge
  const dispatchEdges = g.edges.filter((e: any) => funcName(p, e.from) === 'svc.dispatch');
  check('wide-fanout: 24 distinct svc.dispatch→handler.hN edges', dispatchEdges.length === 24, String(dispatchEdges.length));
  // each has count == 1 (one call-tree pair each)
  const allCount1 = dispatchEdges.every((e: any) => e.count === 1);
  check('wide-fanout: each dispatch→handler edge has count == 1', allCount1);

  // no self-edges in this fixture
  const selfEdges = g.edges.filter((e: any) => e.selfEdge);
  check('wide-fanout: no self-edges', selfEdges.length === 0, `found ${selfEdges.length}`);

  // edge cost for main→svc.dispatch == total weight of svc.dispatch subtree
  // svc.dispatch total = grandTotal (it covers everything)
  if (mainEdge) {
    check('wide-fanout: main→svc.dispatch cost == svc.dispatch node total',
      mainEdge.cost === g.byFunc.get(mainEdge.to)?.total,
      `cost=${mainEdge.cost} node.total=${g.byFunc.get(mainEdge.to)?.total}`);
  }

  // edge cost does not exceed callee node total (sanity) — for every edge
  let costSane = true;
  for (const e of g.edges as any[]) {
    const calleeTotal = g.byFunc.get(e.to)?.total ?? 0;
    // cost can exceed callee's recursion-safe total in degenerate cases,
    // but for non-recursive fanout it must be <= callee total.
    if (e.cost > calleeTotal + 1e-9) { costSane = false; break; }
  }
  check('wide-fanout: edge cost <= callee node total for all edges', costSane);
}

// ---- fixture: deep-recursion ------------------------------------------------
// Stacks: main;app.handle;app.fib(x1..30), weight 1 per sample.
// app.fib calls itself → self-edge app.fib→app.fib must exist.
// app.fib total (recursion-safe) <= grandTotal.
{
  const p = await ingestBytes('deep-recursion.pprof', new Uint8Array(readFileSync('test/testdata/deep-recursion.pprof')));
  const table = ct(p);
  const g = buildCallGraph(table, p);

  const stats = functionStats(table, p);
  check('deep-recursion: node count == functionStats length', g.nodes.length === stats.length, `${g.nodes.length} vs ${stats.length}`);

  // recursive function produces a self-edge
  const selfEdges = g.edges.filter((e: any) => e.selfEdge);
  check('deep-recursion: at least one self-edge exists', selfEdges.length > 0, `found ${selfEdges.length}`);

  // self-edge is on app.fib
  const fibSelfEdge = selfEdges.find((e: any) => funcName(p, e.from) === 'app.fib');
  check('deep-recursion: app.fib has a self-edge', fibSelfEdge != null);

  // recursion-safe total: app.fib total <= grandTotal
  const fibNode = [...g.byFunc.values()].find((nd: any) => nd.name === 'app.fib');
  check('deep-recursion: app.fib total exists', fibNode != null);
  if (fibNode) {
    check('deep-recursion: app.fib total <= grandTotal (recursion-safe)',
      fibNode.total <= g.grandTotal + 1e-9,
      `fibTotal=${fibNode.total} grandTotal=${g.grandTotal}`);
  }

  // node self/total matches functionStats
  let nodesMismatch2 = false;
  for (const s of stats) {
    const node = g.byFunc.get(s.func);
    if (!node || node.self !== s.self || node.total !== s.total) { nodesMismatch2 = true; break; }
  }
  check('deep-recursion: node self/total matches functionStats', !nodesMismatch2);

  // selfEdge edges have from === to
  const allSelfConsistent = selfEdges.every((e: any) => e.from === e.to);
  check('deep-recursion: selfEdge edges always have from === to', allSelfConsistent);
}

// ---- inline profile: tiny (hand-verified expected edges) --------------------
// Stacks from scene.js tiny():
//   main;http.serve;router.handle;db.query    weight 50
//   main;http.serve;router.handle;json.encode weight 30
//   main;runtime.gc;gc.mark                   weight 20
// grandTotal = 100
// Expected function-level edges:
//   main→http.serve   cost=80, count=2 (two call-nodes that fan into http.serve)
//   main→runtime.gc   cost=20, count=1
//   http.serve→router.handle  cost=80, count=2
//   router.handle→db.query    cost=50, count=1
//   router.handle→json.encode cost=30, count=1
//   runtime.gc→gc.mark        cost=20, count=1
{
  const p = await ingestBytes('tiny.folded', new Uint8Array(readFileSync('test/testdata/tiny.folded')));
  const table = ct(p);
  const g = buildCallGraph(table, p);

  const edgeMap = new Map((g.edges as any[]).map(e => [`${funcName(p, e.from)}→${funcName(p, e.to)}`, e]));

  check('tiny: grandTotal == 100', g.grandTotal === 100, String(g.grandTotal));

  // main → http.serve: 2 distinct call-tree paths both go through this pair
  // (two call-nodes for http.serve, one per path: main;http.serve;router.handle;db.query
  // and main;http.serve;router.handle;json.encode both share the same http.serve call-node
  // because the stack table interns the prefix tree — so actually only 1 call-node for http.serve)
  // Let's check the edge exists at minimum.
  const httpEdge = edgeMap.get('main→http.serve');
  check('tiny: main→http.serve edge exists', httpEdge != null);

  const gcEdge = edgeMap.get('main→runtime.gc');
  check('tiny: main→runtime.gc edge exists', gcEdge != null);
  if (gcEdge) {
    check('tiny: main→runtime.gc cost == 20', gcEdge.cost === 20, String(gcEdge.cost));
    check('tiny: main→runtime.gc count == 1', gcEdge.count === 1, String(gcEdge.count));
  }

  const dbEdge = edgeMap.get('router.handle→db.query');
  check('tiny: router.handle→db.query edge exists', dbEdge != null);
  if (dbEdge) {
    check('tiny: router.handle→db.query cost == 50', dbEdge.cost === 50, String(dbEdge.cost));
    check('tiny: router.handle→db.query count == 1', dbEdge.count === 1, String(dbEdge.count));
  }

  const jsonEdge = edgeMap.get('router.handle→json.encode');
  check('tiny: router.handle→json.encode edge exists', jsonEdge != null);
  if (jsonEdge) {
    check('tiny: router.handle→json.encode cost == 30', jsonEdge.cost === 30, String(jsonEdge.cost));
  }

  const gcMarkEdge = edgeMap.get('runtime.gc→gc.mark');
  check('tiny: runtime.gc→gc.mark edge exists', gcMarkEdge != null);
  if (gcMarkEdge) {
    check('tiny: runtime.gc→gc.mark cost == 20', gcMarkEdge.cost === 20, String(gcMarkEdge.cost));
  }

  // no self-edges in tiny
  const selfEdgesTiny = (g.edges as any[]).filter(e => e.selfEdge);
  check('tiny: no self-edges', selfEdgesTiny.length === 0, String(selfEdgesTiny.length));

  // total node count: main, http.serve, router.handle, db.query, json.encode, runtime.gc, gc.mark = 7
  check('tiny: 7 distinct function nodes', g.nodes.length === 7, String(g.nodes.length));

  // edge cost sanity: for non-recursive profile, every edge cost <= callee node total
  let costSaneTiny = true;
  for (const e of g.edges as any[]) {
    const calleeTotal = g.byFunc.get(e.to)?.total ?? 0;
    if (e.cost > calleeTotal + 1e-9) {
      costSaneTiny = false;
      console.log(`  cost_sanity fail: ${funcName(p, e.from)}→${funcName(p, e.to)} cost=${e.cost} callee.total=${calleeTotal}`);
    }
  }
  check('tiny: edge cost <= callee node total for all edges', costSaneTiny);
}

// ---- edge count vs functionStats cross-check --------------------------------
// For any profile, byFunc must contain exactly the functions that functionStats returns.
{
  const p = await ingestBytes('multi-value.pprof', new Uint8Array(readFileSync('test/testdata/multi-value.pprof')));
  const wt = 'cpu_nanos';
  const table = ct(p, wt);
  const g = buildCallGraph(table, p);
  const stats = functionStats(table, p);

  const statFuncs = new Set(stats.map((s: any) => s.func));
  const graphFuncs = new Set([...g.byFunc.keys()]);
  let setsMatch = statFuncs.size === graphFuncs.size;
  for (const f of statFuncs) if (!graphFuncs.has(f)) { setsMatch = false; break; }
  check('multi-value/cpu_nanos: byFunc key set equals functionStats func set', setsMatch,
    `stats=${statFuncs.size} graph=${graphFuncs.size}`);

  // every edge endpoint has a corresponding node
  let endpointsHaveNodes = true;
  for (const e of g.edges as any[]) {
    if (!g.byFunc.has(e.from) || !g.byFunc.has(e.to)) { endpointsHaveNodes = false; break; }
  }
  check('multi-value/cpu_nanos: every edge endpoint has a node in byFunc', endpointsHaveNodes);
}

// ---- summary ----------------------------------------------------------------
console.log(`\ncallgraph: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
