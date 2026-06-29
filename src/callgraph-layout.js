// Call-graph layout: Sugiyama-style layered layout for the directed call graph.
// Pure JS (browser + Node) — no DOM, no node: imports, no external libraries.
//
// layoutCallGraph(graph, opts = {}) → augmented graph
//
// INPUT:  graph = { nodes, edges, byFunc, grandTotal }  from buildCallGraph()
//         opts  = { width?, height?, nodeW?, nodeH?, rankGap?, orderGap? }
//
// OUTPUT: {
//   nodes: [{ ...node, rank, order, x, y, w, h }],
//   edges: [{ ...edge, backEdge, points: [{x,y}, {x,y}] }],
//   width, height
// }
//
// ALGORITHM
//   1. Cycle-breaking (back-edge detection)
//      DFS in node-index order (deterministic). Any edge whose target is currently
//      on the DFS stack (a "gray" node) is a back-edge. Self-edges are always
//      back-edges regardless. Back-edges are excluded from ranking and coordinate
//      assignment; they receive points connecting source-center → target-center so
//      a renderer can draw them with a distinct style (arc / dashed).
//
//   2. Rank assignment (longest path from sources)
//      On the forward DAG (back-edges removed), a source is any node with no
//      incoming forward edge. Rank = longest path distance from any source.
//      Computed via Kahn-style topological sort with relaxation.
//
//   3. Within-rank ordering (barycenter heuristic)
//      Nodes start ordered by index (deterministic). A small number of down/up
//      barycenter sweeps adjust order within each rank to reduce crossings.
//      Ties broken by node index to keep results deterministic.
//
//   4. Coordinate assignment
//      rank → y (going down), order → x (left to right).
//      Default node size: nodeW=160, nodeH=40; gaps: rankGap=80, orderGap=20.
//      x/y is the top-left corner of the node box.

/** @param {{nodes:Array,edges:Array,byFunc:Map,grandTotal:number}} graph
 *  @param {{width?:number,height?:number,nodeW?:number,nodeH?:number,rankGap?:number,orderGap?:number}} [opts]
 *  @returns {{nodes:Array,edges:Array,width:number,height:number}}
 */
