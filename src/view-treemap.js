// TreemapView — a squarified treemap view type (FG-061). Extends BaseView, reusing the
// entire context (data, selection, search, colors, legend, detail slide-over). Only the
// geometry differs: treemapLayout() produces {x,y,w,h} rectangles instead of angular wedges.
// Click zooms in (focus a subtree); double-click or click on the focused root zooms out.
import { BaseView } from './render-canvas.js';
import { treemapLayout } from './treemap-layout.js';
import { funcName, colorForFunc } from './colors.js';

const MIN_LABEL_W = 32;  // minimum cell width (px) to attempt a label
const MIN_LABEL_H = 12;  // minimum cell height (px) to attempt a label
const CHAR_PX = 6.5;     // approximate glyph width for Helvetica 11px
const LINE_H = 13;        // label line height

function fitLabel(name, w) {
  const max = Math.floor((w - 6) / CHAR_PX);
  if (max < 2) return null;
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + '…';
}

export class TreemapView extends BaseView {
  constructor(canvas, profile, weightType, mode, opts) {
    super(canvas, profile, weightType, mode, opts);
    this.dpr = window.devicePixelRatio || 1;
    this._raf = 0;
    this.boxes = [];
    this._on = {
      move:   (e) => this._onMove(e),
      leave:  () => { this.hover = null; this._tooltip(null); this._schedule(); },
      click:  (e) => this._onClick(e),
      dbl:    (e) => this._onDblClick(e),
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
    c.removeEventListener('mousemove', h.move);
    c.removeEventListener('mouseleave', h.leave);
    c.removeEventListener('click', h.click);
    c.removeEventListener('dblclick', h.dbl);
    window.removeEventListener('resize', h.resize);
  }

  relayout() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth || 1000;
    const reserve = 8;
    const h = Math.max(160, (window.innerHeight || 800) - (this.canvas.offsetTop || 0) - reserve);
    this.cssW = w;
    this.cssH = h;
    this.canvas.style.height = h + 'px';
    this.canvas.width  = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);

    const focus = this.focus == null ? undefined : this.focus;
    this.boxes = treemapLayout(this.ct, { width: w, height: h, focus, minArea: 4 });
    this._schedule();
  }

  // Return the deepest box that contains (px, py).
  _hit(px, py) {
    let best = null;
    for (const b of this.boxes) {
      if (px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h) {
        if (!best || b.depth > best.depth) best = b;
      }
    }
    return best;
  }

  _onMove(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    this.hover = this._hit(px, py);
    this.canvas.style.cursor = this.hover ? 'pointer' : 'default';
    this._schedule();
    this._tooltip(this.hover, e);
  }

  _onClick(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const b = this._hit(px, py);

    // zoom in on click; zoom out if clicking the already-focused root
    if (b) {
      if (this.focus != null && b.node === this.focus) {
        // clicked the focused root — zoom out
        const parentNode = this.ct.prefix[this.focus];
        this.focus = parentNode >= 0 ? parentNode : null;
        this._markZoomed();
        this.relayout();
        return;
      }
      // select + zoom in
      this.selectedFunc = b.func;
      this.selectedNode = b.node;
      this._updateDetail(b);
      if (this._opts.onSelect) this._opts.onSelect(b);
      this.focus = b.node;
      this._markZoomed();
      this.relayout();
    } else {
      // click on empty — zoom out
      if (this.focus != null) {
        const parentNode = this.ct.prefix[this.focus];
        this.focus = parentNode >= 0 ? parentNode : null;
        this.relayout();
      }
    }
  }

  // No minimap chrome — never block contextmenu/event-routing code that checks this.
  _hasMinimap() { return false; }

  // FG-061: focusBox mirrors RadialView's focusBox for the context-menu / navigation API.
  focusBox(b) { this.focus = b ? b.node : null; this.relayout(); }

  _onDblClick(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const b = this._hit(px, py);
    this._markZoomed();
    if (b && b.node !== this.focus) {
      this.focus = b.node;
    } else {
      // already focused or empty — zoom out
      const parent = this.focus != null ? this.ct.prefix[this.focus] : -1;
      this.focus = parent >= 0 ? parent : null;
    }
    this.relayout();
  }

  draw() {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = this.T.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    ctx.font = `11px Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    for (const b of this.boxes) {
      const lit = this._lit(b);
      const fill = colorForFunc(this.p, b.func);
      ctx.globalAlpha = lit ? 1 : 0.28;
      ctx.fillStyle = fill;
      ctx.fillRect(b.x, b.y, b.w, b.h);

      // 1px border between cells (drawn as a dark stroke inside)
      ctx.globalAlpha = lit ? 0.35 : 0.12;
      ctx.strokeStyle = this.T.bg;
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);

      // selection outline
      if (this.selectedFunc != null && b.func === this.selectedFunc && b.w > 2 && b.h > 2) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = this.T.sel;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.x + 0.75, b.y + 0.75, b.w - 1.5, b.h - 1.5);
      }

      // label — only for cells large enough to hold text
      if (b.w >= MIN_LABEL_W && b.h >= MIN_LABEL_H) {
        const name = funcName(this.p, b.func);
        const lab = fitLabel(name, b.w);
        if (lab) {
          const tx = this._textOn(fill);
          ctx.globalAlpha = lit ? 0.92 : 0.4;
          ctx.fillStyle = tx;

          const weightStr = this._fmtWeight(b.total);
          const showWeight = b.h >= MIN_LABEL_H * 2.2 && b.w >= MIN_LABEL_W + 20;
          if (showWeight) {
            const wtLab = fitLabel(weightStr, b.w);
            const midY = b.y + b.h / 2;
            ctx.fillText(lab, b.x + 4, midY - LINE_H / 2);
            if (wtLab) {
              ctx.globalAlpha = (lit ? 0.65 : 0.3);
              ctx.fillText(wtLab, b.x + 4, midY + LINE_H / 2);
            }
          } else {
            ctx.fillText(lab, b.x + 4, b.y + b.h / 2);
          }
        }
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

TreemapView.capabilities = { modes: ['graph'], minimap: false };
