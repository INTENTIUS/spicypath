// GraphView — a call-graph view type (FG-051 phase 3). Extends BaseView, reusing the entire
// context (data, selection, search, colors, legend, detail slide-over). Geometry: runs
// buildCallGraph + layoutCallGraph to produce positioned nodes and edges, then paints them
// on canvas. Interaction: AABB hit-test for hover/click; no zoom/pan (Phase 4).
import { BaseView } from './render-canvas.js';
import { buildCallGraph } from './callgraph.js';
import { layoutCallGraph } from './callgraph-layout.js';
import { funcName, colorForFunc } from './colors.js';
import { fitLabel } from './layout.js';

// Corner radius for node rounded-rects.
const NODE_R = 5;

// Draw a rounded rectangle path (used for node fills and outlines).
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

export class GraphView extends BaseView {
  constructor(canvas, profile, weightType, mode, opts) {
    super(canvas, profile, weightType, mode, opts);
    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this._raf = 0;
    // Laid-out graph state (populated by relayout).
    this._nodes = [];
    this._edges = [];
    this._graphW = 0;
    this._graphH = 0;
    // Bound handlers for listener removal.
    this._on = {
      move: (e) => this._onMove(e),
      leave: () => { this.hover = null; this._tooltip(null); this._schedule(); },
      click: (e) => this._onClick(e),
      resize: () => this.relayout(),
    };
    canvas.addEventListener('mousemove', this._on.move);
    canvas.addEventListener('mouseleave', this._on.leave);
    canvas.addEventListener('click', this._on.click);
    if (typeof window !== 'undefined') window.addEventListener('resize', this._on.resize);
    this.relayout();
    this._updateLegend();
  }

  dispose() {
    const c = this.canvas, h = this._on;
    c.removeEventListener('mousemove', h.move);
    c.removeEventListener('mouseleave', h.leave);
    c.removeEventListener('click', h.click);
    if (typeof window !== 'undefined') window.removeEventListener('resize', h.resize);
  }

  relayout() {
    const w = this.canvas.clientWidth || (this.canvas.parentElement && this.canvas.parentElement.clientWidth) || 1000;
    const reserve = 8;
    const h = Math.max(400, ((typeof window !== 'undefined' && window.innerHeight) || 800) - (this.canvas.offsetTop || 0) - reserve);
    this.cssW = w;
    this.cssH = h;

    // Build the call graph and lay it out.
    const g = buildCallGraph(this.ct, this.p);
    const lg = layoutCallGraph(g, { width: w });
    this._nodes = lg.nodes;
    this._edges = lg.edges;
    this._graphW = lg.width;
    this._graphH = lg.height;

    // Size the canvas (DPR-aware).
    this.canvas.style.height = this.cssH + 'px';
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this._schedule();
  }

  // AABB hit-test: return the node whose rect contains (px, py), or null.
  _hit(px, py) {
    for (const n of this._nodes) {
      if (px >= n.x && px < n.x + n.w && py >= n.y && py < n.y + n.h) return n;
    }
    return null;
  }

  _onMove(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    this.hover = this._hit(px, py);
    this.canvas.style.cursor = this.hover ? 'pointer' : 'default';
    this._tooltip(this.hover, e);
    this._schedule();
  }

  _onClick(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const hit = this._hit(px, py);
    if (hit) this.selectFunc(hit.func);
  }

  draw() {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    // Background.
    ctx.fillStyle = this.T.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    ctx.font = '11px Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const gt = this.ct.grandTotal || 1;

    // ---- Draw edges first (behind nodes) ----
    for (const edge of this._edges) {
      if (!edge.points || edge.points.length < 2) continue;
      const [p0, p1] = edge.points;

      // Stroke width proportional to cost relative to grandTotal, clamped to [0.5, 4].
      const costFrac = edge.cost / gt;
      const lw = Math.max(0.5, Math.min(4, costFrac * 20));

      ctx.lineWidth = lw;

      if (edge.selfEdge) {
        // Self-edge: small arc offset to the side of the node center.
        const fromNode = this._nodes.find((n) => n.func === edge.from);
        if (fromNode) {
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = this.T.dim;
          ctx.setLineDash([3, 3]);
          const cx = fromNode.x + fromNode.w / 2;
          const cy = fromNode.y + fromNode.h / 2;
          const radius = fromNode.w * 0.22;
          ctx.beginPath();
          ctx.arc(cx + fromNode.w / 2 + radius, cy, radius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else if (edge.backEdge) {
        // Back-edge: dashed line.
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = this.T.dim;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        // Normal forward edge: solid line.
        ctx.globalAlpha = Math.max(0.18, Math.min(0.85, 0.25 + costFrac * 4));
        ctx.strokeStyle = this.T.line;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // ---- Draw nodes (on top of edges) ----
    for (const node of this._nodes) {
      const lit = this._lit(node);
      const fill = colorForFunc(this.p, node.func);
      const { x, y, w, h } = node;

      ctx.globalAlpha = lit ? 1 : 0.3;
      ctx.fillStyle = fill;
      roundRect(ctx, x, y, w, h, NODE_R);
      ctx.fill();

      // Selection outline.
      if (this.selectedFunc != null && node.func === this.selectedFunc && w > 2) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = this.T.sel;
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, w, h, NODE_R);
        ctx.stroke();
      }

      // Label: fitted name.
      const label = fitLabel(funcName(this.p, node.func), w);
      if (label) {
        ctx.globalAlpha = lit ? 1 : 0.5;
        ctx.fillStyle = this._textOn(fill);
        ctx.fillText(label, x + 6, y + h / 2);
      }
    }

    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.restore();
  }
}

GraphView.capabilities = { modes: ['graph'], minimap: false };
