// FG-030: per-line weight aggregation for the source-line view.
// Pure JS, no DOM/canvas — importable headlessly by both the browser renderer and the
// Node test harness. Mirrors the recursion-safe once-per-sample logic in
// BaseView._funcAggregate (render-canvas.js), but bucketed by line number.
//
// Line semantics (verified against every parser, e.g. parse-cpuprofile.js / parse-pprof.js):
// frameTable.line is the line within the frame's OWN function — the source line of the
// sampled program counter, NOT a call site in the parent. So to attribute weight to the
// hot lines of function f we use the line of f's OWN frames. Because a frame interns its
// line (internFrame(func, line, inlineDepth)), f executing at two different lines yields two
// distinct stack nodes, so call sites within f are already separated into different nodes.
//
//   self[L]:  samples whose LEAF is f executing at line L (time spent directly on line L).
//   total[L]: samples where f is on the stack at line L (time on line L of f, incl. callees).
//             Counted ONCE per sample per line — if the same line L of f appears at multiple
//             stack depths (recursion), the sample still contributes to total[L] only once.
//
// Returns: Map<lineNumber, { self, total }>
//
// Args:
//   ct — CallNodeTable (from buildCallNodeTable: func/frame/prefix/self arrays)
//   p  — Profile (canonical model)
//   f  — function index to aggregate over
export function aggregateByLine(ct, p, f) {
  const n = ct.func.length;
  const fnLine = p.frameTable.line;
  const lineOf = (node) => fnLine[ct.frame[node]];

  const result = new Map(); // line -> { self, total }
  const entry = (line) => {
    let e = result.get(line);
    if (!e) { e = { self: 0, total: 0 }; result.set(line, e); }
    return e;
  };

  // ct.self[i] is the weight of samples whose LEAF is exactly node i. Walk each such node's
  // ancestor chain, collect the DISTINCT lines at which f appears, and credit the weight to
  // each once (total). If the leaf node itself is an f-frame, credit self for its line too.
  for (let i = 0; i < n; i++) {
    const w = ct.self[i];
    if (!w) continue;
    const lines = new Set();
    for (let a = i; a >= 0; a = ct.prefix[a]) {
      if (ct.func[a] === f) { const L = lineOf(a); if (L >= 0) lines.add(L); }
    }
    for (const L of lines) entry(L).total += w; // once per sample per distinct line of f
    if (ct.func[i] === f) { const L = lineOf(i); if (L >= 0) entry(L).self += w; }
  }

  return result;
}

// Convenience: given a profile and a function index, return the basename of the source
// file recorded in funcTable.file, or null if absent. Used for source-file matching.
export function funcBasename(p, f) {
  const fi = p.funcTable.file[f];
  if (fi < 0) return null;
  const path = p.stringTable[fi] || '';
  if (!path) return null;
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}
