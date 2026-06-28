// Paint laid-out boxes to an SVG string — borderless via 1px gaps, consistent row
// rhythm, labels only where they fit, semantic color, +N collapse badges, optional
// search dimming. Used for headless verification and doc screenshots. Same layout the
// Canvas paint uses.

import { funcName, colorForFunc, colorForDelta } from './colors.js';
import { fitLabel } from './layout.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Paint a box list into `out` at yTop. flip → draw depth from the bottom (for caller panels).
function paintBoxes(out, boxes, p, o) {
  const row = o.row, matched = o.matched || null, flip = !!o.flip, maxDepth = o.maxDepth || 0;
  for (const b of boxes) {
    const name = funcName(p, b.func);
    const fill = o.diff ? colorForDelta(b.delta, o.maxAbsDelta) : colorForFunc(p, b.func);
    const x = b.x, w = Math.max(0, b.w - 1);
    const dy = flip ? (maxDepth - b.depth) : b.depth;
    const y = o.yTop + dy * row, h = row - 1; // -1 = borderless gap
    const lit = !matched || matched.has(b.func);
    out.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" rx="2" fill="${fill}"${lit ? '' : ' fill-opacity="0.3"'}/>`);
    if (!lit) continue;
    const badge = b.collapsed > 0 && w > 44;
    const lab = fitLabel(name, w - (badge ? 24 : 0));
    if (lab) out.push(`<text x="${(x + 4).toFixed(1)}" y="${y + 15}" fill="#f4f7fb" font-size="11">${esc(lab)}</text>`);
    if (badge) {
      const bw = 20;
      out.push(`<rect x="${(x + w - bw - 3).toFixed(1)}" y="${y + 4}" width="${bw}" height="${h - 8}" rx="3" fill="#ffffff" fill-opacity="0.18"/>`);
      out.push(`<text x="${(x + w - bw + 1).toFixed(1)}" y="${y + 15}" fill="#eef2f6" font-size="9">+${b.collapsed}</text>`);
    }
  }
}

function maxDepthOf(boxes) { let m = 0; for (const b of boxes) if (b.depth > m) m = b.depth; return m; }

export function renderSVG(boxes, p, opts) {
  const row = opts.rowHeight || 22, W = opts.width, top = opts.title ? 32 : 6;
  const md = maxDepthOf(boxes);
  const H = top + (md + 1) * row + 6;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Menlo,Consolas,monospace">`,
    `<rect width="${W}" height="${H}" fill="#0d1117"/>`];
  if (opts.title) out.push(`<text x="8" y="20" fill="#e6edf3" font-size="13" font-family="Helvetica,Arial,sans-serif">${esc(opts.title)}</text>`);
  paintBoxes(out, boxes, p, { yTop: top, row, matched: opts.matched, diff: opts.diff, maxAbsDelta: opts.maxAbsDelta });
  out.push('</svg>');
  return out.join('\n');
}

// Chart with a minimap crop strip on top (full profile + translucent window rect).
export function renderChartMinimapSVG(miniBoxes, miniMaxDepth, chartBoxes, p, opts) {
  const row = opts.rowHeight || 22, W = opts.width, top = 32, MM = 52;
  const H = top + MM + (maxDepthOf(chartBoxes) + 1) * row + 6;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Menlo,Consolas,monospace">`,
    `<rect width="${W}" height="${H}" fill="#0d1117"/>`,
    `<text x="8" y="20" fill="#e6edf3" font-size="13" font-family="Helvetica,Arial,sans-serif">${esc(opts.title || '')}</text>`,
    `<rect x="0" y="${top}" width="${W}" height="${MM}" fill="#11161d"/>`];
  const rowH = (MM - 4) / (miniMaxDepth + 1);
  for (const b of miniBoxes) out.push(`<rect x="${b.x.toFixed(1)}" y="${(top + 2 + b.depth * rowH).toFixed(1)}" width="${Math.max(0.5, b.w - 0.5).toFixed(1)}" height="${Math.max(1, rowH - 0.5).toFixed(1)}" fill="${colorForFunc(p, b.func)}" fill-opacity="0.85"/>`);
  const span = opts.end - opts.start, x0 = (opts.win[0] - opts.start) / span * W, x1 = (opts.win[1] - opts.start) / span * W;
  out.push(`<rect x="${x0.toFixed(1)}" y="${top}" width="${(x1 - x0).toFixed(1)}" height="${MM}" fill="#58a6ff" fill-opacity="0.16" stroke="#58a6ff"/>`);
  paintBoxes(out, chartBoxes, p, { yTop: top + MM, row });
  out.push('</svg>');
  return out.join('\n');
}

// Sandwich: callers (flipped, F at bottom) on top → focal band → callees (F at top) below.
export function renderSandwichSVG(callerBoxes, calleeBoxes, p, opts) {
  const row = opts.rowHeight || 22, W = opts.width, top = 32;
  const cmd = maxDepthOf(callerBoxes), emd = maxDepthOf(calleeBoxes);
  const callerH = (cmd + 1) * row;
  const band = 22;
  const callerTop = top;
  const bandY = callerTop + callerH;
  const calleeTop = bandY + band;
  const H = calleeTop + (emd + 1) * row + 6;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Menlo,Consolas,monospace">`,
    `<rect width="${W}" height="${H}" fill="#0d1117"/>`];
  out.push(`<text x="8" y="20" fill="#e6edf3" font-size="13" font-family="Helvetica,Arial,sans-serif">${esc(opts.title || '')}</text>`);
  out.push(`<text x="8" y="${callerTop + 12}" fill="#8b949e" font-size="10" font-family="Helvetica,Arial,sans-serif">callers ↑</text>`);
  paintBoxes(out, callerBoxes, p, { yTop: callerTop, row, flip: true, maxDepth: cmd, matched: opts.matched });
  // focal band
  out.push(`<rect x="0" y="${bandY}" width="${W}" height="${band}" fill="#1f6feb" fill-opacity="0.18"/>`);
  out.push(`<text x="8" y="${bandY + 15}" fill="#e6edf3" font-size="11" font-weight="bold">▸ ${esc(opts.focalName || '')}</text>`);
  out.push(`<text x="${W - 8}" y="${calleeTop + 12}" text-anchor="end" fill="#8b949e" font-size="10" font-family="Helvetica,Arial,sans-serif">callees ↓</text>`);
  paintBoxes(out, calleeBoxes, p, { yTop: calleeTop, row, flip: false, maxDepth: emd, matched: opts.matched });
  out.push('</svg>');
  return out.join('\n');
}
