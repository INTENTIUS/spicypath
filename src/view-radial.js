// RadialView — a sunburst view type (FG-039). Extends BaseView, reusing the entire context
// (data, selection, search, colors, legend, detail slide-over). Only the geometry differs:
// we run the SAME layout() but with width = 2π, so each box's `x`/`w` are an angular start/
// span and `depth` is a ring. relayout/draw/_hit + interaction are radial; everything else
// (modes graph/diff, _lit, _tooltip, _updateDetail, _updateLegend) comes from BaseView.
import { BaseView } from './render-canvas.js';
import { layout } from './layout.js';
import { funcName, colorForFunc, colorForDelta } from './colors.js';

const TAU = Math.PI * 2;
const maxDepthOf = (bs) => { let m = 0; for (const b of bs) if (b.depth > m) m = b.depth; return m; };

// Wrap a (usually delimiter-rich) symbol name to <= maxLines, preferring breaks at / . :
function wrapLabel(s, n, maxLines) {
  const out = []; let rest = s;
  while (rest.length && out.length < maxLines) {
    if (rest.length <= n) { out.push(rest); rest = ''; break; }
    let cut = -1;
    for (let i = Math.min(n, rest.length - 1); i >= Math.floor(n * 0.5); i--) if (/[/.:]/.test(rest[i])) { cut = i + 1; break; }
    if (cut < 0) cut = n;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest.length && out.length) out[out.length - 1] = out[out.length - 1].replace(/.$/, '…');
  return out;
}

export class RadialView extends BaseView {
  constructor(canvas, profile, weightType, mode, opts) {
    super(canvas, profile, weightType, mode, opts);
    this.dpr = window.devicePixelRatio || 1;
    this._raf = 0;
    this._anim = null; // zoom transition state { start, dur, p }
    this._on = {
      move: (e) => this._onMove(e),
      leave: () => { this.hover = null; this._tooltip(null); this._schedule(); },
      click: (e) => this._onClick(e),
      dbl: (e) => this._onDblClick(e),
      resize: () => this.relayout(),
    };
    canvas.addEventListener('mousemove', this._on.move);
    canvas.addEventListener('mouseleave', this._on.leave);
    canvas.addEventListener('click', this._on.click);
    canvas.addEventListener('dblclick', this._on.dbl);
    window.addEventListener('resize', this._on.resize);
    this.relayout();
    this._updateLegend();
  }
  dispose() {
    const c = this.canvas, h = this._on;
    c.removeEventListener('mousemove', h.move); c.removeEventListener('mouseleave', h.leave);
    c.removeEventListener('click', h.click); c.removeEventListener('dblclick', h.dbl);
    window.removeEventListener('resize', h.resize);
  }

