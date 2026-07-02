// Pure squarified treemap layout (Bruls/Huizing/van Wijk). No DOM, no side effects.
// treemapLayout(ct, opts) → array of { node, func, x, y, w, h, depth, total, self }
//
// Standard squarified algorithm:
// Given a rectangle of dimensions W × H, choose the shorter side S = min(W, H).
// Fill a row of children so that each child spans the full S dimension.
// The row strip consumes (sumArea / S) of the long side.
// Add children to the current row while the worst aspect ratio improves, then flush.
//
// Areas are proportional to ct.total. Children sorted desc for determinism.
// Per-level inset padding (2px) lets nesting read visually.
// Cells below opts.minArea are pruned (and their subtrees too).

const PAD = 2;                  // inset pixels per level-transition
const MIN_AREA_DEFAULT = 4;     // px² minimum cell area

// Worst aspect ratio for a row of scaled areas laid along shortSide.
// Each cell: one dimension = S (the short side), other = a/totalArea * S^2/totalArea ...
// Actually: row strip has thickness = sumA / S.
// Each cell within the strip: width = a/sumA * S, height = sumA/S (or vice versa).
// Aspect ratio of cell i = max(cellAlong / cellCross, cellCross / cellAlong)
// where cellAlong = a_i/sumA * S, cellCross = sumA/S.
function worstAspect(areas, shortSide) {
  const sumA = areas.reduce((s, a) => s + a, 0);
  if (sumA <= 0 || shortSide <= 0) return Infinity;
  const thickness = sumA / shortSide;   // row strip thickness along long axis
  let max = 0;
  for (const a of areas) {
    const cellAlong = (a / sumA) * shortSide;  // cell extent along short axis
    if (cellAlong <= 0) return Infinity;
    const r = Math.max(cellAlong / thickness, thickness / cellAlong);
    if (r > max) max = r;
  }
  return max;
}

// Layout a completed row and recurse into children.
// The row fills the full short dimension of [rx,ry,rw,rh] and some of the long dimension.
// Returns the updated residual rect [rx2, ry2, rw2, rh2].
function placeRow(rowItems, sumArea, rx, ry, rw, rh, depth, boxes, minArea) {
  if (!rowItems.length || sumArea <= 0 || rw <= 0 || rh <= 0) return [rx, ry, rw, rh];

  const isLandscape = rw >= rh;
  const shortSide   = isLandscape ? rh : rw;   // short side = H if landscape, W if portrait
  const thickness   = sumArea / shortSide;       // how much of the long side this row consumes

  let pos = isLandscape ? ry : rx;   // position along the short axis for each cell

  for (const { node, func, area, total, self, children } of rowItems) {
    const cellAlong = (area / sumArea) * shortSide;  // cell extent along short axis
    let bx, by, bw, bh;
    if (isLandscape) {
      // Long axis = horizontal: row strip occupies left `thickness` pixels, cells stacked vertically
      bx = rx;        by = pos;
      bw = thickness; bh = cellAlong;
    } else {
      // Long axis = vertical: row strip occupies top `thickness` pixels, cells stacked horizontally
      bx = pos;       by = ry;
      bw = cellAlong; bh = thickness;
    }
    if (bw * bh >= minArea) {
      boxes.push({ node, func, x: bx, y: by, w: bw, h: bh, depth, total, self });
      if (children && children.length) {
        const ix = bx + PAD, iy = by + PAD, iw = bw - PAD * 2, ih = bh - PAD * 2;
        if (iw > 0 && ih > 0) squarify(children, ix, iy, iw, ih, depth + 1, boxes, minArea);
      }
    }
    pos += cellAlong;
  }

  // Advance the residual rect past this strip
  if (isLandscape) { return [rx + thickness, ry, rw - thickness, rh]; }
  else             { return [rx, ry + thickness, rw, rh - thickness]; }
}

function squarify(items, rx, ry, rw, rh, depth, boxes, minArea) {
  if (!items.length || rw <= 0 || rh <= 0) return;

  const totalWeight = items.reduce((s, it) => s + it.weight, 0);
  if (totalWeight <= 0) return;

  const totalArea = rw * rh;
  const scale = totalArea / totalWeight;  // px² per unit weight

  let row      = [];    // current row items
  let rowAreas = [];    // scaled areas (px²) for aspect-ratio computation
  let sumArea  = 0;
  let curRx = rx, curRy = ry, curRw = rw, curRh = rh;

  for (let i = 0; i < items.length; i++) {
    const it    = items[i];
    const a     = it.weight * scale;
    const short = Math.min(curRw, curRh);

    if (row.length === 0) {
      row.push(it); rowAreas.push(a); sumArea = a; continue;
    }

    const newAreas   = [...rowAreas, a];
    const newSumArea = sumArea + a;
    const curW = worstAspect(rowAreas, short);
    const newW = worstAspect(newAreas, short);

    if (newW <= curW) {
      // adding this item improves or maintains the worst ratio
      row.push(it); rowAreas.push(a); sumArea = newSumArea;
    } else {
      // flush and recurse on the tail
      [curRx, curRy, curRw, curRh] = placeRow(
        row.map((it, idx) => ({ node: it.node, func: it.func, area: rowAreas[idx], total: it.total, self: it.self, children: it.children })),
        sumArea, curRx, curRy, curRw, curRh, depth, boxes, minArea
      );
      // recurse on the remaining items in the residual rectangle
      squarify(items.slice(i), curRx, curRy, curRw, curRh, depth, boxes, minArea);
      return;
    }
  }

  // flush the final row
  if (row.length) {
    placeRow(
      row.map((it, idx) => ({ node: it.node, func: it.func, area: rowAreas[idx], total: it.total, self: it.self, children: it.children })),
      sumArea, curRx, curRy, curRw, curRh, depth, boxes, minArea
    );
  }
}

// Build a tree of weighted items from the call-node table rooted at the given nodes.
function buildItems(ct, nodeIndices) {
  return nodeIndices
    .filter((node) => ct.total[node] > 0)
    .sort((a, b) => ct.total[b] - ct.total[a])  // desc for determinism
    .map((node) => ({
      node,
      func:     ct.func[node],
      weight:   ct.total[node],
      total:    ct.total[node],
      self:     ct.self[node],
      children: buildItems(ct, ct.children[node]),
    }));
}

export function treemapLayout(ct, opts) {
  const minArea = (opts && opts.minArea != null) ? opts.minArea : MIN_AREA_DEFAULT;
  const W = (opts && opts.width)  || 1000;
  const H = (opts && opts.height) || 600;
  const boxes = [];

  const roots = (opts && opts.focus != null && opts.focus >= 0) ? [opts.focus] : ct.roots;
  const items = buildItems(ct, roots);
  squarify(items, 0, 0, W, H, 0, boxes, minArea);
  return boxes;
}
