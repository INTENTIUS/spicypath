// Pure flame-graph layout: CallNodeTable + viewport width → positioned boxes.
// Sub-pixel pruning. Icicle orientation (root depth 0, growing down). focus = zoom node.
// Auto-collapse: a single-child chain whose child carries ~all of the parent's weight
// (>= collapseThreshold) folds into one box (depth compressed), with `collapsed` = how
// many extra frames were folded and `tail` = the deepest folded node (for tooltips).
// Pure JS, shared by Node verifier (→ SVG) and browser renderer (→ Canvas).

export function layout(ct, opts) {
  const width = opts.width;
  const minWidth = opts.minWidth == null ? 0.5 : opts.minWidth;
  const collapse = !!opts.collapse;
  const thr = opts.collapseThreshold == null ? 0.99 : opts.collapseThreshold;
  const boxes = [];

  let startNodes, baseTotal;
  if (opts.focus != null && opts.focus >= 0) { startNodes = [opts.focus]; baseTotal = ct.total[opts.focus]; }
  else { startNodes = ct.roots; baseTotal = ct.grandTotal; }
  if (baseTotal <= 0) return boxes;

  // optional horizontal crop window, as a fraction [f0,f1] of the displayed total
  const f0 = opts.winFrac ? opts.winFrac[0] : 0;
  const f1 = opts.winFrac ? opts.winFrac[1] : 1;
  const visStart = f0 * baseTotal, visTotal = (f1 - f0) * baseTotal;
  if (visTotal <= 0) return boxes;
  const px = width / visTotal;
  const toX = (xVal) => (xVal - visStart) * px;

  const stack = [];
  let cx = 0;
  for (const r of startNodes) { stack.push({ node: r, xVal: cx, depth: 0 }); cx += ct.total[r]; }

  while (stack.length) {
    const it = stack.pop();
    const head = it.node;
    let tail = head, members = 1;
    if (collapse) {
      for (;;) {
        const kids = ct.children[tail];
        if (kids.length === 1 && ct.total[kids[0]] >= ct.total[tail] * thr) { tail = kids[0]; members++; }
        else break;
      }
    }
    const x = toX(it.xVal), w = ct.total[head] * px;
    const x0 = Math.max(0, x), x1 = Math.min(width, x + w);
    if (x1 - x0 < minWidth) continue; // outside window or too thin → prune box + subtree (child clip ≤ parent clip)
    boxes.push({ node: head, tail, func: ct.func[head], depth: it.depth, x: x0, w: x1 - x0, self: ct.self[head], total: ct.total[head], collapsed: members - 1, delta: ct.delta ? ct.delta[head] : 0 });
    let childV = it.xVal;
    for (const c of ct.children[tail]) { // children of the chain TAIL, one row below
      const cx = toX(childV), cw = ct.total[c] * px;
      if (Math.min(width, cx + cw) - Math.max(0, cx) >= minWidth) stack.push({ node: c, xVal: childV, depth: it.depth + 1 });
      childV += ct.total[c];
    }
  }
  return boxes;
}

// Label only if it fits; trailing-ellipsis truncation. Returns null if too narrow.
export function fitLabel(name, w, charPx) {
  charPx = charPx || 6.6;
  const max = Math.floor((w - 8) / charPx);
  if (max < 3) return null;
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + '…';
}
