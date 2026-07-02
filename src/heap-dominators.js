// FG-059: dominators + retained size over a heap object graph.
//
// A synthetic super-root S (index N) links every GC root; the immediate-dominator tree rooted at
// S then gives each object's retained size = Σ shallow over its dominator subtree (the memory that
// would be freed if the object became unreachable). A node d dominates n iff every path S→…→n
// passes through d. This is the model the icicle view (FG-060) draws, weighted by retained size.
//
// Algorithm: Cooper–Harvey–Kennedy "A Simple, Fast Dominance Algorithm" — iterate immediate
// dominators to a fixpoint over reverse-postorder, using postorder numbers to walk the partial
// tree (`intersect`). It handles arbitrary (cyclic, irreducible) graphs, which a heap is.
//
// Totality: objects not reachable from the collected GC-root set (JVM-internal objects held by
// roots we don't enumerate) are numbered by a follow-up DFS and fall to idom = S (a direct
// super-root child). Every object thus lands in exactly one dominator subtree, so Σ retained over
// S's direct children == total shallow — retained size is conserved, never lost or double-counted.
//
// computeHeapDominators(N, roots, refsOf, shallowOf) →
//   { idom: Int32Array(N+1), retained: Float64Array(N), superRoot: N }
// where idom[S] === S, and for an object n, idom[n] === S means "dominated only by the super-root".
export function computeHeapDominators(N, roots, refsOf, shallowOf) {
  const S = N;          // super-root index
  const M = N + 1;

  // Successors: materialize once (refsOf may decode lazily). S → the deduped GC roots.
  const succ = new Array(M);
  for (let u = 0; u < N; u++) succ[u] = refsOf(u);
  const rootList = [];
  const isRoot = new Uint8Array(N);
  for (const r of roots) if (r >= 0 && r < N && !isRoot[r]) { isRoot[r] = 1; rootList.push(r); }
  succ[S] = rootList;

  // Iterative DFS from S → postorder over the root-reachable objects (the CHK domain). S finishes
  // last, so post[S] is the maximum — it outranks every object in `intersect`'s finger walk.
  const post = new Int32Array(M).fill(-1);
  const order = [];
  const visited = new Uint8Array(M);
  {
    visited[S] = 1;
    const stack = [[S, 0]];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const u = frame[0], ss = succ[u];
      if (ss && frame[1] < ss.length) {
        const v = ss[frame[1]++];
        if (v >= 0 && v < N && !visited[v]) { visited[v] = 1; stack.push([v, 0]); }
      } else { post[u] = order.length; order.push(u); stack.pop(); }
    }
  }

  // Predecessors over the real edges (objects) + S → root.
  const predHead = new Int32Array(M).fill(-1);
  const predNext = [];
  const predNode = [];
  const addPred = (v, u) => { predNode.push(u); predNext.push(predHead[v]); predHead[v] = predNode.length - 1; };
  for (let u = 0; u < M; u++) { const ss = succ[u]; if (ss) for (const v of ss) if (v >= 0 && v < N) addPred(v, u); }

  const idom = new Int32Array(M).fill(-1);
  idom[S] = S;
  // Reverse-postorder over reachable nodes (S first). CHK only ever moves idom UP toward S, so we
  // must NOT force an idom mid-loop; a reachable non-start node always has an already-processed
  // predecessor by the time RPO reaches it. Nodes never reached from S are handled after the loop.
  const rpo = order.slice().reverse();

  const intersect = (a, b) => {
    while (a !== b) {
      while (post[a] < post[b]) a = idom[a];
      while (post[b] < post[a]) b = idom[b];
    }
    return a;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of rpo) {
      if (node === S) continue;
      let newIdom = -1;
      for (let e = predHead[node]; e !== -1; e = predNext[e]) {
        const p = predNode[e];
        if (idom[p] === -1) continue;             // predecessor not processed yet
        newIdom = (newIdom === -1) ? p : intersect(p, newIdom);
      }
      if (newIdom !== -1 && idom[node] !== newIdom) { idom[node] = newIdom; changed = true; }
    }
  }

  // Objects unreachable from the collected GC roots (held only by roots we don't enumerate) get
  // the super-root as their immediate dominator — each becomes its own top-level retainer, so
  // every object still lands in exactly one dominator subtree (retained size stays conserved).
  for (let u = 0; u < N; u++) if (idom[u] === -1) idom[u] = S;

  // Dominator-tree depth (iterative memo up the idom chain; no recursion for deep chains).
  const depth = new Int32Array(M).fill(-1);
  depth[S] = 0;
  for (let s = 0; s < N; s++) {
    if (depth[s] !== -1) continue;
    const path = [];
    let x = s;
    while (x !== S && depth[x] === -1) { path.push(x); x = idom[x]; }
    let d = depth[x];
    for (let i = path.length - 1; i >= 0; i--) depth[path[i]] = ++d;
  }

  // Retained size: shallow of each node plus the retained of its dominator children. Accumulate
  // deepest-first so a node is fully summed before it folds into its immediate dominator.
  const retained = new Float64Array(N);
  for (let n = 0; n < N; n++) retained[n] = shallowOf(n);
  const byDepth = Array.from({ length: N }, (_, i) => i).sort((a, b) => depth[b] - depth[a]);
  for (const n of byDepth) { const p = idom[n]; if (p !== S && p >= 0 && p < N) retained[p] += retained[n]; }

  return { idom, retained, superRoot: S };
}