export function layoutCallGraph(graph, opts = {}) {
  const { nodes, edges } = graph;
  const nodeW    = opts.nodeW    ?? 160;
  const nodeH    = opts.nodeH    ?? 40;
  const rankGap  = opts.rankGap  ?? 80;
  const orderGap = opts.orderGap ?? 20;

  const N = nodes.length;
  if (N === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  // Map func index → position in nodes array (needed for adjacency).
  // nodes are iterated in stable insertion order from buildCallGraph.
  const funcToIdx = new Map();
  for (let i = 0; i < N; i++) funcToIdx.set(nodes[i].func, i);

  // -----------------------------------------------------------------------
  // 1. CYCLE BREAKING — iterative DFS in deterministic node order
  // -----------------------------------------------------------------------
  // DFS colours: 0 = white (unvisited), 1 = gray (on stack), 2 = black (done)
  const color  = new Uint8Array(N); // 0 white, 1 gray, 2 black
  const isBack = new Array(edges.length).fill(false);

  // Build adjacency list (forward edges only at first — we'll mark backs during DFS)
  // We need per-node outgoing edge indices.
  // Pre-mark self-edges.
  for (let ei = 0; ei < edges.length; ei++) {
    if (edges[ei].selfEdge) isBack[ei] = true;
  }

  // outEdges[i] = array of { edgeIdx, toNodeIdx }
  const outEdges = Array.from({ length: N }, () => []);
  for (let ei = 0; ei < edges.length; ei++) {
    if (isBack[ei]) continue; // self-edges already excluded
    const fromIdx = funcToIdx.get(edges[ei].from);
    const toIdx   = funcToIdx.get(edges[ei].to);
    if (fromIdx == null || toIdx == null) continue;
    outEdges[fromIdx].push({ edgeIdx: ei, toNodeIdx: toIdx });
  }

  // Iterative DFS to avoid stack overflow on deep graphs.
  // Stack frame: { nodeIdx, edgePos } — edgePos tracks which outgoing edge to process next.
  for (let start = 0; start < N; start++) {
    if (color[start] !== 0) continue;
    const stack = [{ nodeIdx: start, edgePos: 0 }];
    color[start] = 1; // gray

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const { nodeIdx } = frame;
      const adj = outEdges[nodeIdx];

      if (frame.edgePos >= adj.length) {
        // Done with all neighbors — mark black and pop
        color[nodeIdx] = 2;
        stack.pop();
        continue;
      }

      const { edgeIdx, toNodeIdx } = adj[frame.edgePos];
      frame.edgePos++;

      if (color[toNodeIdx] === 1) {
        // Target is gray (on DFS stack) → back-edge
        isBack[edgeIdx] = true;
      } else if (color[toNodeIdx] === 0) {
        // Unvisited → recurse
        color[toNodeIdx] = 1;
        stack.push({ nodeIdx: toNodeIdx, edgePos: 0 });
      }
      // black → already fully processed, skip
    }
  }

  // -----------------------------------------------------------------------
  // 2. RANK ASSIGNMENT — longest path from sources on the forward DAG
  // -----------------------------------------------------------------------
  // Build in-degree on the forward DAG (non-back edges only).
  const inDeg = new Int32Array(N);
  for (let ei = 0; ei < edges.length; ei++) {
    if (isBack[ei]) continue;
    const toIdx = funcToIdx.get(edges[ei].to);
    if (toIdx != null) inDeg[toIdx]++;
  }

  // Rebuild forward adjacency (now back-edges are finalized).
  const fwdOut = Array.from({ length: N }, () => []);
  for (let ei = 0; ei < edges.length; ei++) {
    if (isBack[ei]) continue;
    const fromIdx = funcToIdx.get(edges[ei].from);
    const toIdx   = funcToIdx.get(edges[ei].to);
    if (fromIdx == null || toIdx == null) continue;
    fwdOut[fromIdx].push(toIdx);
  }

  // Kahn topological order with longest-path rank relaxation.
  const rank = new Int32Array(N).fill(-1);
  const queue = [];
  for (let i = 0; i < N; i++) {
    if (inDeg[i] === 0) { rank[i] = 0; queue.push(i); }
  }

  // Working in-degree copy for Kahn processing.
  const workDeg = inDeg.slice();

  let qi = 0;
  while (qi < queue.length) {
    const u = queue[qi++];
    for (const v of fwdOut[u]) {
      const proposed = rank[u] + 1;
      if (proposed > rank[v]) rank[v] = proposed;
      workDeg[v]--;
      if (workDeg[v] === 0) queue.push(v);
    }
  }

  // Any node not reached (disconnected from all sources, which shouldn't happen
  // after proper cycle-breaking, but guard for safety) gets rank 0.
  for (let i = 0; i < N; i++) if (rank[i] < 0) rank[i] = 0;

  // -----------------------------------------------------------------------
  // 3. WITHIN-RANK ORDERING — barycenter heuristic
  // -----------------------------------------------------------------------
  // Collect ranks.
  let maxRank = 0;
  for (let i = 0; i < N; i++) if (rank[i] > maxRank) maxRank = rank[i];

  // rankBuckets[r] = sorted array of node indices at rank r.
  const rankBuckets = Array.from({ length: maxRank + 1 }, () => []);
  for (let i = 0; i < N; i++) rankBuckets[rank[i]].push(i);
  // Initial order within each rank: node index (stable, deterministic).
  for (const bucket of rankBuckets) bucket.sort((a, b) => a - b);

  // order[i] = position of node i within its rank.
  const order = new Int32Array(N);
  for (const bucket of rankBuckets) {
    for (let pos = 0; pos < bucket.length; pos++) order[bucket[pos]] = pos;
  }

  // Forward adjacency by node index (for barycenter).
  // We need to compute barycenter of neighbors across ranks.

  // Build incoming forward adjacency (needed for up-sweep).
  const fwdIn = Array.from({ length: N }, () => []);
  for (let ei = 0; ei < edges.length; ei++) {
    if (isBack[ei]) continue;
    const fromIdx = funcToIdx.get(edges[ei].from);
    const toIdx   = funcToIdx.get(edges[ei].to);
    if (fromIdx == null || toIdx == null) continue;
    fwdIn[toIdx].push(fromIdx);
  }

  // A few barycenter sweeps (down then up).
  const SWEEPS = 4;
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const goDown = sweep % 2 === 0;

    if (goDown) {
      // Down sweep: for each rank r > 0, reorder nodes by avg order of parents in rank r-1.
      for (let r = 1; r <= maxRank; r++) {
        const bucket = rankBuckets[r];
        // Compute barycenter from parents (rank r-1 neighbors).
        const bary = bucket.map(ni => {
          const parents = fwdIn[ni].filter(p => rank[p] === r - 1);
          if (parents.length === 0) return order[ni]; // keep current
          let sum = 0;
          for (const p of parents) sum += order[p];
          return sum / parents.length;
        });
        // Sort by barycenter; tie-break by node index for determinism.
        const paired = bucket.map((ni, pos) => ({ ni, bary: bary[pos] }));
        paired.sort((a, b) => a.bary - b.bary || a.ni - b.ni);
        for (let pos = 0; pos < paired.length; pos++) {
          bucket[pos] = paired[pos].ni;
          order[paired[pos].ni] = pos;
        }
      }
    } else {
      // Up sweep: for each rank r < maxRank, reorder by avg order of children in rank r+1.
      for (let r = maxRank - 1; r >= 0; r--) {
        const bucket = rankBuckets[r];
        const bary = bucket.map(ni => {
          const children = fwdOut[ni].filter(c => rank[c] === r + 1);
          if (children.length === 0) return order[ni];
          let sum = 0;
          for (const c of children) sum += order[c];
          return sum / children.length;
        });
        const paired = bucket.map((ni, pos) => ({ ni, bary: bary[pos] }));
        paired.sort((a, b) => a.bary - b.bary || a.ni - b.ni);
        for (let pos = 0; pos < paired.length; pos++) {
          bucket[pos] = paired[pos].ni;
          order[paired[pos].ni] = pos;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // 4. COORDINATE ASSIGNMENT
  // -----------------------------------------------------------------------
  // rank → y (top-down): y = rank * (nodeH + rankGap)
  // order → x (left to right): x = order * (nodeW + orderGap)
  // x/y is the top-left corner of the node's bounding box.

  // Compute per-rank widths to center nodes within each rank column if needed.
  // Simple approach: just use global order positions (no centering needed for tests).

  const augNodes = nodes.map((node, i) => {
    const r = rank[i];
    const o = order[i];
    const x = o * (nodeW + orderGap);
    const y = r * (nodeH + rankGap);
    return { ...node, rank: r, order: o, x, y, w: nodeW, h: nodeH };
  });

  // Compute total canvas size.
  let maxX = 0, maxY = 0;
  for (const n of augNodes) {
    if (n.x + n.w > maxX) maxX = n.x + n.w;
    if (n.y + n.h > maxY) maxY = n.y + n.h;
  }
  const totalWidth  = opts.width  ?? maxX;
  const totalHeight = opts.height ?? maxY;

  // Build augmented node lookup by func index for edge point computation.
  const augByFunc = new Map();
  for (const n of augNodes) augByFunc.set(n.func, n);

  // Edge points: straight line between centers of from/to nodes.
  // Back-edges connect source center → target center (renderer draws them distinctly).
  const augEdges = edges.map((edge, ei) => {
    const fromNode = augByFunc.get(edge.from);
    const toNode   = augByFunc.get(edge.to);
    const backEdge = isBack[ei];
    let points;
    if (fromNode && toNode) {
      const fx = fromNode.x + fromNode.w / 2;
      const fy = fromNode.y + fromNode.h / 2;
      const tx = toNode.x + toNode.w / 2;
      const ty = toNode.y + toNode.h / 2;
      points = [{ x: fx, y: fy }, { x: tx, y: ty }];
    } else {
      points = [];
    }
    return { ...edge, backEdge, points };
  });

  return { nodes: augNodes, edges: augEdges, width: totalWidth, height: totalHeight };
}
