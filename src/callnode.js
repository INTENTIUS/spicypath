// Build the derived CallNodeTable from a canonical Profile. The stackTable is already
// an interned prefix tree, so its nodes ARE call-tree nodes; we just accumulate weights.
// Pure JS (no node: imports) → shared by the Node verifier and the browser renderer.

// FG-053: Build a synthetic "all threads" Thread by concatenating every thread's samples.
// The merged thread carries the UNION of all weight types, with each thread's columns
// padded to 0 for types it doesn't contribute to. Stacks are already interned in shared
// tables, so concatenation produces valid stack indices. Time columns (hasTiming) are
// merged and re-sorted so the time[] array remains monotonically non-decreasing.
// Returns a synthetic Thread object compatible with buildCallNodeTable (NOT mutating p).
export function mergedThread(p) {
  if (!p || !p.threads || p.threads.length === 0) return null;
  if (p.threads.length === 1) return p.threads[0];

  const wts = p.capabilities.weightTypes;
  const hasTiming = p.capabilities.hasTiming;

  // Collect all samples in time order (if timed) or thread-concatenated order (if not).
  if (hasTiming) {
    // Merge all per-thread samples into a flat list and sort by time.
    const all = [];
    for (const t of p.threads) {
      const len = t.samples.stack.length;
      for (let i = 0; i < len; i++) {
        const entry = { stack: t.samples.stack[i], time: t.samples.time[i] };
        for (const wt of wts) {
          const col = t.samples.weightsByType[wt];
          entry[wt] = col ? (col[i] || 0) : 0;
        }
        all.push(entry);
      }
    }
    all.sort((a, b) => a.time - b.time);

    const stack = all.map(e => e.stack);
    const time = all.map(e => e.time);
    const weightsByType = {};
    for (const wt of wts) weightsByType[wt] = all.map(e => e[wt] || 0);
    return { name: 'all threads', samples: { stack, weightsByType, time } };
  } else {
    // No timing: simple concatenation in thread order.
    const stack = [];
    const weightsByType = {};
    for (const wt of wts) weightsByType[wt] = [];

    for (const t of p.threads) {
      const len = t.samples.stack.length;
      for (let i = 0; i < len; i++) stack.push(t.samples.stack[i]);
      for (const wt of wts) {
        const col = t.samples.weightsByType[wt];
        const out = weightsByType[wt];
        for (let i = 0; i < len; i++) out.push(col ? (col[i] || 0) : 0);
      }
    }
    return { name: 'all threads', samples: { stack, weightsByType } };
  }
}

// FG-060: build the call-node table from the heap's dominator tree.
// Every object is a node; parent = immediate dominator; func = class index.
// total = retained size (monotone up the tree → icicle width math works).
// self  = shallow size.
// grandTotal = Σ retained(roots) = totalShallow (conservation law from FG-059).
function _buildHeapCt(p) {
  const heap = p.heap;
  const N = heap.objectCount;

  const frame  = new Array(N);
  const func   = new Array(N);
  const prefix = new Array(N);
  const self   = new Array(N);
  const total  = new Array(N);
  const depth  = new Array(N);

  for (let i = 0; i < N; i++) {
    const ci   = heap.classIndexOf(i);
    frame[i]   = ci; // frame === func for the heap ct (no separate frameTable layer)
    func[i]    = ci;
    prefix[i]  = heap.dominatorParentOf(i); // -1 = forest root (idom = superRoot)
    self[i]    = heap.shallowOf(i);
    total[i]   = heap.retainedOf(i);
  }

  // depths — parents always have a lower object id in practice but we can't assume
  // topological order from the object id, so iterate until stable (objects are ≤10^5).
  // One pass suffices if we process in ascending id order AND parents precede children,
  // which the dominator tree guarantees only when dominators are numbered before
  // their dominated nodes — not generally true for object ids.  Two-pass is safe.
  depth.fill(0);
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < N; i++) {
      depth[i] = prefix[i] < 0 ? 0 : depth[prefix[i]] + 1;
    }
  }

  // children lists
  const children = Array.from({ length: N }, () => []);
  const roots = [];
  for (let i = 0; i < N; i++) {
    if (prefix[i] < 0) roots.push(i);
    else children[prefix[i]].push(i);
  }

  // sort left-heavy (largest retained first)
  const byTotal = (a, b) => total[b] - total[a];
  for (let i = 0; i < N; i++) children[i].sort(byTotal);
  roots.sort(byTotal);

  const grandTotal = heap.totalShallow; // = Σ retained(roots) by conservation

  return { frame, func, prefix, depth, self, total, children, roots, grandTotal };
}

// FG-053: threadIndex may be a number (real thread) or a Thread object (e.g. mergedThread).
export function buildCallNodeTable(p, threadIndex, weightType) {
  // FG-060: heap profiles supply their own dominator-tree ct; the sampled path does not apply.
  if (p && p.capabilities && p.capabilities.kind === 'heap') return _buildHeapCt(p);

  const st = p.stackTable;
  const n = st.frame.length;
  const frame = st.frame.slice();
  const prefix = st.prefix.slice();

  const func = new Array(n);
  for (let i = 0; i < n; i++) func[i] = p.frameTable.func[frame[i]];

  const depth = new Array(n);
  for (let i = 0; i < n; i++) depth[i] = prefix[i] < 0 ? 0 : depth[prefix[i]] + 1; // parents precede children

  const self = new Array(n).fill(0);
  const t = (typeof threadIndex === 'object' && threadIndex !== null) ? threadIndex : p.threads[threadIndex];
  const col = t.samples.weightsByType[weightType] || [];
  for (let i = 0; i < t.samples.stack.length; i++) {
    const s = t.samples.stack[i];
    if (s >= 0) self[s] += col[i] || 0;
  }

  const total = self.slice();
  for (let i = n - 1; i >= 0; i--) if (prefix[i] >= 0) total[prefix[i]] += total[i]; // bottom-up

  const children = Array.from({ length: n }, () => []);
  const roots = [];
  for (let i = 0; i < n; i++) (prefix[i] < 0 ? roots : children[prefix[i]]).push(i);

  const byTotal = (a, b) => total[b] - total[a]; // left-heavy
  for (const c of children) c.sort(byTotal);
  roots.sort(byTotal);

  let grandTotal = 0;
  for (const r of roots) grandTotal += total[r];

  return { frame, func, prefix, depth, self, total, children, roots, grandTotal };
}
