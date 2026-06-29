// GraphView — a call-graph view type (FG-051 phase 3+4). Extends BaseView, reusing the entire
// context (data, selection, search, colors, legend, detail slide-over). Geometry: runs
// buildCallGraph + layoutCallGraph to produce positioned nodes and edges, then paints them
// on canvas. Interaction (Phase 4): pan/zoom viewport, hover-highlight of node neighborhood,
// focus subgraph on double-click, weight-based node pruning with disclosure.
import { BaseView } from './render-canvas.js';
import { buildCallGraph } from './callgraph.js';
import { layoutCallGraph } from './callgraph-layout.js';
import { funcName, colorForFunc } from './colors.js';
import { fitLabel } from './layout.js';

// Corner radius for node rounded-rects.
const NODE_R = 5;

// Default maximum nodes to render for large graphs (pruning cap).
const DEFAULT_PRUNE_K = 150;

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

    // Full (un-focused) graph, preserved so focus can be cleared.
    this._fullNodes = [];
    this._fullEdges = [];

    // Viewport transform: screen coords = graph coords * scale + translation.
    // Applied in draw(), inverted in _hit().
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;

    // Focus state: funcIndex of the double-clicked node, or null for the full graph.
    this._focalFunc = null;

    // Hover state: node under the cursor (or null).
    this.hoverNode = null;
    // Sets of highlighted funcs/edges when hoverNode is set.
    this._hoverFuncs = null; // Set<funcIndex> (focal + neighbors)
    this._hoverEdgeSet = null; // Set<edge object>

    // Pruning disclosure: { shown, total } set after relayout.
    this.pruned = null;

    // Pruning cap — exposed for tests and future config.
    this.pruneK = DEFAULT_PRUNE_K;

    // Pan drag state (window-level mousemove/up pattern from FlameView).
    this._panMove = null;
    this._panUp = null;

    // Bound handlers for listener removal.
    this._on = {
      move: (e) => this._onMove(e),
      leave: () => {
        this.hover = null;
        this.hoverNode = null;
        this._hoverFuncs = null;
        this._hoverEdgeSet = null;
        this._tooltip(null);
        this._schedule();
      },
      down: (e) => this._onDown(e),
      click: (e) => this._onClick(e),
      dbl: (e) => this._onDblClick(e),
      wheel: (e) => this._onWheel(e),
      resize: () => this.relayout(),
      keydown: (e) => {
        if (e.key === 'Escape') { this._clearFocus(); }
      },
    };
    canvas.addEventListener('mousemove', this._on.move);
    canvas.addEventListener('mouseleave', this._on.leave);
    canvas.addEventListener('mousedown', this._on.down);
    canvas.addEventListener('click', this._on.click);
    canvas.addEventListener('dblclick', this._on.dbl);
    canvas.addEventListener('wheel', this._on.wheel, { passive: false });
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._on.resize);
      window.addEventListener('keydown', this._on.keydown);
    }
    this.relayout();
    this._updateLegend();
  }

  dispose() {
    const c = this.canvas, h = this._on;
    c.removeEventListener('mousemove', h.move);
    c.removeEventListener('mouseleave', h.leave);
    c.removeEventListener('mousedown', h.down);
    c.removeEventListener('click', h.click);
    c.removeEventListener('dblclick', h.dbl);
    c.removeEventListener('wheel', h.wheel);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', h.resize);
      window.removeEventListener('keydown', h.keydown);
    }
    // Remove any lingering window-level pan listeners.
    this._removePanListeners();
  }

  // ---- Transform helpers ----

  // Reset viewport to identity and clear focus.
  resetZoom() {
    this._focalFunc = null;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this._nodes = this._fullNodes;
    this._edges = this._fullEdges;
    this._schedule();
  }

  // Map screen (px,py) → graph coordinates, accounting for current transform.
  _screenToGraph(px, py) {
    const s = this.scale || 1;
    return { gx: (px - this.tx) / s, gy: (py - this.ty) / s };
  }

  // Keep cursor's graph point fixed while scaling (zoom-about-cursor).
  _zoomAt(px, py, mult) {
    const s = this.scale || 1;
    const newScale = Math.max(0.05, Math.min(20, s * mult));
    // graph point under cursor before: (px - tx) / s
    // after scale change: (px - newTx) / newScale = same graph point
    // => newTx = px - gx * newScale
    const gx = (px - this.tx) / s;
    const gy = (py - this.ty) / s;
    if (!isFinite(gx) || !isFinite(gy) || !isFinite(newScale)) return;
    this.tx = px - gx * newScale;
    this.ty = py - gy * newScale;
    this.scale = newScale;
    this._schedule();
  }

  // ---- relayout ----

  relayout() {
    const w = this.canvas.clientWidth || (this.canvas.parentElement && this.canvas.parentElement.clientWidth) || 1000;
    const reserve = 8;
    const h = Math.max(400, ((typeof window !== 'undefined' && window.innerHeight) || 800) - (this.canvas.offsetTop || 0) - reserve);
    this.cssW = w;
    this.cssH = h;

    // Build the full call graph.
    const g = buildCallGraph(this.ct, this.p);
    let { nodes: allNodes, edges: allEdges } = g;
    const totalCount = allNodes.length;

    // Weight pruning: cap to top-K nodes by total weight.
    let shown = allNodes;
    let shownEdges = allEdges;
    if (allNodes.length > this.pruneK) {
      // Sort descending by total, keep top-K.
      const sorted = allNodes.slice().sort((a, b) => b.total - a.total);
      const kept = new Set(sorted.slice(0, this.pruneK).map((n) => n.func));
      shown = allNodes.filter((n) => kept.has(n.func));
      shownEdges = allEdges.filter((e) => kept.has(e.from) && kept.has(e.to));
    }
    this.pruned = { shown: shown.length, total: totalCount };

    // If a focal function is set, filter to its neighborhood.
    if (this._focalFunc != null) {
      const focal = this._focalFunc;
      // Determine which funcs are in the neighborhood: focal + direct callers + direct callees.
      const nbFuncs = new Set([focal]);
      for (const e of shownEdges) {
        if (e.from === focal) nbFuncs.add(e.to);   // callee
        if (e.to === focal)   nbFuncs.add(e.from);  // caller
      }
      shown = shown.filter((n) => nbFuncs.has(n.func));
      shownEdges = shownEdges.filter((e) => nbFuncs.has(e.from) && nbFuncs.has(e.to));
    }

    // Lay out the (possibly filtered) subgraph.
    const lg = layoutCallGraph({ nodes: shown, edges: shownEdges, byFunc: g.byFunc, grandTotal: g.grandTotal }, { width: w });
    this._nodes = lg.nodes;
    this._edges = lg.edges;
    this._graphW = lg.width;
    this._graphH = lg.height;

    // Preserve the full (pruned-but-not-focused) set so focus can be cleared.
    if (this._focalFunc == null) {
      this._fullNodes = this._nodes;
      this._fullEdges = this._edges;
    }

    // Clear hover highlight on relayout to avoid stale references.
    this.hoverNode = null;
    this._hoverFuncs = null;
    this._hoverEdgeSet = null;

    // Size the canvas (DPR-aware).
    this.canvas.style.height = this.cssH + 'px';
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this._schedule();
  }

  // ---- Focus helpers ----

  _clearFocus() {
    if (this._focalFunc == null) return;
    this._focalFunc = null;
    this._nodes = this._fullNodes;
    this._edges = this._fullEdges;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this._schedule();
  }

  // ---- AABB hit-test (inverts viewport transform before testing) ----

  _hit(px, py) {
    const { gx, gy } = this._screenToGraph(px, py);
    for (const n of this._nodes) {
      if (gx >= n.x && gx < n.x + n.w && gy >= n.y && gy < n.y + n.h) return n;
    }
    return null;
  }

  // ---- Hover neighborhood ----

  _computeHoverHighlight(node) {
    if (!node) {
      this._hoverFuncs = null;
      this._hoverEdgeSet = null;
      return;
    }
    const funcs = new Set([node.func]);
    const edgeSet = new Set();
    for (const e of this._edges) {
      if (e.from === node.func || e.to === node.func) {
        edgeSet.add(e);
        funcs.add(e.from);
        funcs.add(e.to);
      }
    }
    this._hoverFuncs = funcs;
    this._hoverEdgeSet = edgeSet;
  }

  // Whether a node or edge is "highlighted" — lit by search, hover-neighborhood, or no filter.
  _litNode(node) {
    // Search filter takes precedence.
    if (this.matchedFuncs) return this.matchedFuncs.has(node.func);
    // Hover neighborhood.
    if (this._hoverFuncs) return this._hoverFuncs.has(node.func);
    return true;
  }

  _litEdge(edge) {
    if (this.matchedFuncs) {
      // Both endpoints must be matched for full highlight; partial fades.
      return this.matchedFuncs.has(edge.from) && this.matchedFuncs.has(edge.to);
    }
    if (this._hoverEdgeSet) return this._hoverEdgeSet.has(edge);
    return true;
  }

  // ---- Event handlers ----

  _onWheel(e) {
    // Ctrl/Cmd + wheel, or pinch (reported as ctrl+wheel) → zoom about cursor.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      // deltaY > 0 = zoom out, < 0 = zoom in (matches FlameView convention with mult).
      // deltaY < 0 = scroll up = zoom in (increase magnification scale).
      this._zoomAt(px, py, Math.pow(1.0018, -e.deltaY));
      return;
    }
    // Plain wheel → pan vertically (and horizontally for horizontal scroll devices).
    e.preventDefault();
    this.tx -= (e.deltaX || 0);
    this.ty -= e.deltaY;
    this._schedule();
  }

  _onDown(e) {
    // Only primary button starts a pan drag.
    if (e.button !== 0) return;
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const startX = e.clientX - r.left, startY = e.clientY - r.top;
    const startTx = this.tx, startTy = this.ty;
    let dragged = false;

    this._panMove = (ev) => {
      const dx = ev.clientX - r.left - startX;
      const dy = ev.clientY - r.top - startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragged = true;
      this.tx = startTx + dx;
      this.ty = startTy + dy;
      this._schedule();
    };
    this._panUp = () => {
      this._removePanListeners();
      // If the mouse barely moved this was a click, not a drag. The click event
      // fires after mouseup and handles selection normally. If it WAS a drag,
      // we swallow nothing — the click handler checks via _hit which is now
      // in graph space, so it still works.
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', this._panMove);
      window.addEventListener('mouseup', this._panUp);
    }
  }

  _removePanListeners() {
    if (this._panMove && typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this._panMove);
      window.removeEventListener('mouseup', this._panUp);
    }
    this._panMove = null;
    this._panUp = null;
  }

  _onMove(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const hit = this._hit(px, py);
    this.hover = hit;
    this.hoverNode = hit;
    this._computeHoverHighlight(hit);
    this.canvas.style.cursor = hit ? 'pointer' : 'default';
    this._tooltip(hit, e);
    this._schedule();
  }

  _onClick(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const hit = this._hit(px, py);
    if (hit) this.selectFunc(hit.func);
  }

  _onDblClick(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const hit = this._hit(px, py);
    if (hit) {
      // Focus the neighborhood of the hit node.
      this._focalFunc = hit.func;
      // Reset transform so the focused subgraph is centered.
      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.relayout();
    } else {
      // Double-click on empty space clears focus.
      this._clearFocus();
    }
  }

  // ---- draw ----

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

    // Apply viewport transform (pan + zoom) around the graph content.
    const s = this.scale, tx = this.tx, ty = this.ty;
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(s, s);

    // ---- Draw edges first (behind nodes) ----
    for (const edge of this._edges) {
      if (!edge.points || edge.points.length < 2) continue;
      const [p0, p1] = edge.points;

      const costFrac = edge.cost / gt;
      const lw = Math.max(0.5, Math.min(4, costFrac * 20));
      const edgeLit = this._litEdge(edge);
      // Incident edges of the hovered node are drawn emphasised (thicker, full alpha).
      const hoverIncident = this._hoverEdgeSet && this._hoverEdgeSet.has(edge);

      ctx.lineWidth = hoverIncident ? lw * 2 : lw;

      if (edge.selfEdge) {
        const fromNode = this._nodes.find((n) => n.func === edge.from);
        if (fromNode) {
          ctx.globalAlpha = edgeLit ? (hoverIncident ? 0.85 : 0.4) : 0.1;
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
        ctx.globalAlpha = edgeLit ? (hoverIncident ? 0.75 : 0.45) : 0.1;
        ctx.strokeStyle = this.T.dim;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const baseAlpha = Math.max(0.18, Math.min(0.85, 0.25 + costFrac * 4));
        ctx.globalAlpha = edgeLit ? (hoverIncident ? Math.min(1, baseAlpha * 1.5) : baseAlpha) : 0.06;
        ctx.strokeStyle = hoverIncident ? this.T.accent || this.T.line : this.T.line;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // ---- Draw nodes (on top of edges) ----
    for (const node of this._nodes) {
      const lit = this._litNode(node);
      const fill = colorForFunc(this.p, node.func);
      const { x, y, w, h } = node;

      ctx.globalAlpha = lit ? 1 : 0.2;
      ctx.fillStyle = fill;
      roundRect(ctx, x, y, w, h, NODE_R);
      ctx.fill();

      // Selection outline.
      if (this.selectedFunc != null && node.func === this.selectedFunc && w > 2) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = this.T.sel;
        ctx.lineWidth = 2 / s; // keep outline pixel-width constant regardless of zoom
        roundRect(ctx, x, y, w, h, NODE_R);
        ctx.stroke();
      }

      // Hovered node gets an extra emphasis ring.
      if (this.hoverNode && node.func === this.hoverNode.func) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = this.T.accent || this.T.sel;
        ctx.lineWidth = 2 / s;
        roundRect(ctx, x, y, w, h, NODE_R);
        ctx.stroke();
      }

      // Label: fitted name.
      const label = fitLabel(funcName(this.p, node.func), w);
      if (label) {
        ctx.globalAlpha = lit ? 1 : 0.35;
        ctx.fillStyle = this._textOn(fill);
        ctx.fillText(label, x + 6, y + h / 2);
      }
    }

    ctx.restore(); // end viewport transform

    ctx.globalAlpha = 1;

    // ---- Pruning disclosure ----
    if (this.pruned && this.pruned.shown < this.pruned.total) {
      const msg = `showing ${this.pruned.shown} of ${this.pruned.total} nodes (top by weight)`;
      ctx.font = '11px Menlo, Consolas, monospace';
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'right';
      const pad = 8;
      const tw = ctx.measureText(msg).width;
      ctx.fillStyle = this.T.bg || '#ffffff';
      ctx.globalAlpha = 0.82;
      ctx.fillRect(this.cssW - tw - pad * 2, this.cssH - 22, tw + pad * 2, 20);
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.T.dim || '#888';
      ctx.fillText(msg, this.cssW - pad, this.cssH - 5);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
    }

    // ---- Focus indicator ----
    if (this._focalFunc != null) {
      const name = funcName(this.p, this._focalFunc);
      const msg = `focused: ${name}  (double-click empty space or press Esc to clear)`;
      ctx.font = '11px Menlo, Consolas, monospace';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = this.T.dim || '#888';
      ctx.fillText(msg, 8, 6);
      ctx.textBaseline = 'middle';
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

GraphView.capabilities = { modes: ['graph'], minimap: false };