  relayout() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth || 1000;
    const reserve = 8; // top strip is in offsetTop; small bottom margin only
    const h = Math.max(160, (window.innerHeight || 800) - (this.canvas.offsetTop || 0) - reserve);
    this.cssW = w; this.cssH = h;
    this.cx = w / 2; this.cy = h / 2;                         // centered
    this.maxR = Math.max(60, Math.min(w, h) / 2 - 8);        // circle fills the short dimension
    this.r0 = Math.max(34, Math.min(70, this.maxR * 0.17));  // center hole holds the focal label
    const focus = this.focus == null ? undefined : this.focus;
    const opts = { width: TAU, minWidth: 1 / this.maxR, focus }; // minWidth ≈ 1px arc at the rim
    if (this.mode === 'graph') opts.collapse = this.collapse;     // collapse only meaningful aggregated
    this.boxes = layout(this.ct, opts);             // box.x/x+w = angle range, box.depth = ring
    this.maxDepth = maxDepthOf(this.boxes);
    this.ringH = Math.max(2, (this.maxR - this.r0) / (this.maxDepth + 1));
    this.canvas.style.height = this.cssH + 'px';
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this._schedule();
  }

  _hit(px, py) {
    const dx = px - this.cx, dy = py - this.cy, r = Math.hypot(dx, dy);
    if (r < this.r0 || r > this.maxR) return null;
    let theta = Math.atan2(dy, dx) + Math.PI / 2;   // 0 at 12 o'clock, clockwise (matches A0 below)
    theta = ((theta % TAU) + TAU) % TAU;
    const ring = Math.floor((r - this.r0) / this.ringH);
    for (const b of this.boxes) if (b.depth === ring && theta >= b.x && theta < b.x + b.w) return b;
    return null;
  }

  _onMove(e) {
    const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    this.hover = this._hit(px, py);
    this.canvas.style.cursor = this.hover ? 'pointer' : 'default';
    this._schedule(); this._tooltip(this.hover, e);
  }
  _onClick(e) {
    const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    const b = this._hit(px, py);
    this.selectedFunc = b ? b.func : null;
    this.selectedNode = (b && b.node != null) ? b.node : null;
    this._updateDetail(b);
    if (this._opts.onSelect) this._opts.onSelect(b || null);
    this._schedule();
  }
  focusBox(b) { this.focus = b ? b.node : null; this.relayout(); this._startZoomAnim(); } // shared by dblclick + menu
  _onDblClick(e) { // zoom: focus the clicked subtree; click the center to pop back out
    const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    this._markZoomed();
    this.focusBox(this._hit(px, py));
  }
  // a short eased scale+fade pulse on focus change — feedback for the (non-obvious) zoom
  _startZoomAnim() {
    const a = this._anim = { start: null, dur: 260, p: 0 };
    const step = (ts) => {
      if (this._anim !== a) return;                 // superseded by a newer zoom
      if (a.start == null) a.start = ts;
      a.p = Math.min(1, (ts - a.start) / a.dur);
      this.draw();
      if (a.p < 1) requestAnimationFrame(step); else { this._anim = null; this.draw(); }
    };
    requestAnimationFrame(step);
  }

  draw() {
    const ctx = this.ctx, A0 = -Math.PI / 2; // start ring at the top, sweep clockwise
    ctx.save(); ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = this.T.bg; ctx.fillRect(0, 0, this.cssW, this.cssH);
    const e = this._anim ? 1 - Math.pow(1 - this._anim.p, 3) : 1; // easeOutCubic; 1 when not animating
    ctx.save();
    if (this._anim) { ctx.translate(this.cx, this.cy); const s = 0.86 + 0.14 * e; ctx.scale(s, s); ctx.translate(-this.cx, -this.cy); }
    // wedges
    for (const b of this.boxes) {
      const rIn = this.r0 + b.depth * this.ringH, rOut = rIn + Math.max(1, this.ringH - 0.7);
      const g = Math.min(b.w * 0.22, 1.4 / Math.max(8, rIn)); // tiny angular gap between wedges
      let a0 = A0 + b.x + g, a1 = A0 + b.x + b.w - g;
      if (a1 <= a0) { a0 = A0 + b.x; a1 = A0 + b.x + b.w; }   // too thin for a gap → draw full
      ctx.globalAlpha = (this._lit(b) ? 1 : 0.3) * e;
      ctx.fillStyle = this.mode === 'diff' ? colorForDelta(b.delta || 0, this.diffMax) : colorForFunc(this.p, b.func);
      ctx.beginPath(); ctx.arc(this.cx, this.cy, rOut, a0, a1); ctx.arc(this.cx, this.cy, rIn, a1, a0, true); ctx.closePath(); ctx.fill();
      if (this.selectedFunc != null && b.func === this.selectedFunc) { ctx.globalAlpha = e; ctx.strokeStyle = this.T.sel; ctx.lineWidth = 1.2; ctx.stroke(); }
    }
    ctx.restore(); // end zoom-transition transform
    // center hole + focal label (hovered wedge, else a hint / back affordance)
    ctx.globalAlpha = 1; ctx.fillStyle = this.T.bg; ctx.beginPath(); ctx.arc(this.cx, this.cy, this.r0, 0, TAU); ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const focal = this.hover;
    if (focal) {
      const lines = wrapLabel(funcName(this.p, focal.func), 16, 3);
      ctx.font = '12px Helvetica, Arial, sans-serif'; ctx.fillStyle = this.T.fg;
      const lh = 14, sy = this.cy - ((lines.length - 1) * lh) / 2 - 7;
      lines.forEach((ln, i) => ctx.fillText(ln, this.cx, sy + i * lh));
      ctx.font = '11px Menlo, Consolas, monospace'; ctx.fillStyle = this.T.dim;
      const stat = this.mode === 'diff'
        ? `Δ ${(focal.delta || 0) * 100 >= 0 ? '+' : ''}${((focal.delta || 0) * 100).toFixed(1)}%`
        : `${(100 * focal.total / (this.ct.grandTotal || 1)).toFixed(1)}%`;
      ctx.fillText(stat, this.cx, sy + lines.length * lh);
    } else {
      ctx.fillStyle = this.T.faint; ctx.font = '11px Menlo, Consolas, monospace';
      ctx.fillText(this.focus != null ? '↩ back' : 'hover a wedge', this.cx, this.cy);
    }
    ctx.textAlign = 'left';
    ctx.restore();
  }
}
RadialView.capabilities = { modes: ['graph'], minimap: false }; // aggregated only; diff via compare
