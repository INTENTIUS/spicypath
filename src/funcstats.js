// Per-function self/total aggregation over a CallNodeTable.
// Pure JS (browser + Node) — no DOM, no node: imports.
//
// functionStats(ct, profile) → array of { func, name, file, line, self, total }
//   sorted by self descending (heaviest first).
//
// Algorithm:
//   self[f]  = Σ ct.self[i] for all call-nodes i where ct.func[i] === f
//              (straightforward sum; no recursion concern)
//
//   total[f] = for each sample (leaf call-node with self weight > 0), walk the
//              ancestor chain and collect the DISTINCT set of function indices
//              present on that path, then add the sample's weight to each function
//              once. This mirrors BaseView._funcAggregate's `contains[]` logic but
//              computes all functions in a single pass rather than one-at-a-time.
//
//   Complexity: O(S * D) where S = number of samples and D = average stack depth,
//               which is identical to _funcAggregate called once per function.
//               In practice D is small (tens) so this is fast even for large profiles.

export function functionStats(ct, profile) {
  const n = ct.func.length;

  // Accumulate self per function index.
  const selfByFunc = new Map();
  const totalByFunc = new Map();

  // Pre-populate from all call nodes (so functions with zero self also appear
  // in totalByFunc if they carry total weight from descendants).
  for (let i = 0; i < n; i++) {
    const f = ct.func[i];
    if (!selfByFunc.has(f)) { selfByFunc.set(f, 0); totalByFunc.set(f, 0); }
  }

  // Walk every leaf sample: for each node with self weight, walk ancestor chain
  // collecting DISTINCT function indices and add weight to each once.
  for (let i = 0; i < n; i++) {
    const w = ct.self[i];
    if (!w) continue;

    // Accumulate self for this node's function.
    selfByFunc.set(ct.func[i], (selfByFunc.get(ct.func[i]) || 0) + w);

    // Walk ancestors (including this node) collecting distinct functions.
    // Use a small inline visited set — most stacks are shallow, so a plain
    // array scan is faster than a full Set for the typical < 50 depth case.
    const seen = [];
    let node = i;
    while (node >= 0) {
      const f = ct.func[node];
      if (seen.indexOf(f) < 0) {
        seen.push(f);
        totalByFunc.set(f, (totalByFunc.get(f) || 0) + w);
      }
      node = ct.prefix[node];
    }
  }

  // Build result array from all distinct functions seen in the call-node table.
  const results = [];
  for (const [f, self] of selfByFunc) {
    const nameIdx = profile.funcTable.name[f];
    const name = profile.stringTable[nameIdx] || '';
    const fileIdx = profile.funcTable.file[f];
    const file = (fileIdx >= 0 ? (profile.stringTable[fileIdx] || '') : '');
    const line = (profile.funcTable.line && profile.funcTable.line[f] != null)
      ? profile.funcTable.line[f]
      : -1;
    results.push({ func: f, name, file, line, self, total: totalByFunc.get(f) || 0 });
  }

  // Sort by self descending; tie-break by total descending, then name for stability.
  results.sort((a, b) => (b.self - a.self) || (b.total - a.total) || a.name.localeCompare(b.name));

  return results;
}
