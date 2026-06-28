// Build the derived CallNodeTable from a canonical Profile. The stackTable is already
// an interned prefix tree, so its nodes ARE call-tree nodes; we just accumulate weights.
// Pure JS (no node: imports) → shared by the Node verifier and the browser renderer.

export function buildCallNodeTable(p, threadIndex, weightType) {
  const st = p.stackTable;
  const n = st.frame.length;
  const frame = st.frame.slice();
  const prefix = st.prefix.slice();

  const func = new Array(n);
  for (let i = 0; i < n; i++) func[i] = p.frameTable.func[frame[i]];

  const depth = new Array(n);
  for (let i = 0; i < n; i++) depth[i] = prefix[i] < 0 ? 0 : depth[prefix[i]] + 1; // parents precede children

  const self = new Array(n).fill(0);
  const t = p.threads[threadIndex];
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
