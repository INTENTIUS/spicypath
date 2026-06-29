// Canvas renderers, split into a shared context + pluggable view types (FG-038):
//  - BaseView: view-type-agnostic context — data prep (ct/chart/sandwich/diff), selection,
//    search, colors, legend/detail/tooltip content, mode actions. Knows nothing about geometry.
//  - FlameView (extends BaseView): the rectangular icicle/flame renderer — layout, paint,
//    hit-testing, and interaction (minimap crop, vertical scroll, zoom, crosshair, axis).
// A second view type (e.g. a radial sunburst) extends BaseView and supplies its own
// relayout()/draw()/_hit() + interaction, reusing the entire context. Modes per view:
//  - 'graph' aggregated · 'chart' time-ordered (needs hasTiming) · 'sandwich' · 'diff'.
import { buildCallNodeTable } from './callnode.js';
import { layout, fitLabel } from './layout.js';
import { buildFlameChart, chartLayout } from './flamechart.js';
import { buildSandwich } from './sandwich.js';
import { funcName, funcFile, packageOf, colorForFunc, colorForPackage, colorForDelta } from './colors.js';
import { getTokens, luminance } from './theme.js';

const ROW = 22;
const BAND = 22;
const MINIMAP_H = 52;
const SCROLLBAR_W = 12; // right-edge hit zone for the vertical scrollbar thumb
const AXIS_H = 18;      // x-axis ruler height (time for chart, %-of-total for graph)
const TIME_TO_SEC = { nanoseconds: 1e-9, microseconds: 1e-6, milliseconds: 1e-3, seconds: 1 };
const maxDepthOf = (bs) => { let m = 0; for (const b of bs) if (b.depth > m) m = b.depth; return m; };

// ──────────────────────────────────────────────────────────────────────────────────────
// BaseView — the shared, view-type-agnostic context. A concrete view extends this and adds
// geometry: relayout(), draw(), _hit(px,py), and interaction. The base supplies everything
// else (data, state, colors, legend/detail/tooltip, search, mode actions). It calls
// this.relayout()/this._updateLegend() (supplied by the subclass) from the mode actions.
// ──────────────────────────────────────────────────────────────────────────────────────
export class BaseView {
  constructor(canvas, profile, weightType, mode, opts) {
    this._opts = opts || {}; // { onSelect(box|null) } — shell hook for the detail slide-over
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.p = profile;
    this.weightType = weightType;
    this.mode = mode || 'graph';
    this.ct = buildCallNodeTable(profile, 0, weightType);
    this.chart = profile.capabilities.hasTiming ? buildFlameChart(profile, 0) : null;
    this.focus = null;
    this.win = null;          // chart time window [t0, t1]
    this.scrollY = 0;         // vertical scroll into the content (px); minimap modes only
    this.maxScrollY = 0;
    this.collapse = true;
    this.selectedFunc = null;
    this.selectedNode = null;
    this.focalFunc = null;    // sandwich subject — distinct from selectedFunc (click selection)
    this.sandwich = null;
    this.query = '';
    this.matchedFuncs = null;
    this.hover = null;
    this.hoverV = null;       // hovered domain value (time/fraction) → synced minimap↔content crosshair
    this.contentTop = 0;      // y-offset of the main content (MINIMAP_H + AXIS_H when chrome shows)
    this.miniDrag = null;
    this.diffMax = 0;
    this.domStart = 0; this.domEnd = 1; // minimap domain (time for chart, fraction for graph)
    this.T = getTokens();     // active theme's UI tokens (FG-040); refreshed by refreshTheme()
    this._selBox = null;      // last box shown in the detail slide-over (for theme refresh)
    this._txCache = new Map(); // text-color cache: fill hex → high-contrast text color
  }

  // Re-read theme tokens and repaint in place — preserves zoom/scroll/selection (FG-040).
  // Calls draw() directly (not relayout) so the canvas is never cleared: assigning canvas.width
  // wipes the bitmap, leaving a blank frame until the next rAF. A theme swap only changes colors,
  // not geometry, so a direct synchronous draw is safe and instant.
  refreshTheme() {
    this.T = getTokens();
    this._updateLegend();
    this._updateDetail(this._selBox);
    this._txCache.clear(); // box fill colors change with theme → invalidate text-color cache
    requestAnimationFrame(() => {
      this._raf = 0;
      this.draw();
      // Chrome's compositor doesn't flush the clipped canvas region (the center flame boxes) to
      // the GPU unless a DOM mutation touches the canvas element — the same mechanism that makes
      // mouse movement work (cursor style change). A data-attribute write is zero-cost visually
      // but signals the compositor to re-commit the canvas texture immediately.
      this.canvas.dataset.themeSeq = (+(this.canvas.dataset.themeSeq || 0) + 1).toString();
    });
  }

  // rgba() from a #rrggbb token + alpha — for translucent canvas fills (scrollbar, crosshair).
  _rgba(hex, a) { const n = parseInt(String(hex).slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }

  // High-contrast text color for a given fill hex. Light text on dark fills, dark text on
  // light fills. Cached per fill color (typically ≤30 unique package colors per profile).
  _textOn(fill) {
    let c = this._txCache.get(fill);
    if (!c) { c = luminance(fill) > 0.35 ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.92)'; this._txCache.set(fill, c); }
    return c;
  }

  // Sandwich always opens on the default hub (predictable re-entry); an explicit "sandwich
  // this fn" (FG-035) will set focalFunc directly instead of going through here.
  setMode(m) { this.mode = m; this.focus = null; this.win = null; this.scrollY = 0; this.hover = null; this.hoverV = null; if (m === 'sandwich') { this.focalFunc = this._defaultFocal(); this._buildSandwich(); } this.relayout(); this._updateLegend(); }
  setCollapse(b) { this.collapse = b; this.relayout(); }
  resetZoom() { this.focus = null; this.win = null; this.scrollY = 0; if (this.mode === 'sandwich') { this.focalFunc = this._defaultFocal(); this._buildSandwich(); } this.relayout(); }
  // Enter diff. Clears search too: matchedFuncs are func indices in the ORIGINAL profile, but
  // diff swaps this.p/this.ct to the synthetic diff profile (different indexing) — a stale
  // search would highlight the wrong frames.
  showDiff(d) { this.mode = 'diff'; this.ct = d.ct; this.p = d.profile; this.diffMax = d.maxAbsDelta; this.focus = null; this.win = null; this.scrollY = 0; this.hover = null; this.selectedFunc = null; this.query = ''; this.matchedFuncs = null; this.relayout(); this._updateLegend(); }
  _defaultFocal() {
    // A good sandwich subject is a *hub* — it has BOTH callers and callees. Picking the
    // heaviest-self frame often lands on a deep leaf, whose sandwich degenerates into a plain
    // inverted call stack (looks just like a flame graph). Prefer the heaviest-self frame that
    // has callers AND callees; fall back to heaviest-self if none qualifies.
    const ct = this.ct, n = ct.func.length;
    const selfByFunc = new Map(), hasCaller = new Map(), hasCallee = new Set();
    for (let i = 0; i < n; i++) {
      const f = ct.func[i];
      selfByFunc.set(f, (selfByFunc.get(f) || 0) + ct.self[i]);
      if (ct.children[i].length) hasCallee.add(f);
      if (ct.prefix[i] >= 0) { const pf = ct.func[ct.prefix[i]]; let s = hasCaller.get(f); if (!s) hasCaller.set(f, s = new Set()); s.add(pf); }
    }
    // pick the hub called from the MOST distinct places (the canonical sandwich subject —
    // "what calls this?"), tie-broken by self; this yields a balanced caller/callee split.
    let best = -1, bc = -1, bs = -1;
    for (const [f, s] of selfByFunc) {
      if (!hasCallee.has(f)) continue;
      const cc = (hasCaller.get(f) ? hasCaller.get(f).size : 0);
      if (cc >= 2 && (cc > bc || (cc === bc && s > bs))) { bc = cc; bs = s; best = f; }
    }
    if (best >= 0) return best;
    best = 0; let bw = -1; for (let i = 0; i < n; i++) if (ct.self[i] > bw) { bw = ct.self[i]; best = ct.func[i]; }
    return best;
  }
  _buildSandwich() { this.sandwich = buildSandwich(this.p, this.ct, this.focalFunc); }

  // --- public action API (context menu / future command palette). focusBox() is per-view. ---
  sandwichFunc(f) { this.mode = 'sandwich'; this.focalFunc = f; this.selectedFunc = f; this._buildSandwich(); this.relayout(); this._updateLegend(); }
  frameLabel(box) { return funcName(this.p, box.func); }
  frameStack(box) { // names root→leaf (call-node path when available, else just the frame)
    if (box && box.node != null) { const out = []; let n = box.node; while (n >= 0) { out.push(funcName(this.p, this.ct.func[n])); n = this.ct.prefix[n]; } return out.reverse(); }
    return box ? [funcName(this.p, box.func)] : [];
  }

  setSearch(q) {
    this.query = q || '';
    if (!this.query) { this.matchedFuncs = null; this._searchInfo(0, 0); this._schedule(); return; }
    let re = null; try { re = new RegExp(this.query, 'i'); } catch { re = null; }
    const lower = this.query.toLowerCase(), names = this.p.funcTable.name, m = new Set();
    for (let f = 0; f < names.length; f++) { const nm = this.p.stringTable[names[f]] || ''; if (re ? re.test(nm) : nm.toLowerCase().includes(lower)) m.add(f); }
    this.matchedFuncs = m;
    let ms = 0; for (let n = 0; n < this.ct.self.length; n++) if (m.has(this.ct.func[n])) ms += this.ct.self[n];
    this._searchInfo(m.size, this.ct.grandTotal ? ms / this.ct.grandTotal : 0);
    this._schedule();
  }
  _searchInfo(count, frac) { const el = document.getElementById('searchInfo'); if (el) el.textContent = this.query ? `${count} fn · ${(frac * 100).toFixed(1)}% self` : ''; }

  _schedule() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); }

  _ancestors(node) { const s = new Set(); let n = node; while (n >= 0) { s.add(n); n = this.ct.prefix[n]; } return s; }
  _isDesc(node, of) { let n = node; while (n >= 0) { if (n === of) return true; n = this.ct.prefix[n]; } return false; }
  _chainNames(head, tail) { const out = []; let n = tail; while (n >= 0) { out.push(funcName(this.p, this.ct.func[n])); if (n === head) break; n = this.ct.prefix[n]; } return out.reverse(); }

  // is a box "lit" (full opacity)? search match, hover call-path, or no filter active
  _lit(b) {
    if (this.matchedFuncs) return this.matchedFuncs.has(b.func);
    if (!this.hover) return true;
    if (this.mode === 'graph' || this.mode === 'diff') return this._ancestors(this.hover.node).has(b.node) || this._isDesc(b.node, this.hover.node);
    return b.func === this.hover.func;
  }

  _zoomLearned() { try { return !!localStorage.getItem('fv-zoomed'); } catch { return true; } }
  _markZoomed() { try { localStorage.setItem('fv-zoomed', '1'); } catch { /* ignore */ } }
  _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  // Format a magnitude in seconds, auto-scaled ns/µs/ms/s.
  _fmtSeconds(s) {
    const a = Math.abs(s);
    if (a < 1e-6) return (s * 1e9).toFixed(0) + 'ns';
    if (a < 1e-3) return (s * 1e6).toFixed(a < 1e-4 ? 1 : 0) + 'µs';
    if (a < 1) return (s * 1e3).toFixed(a < 1e-2 ? 1 : 0) + 'ms';
    return s.toFixed(a < 10 ? 2 : 1) + 's';
  }
  _fmtCount(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(1) + 'G';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return '' + Math.round(v);
  }
  _fmtBytes(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(1) + 'GB';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'MB';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'KB';
    return Math.round(v) + 'B';
  }
  // chart-domain magnitude in the profile's time unit (non-time units → count)
  _fmtTime(v) {
    const f = TIME_TO_SEC[this.p.capabilities.timeUnit];
    if (f == null) { const u = this.p.capabilities.timeUnit; return this._fmtCount(v) + (u && u !== 'none' ? ' ' + u : ''); }
    return this._fmtSeconds(v * f);
  }
  // a weight value in the units implied by the selected weight type's name
  _fmtWeight(v) {
    const wt = (this.weightType || '').toLowerCase();
    if (/nanos|nanosecond/.test(wt)) return this._fmtSeconds(v * 1e-9);
    if (/microsecond/.test(wt)) return this._fmtSeconds(v * 1e-6);
    if (/millisecond/.test(wt)) return this._fmtSeconds(v * 1e-3);
    if (/\bseconds?\b/.test(wt)) return this._fmtSeconds(v);
    if (/bytes/.test(wt)) return this._fmtBytes(v);
    return this._fmtCount(v) + ' ' + (this.weightType || 'samples');
  }
  totalLabel() { return this._fmtWeight(this.ct.grandTotal); }

  // Mode-aware color legend: package swatches normally; the Δ scale in diff.
  _updateLegend() {
    const el = document.getElementById('legend');
    if (!el) return;
    const chip = (c) => `<span style="display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:middle;margin-right:5px;background:${c}"></span>`;
    if (this.mode === 'diff') {
      const stops = [-1, -0.6, 0, 0.6, 1].map((t) => chip(colorForDelta(t * this.diffMax, this.diffMax))).join('');
      const pct = (this.diffMax * 100).toFixed(this.diffMax < 0.01 ? 2 : 1); // max |Δ share| across frames
      el.innerHTML = `<span style="color:${this.T.dim};margin-right:6px">Δ vs baseline</span>`
        + `<span style="color:${this.T.deltaNeg};margin-right:6px">−${pct}%</span>${stops}`
        + `<span style="color:${this.T.deltaPos}">+${pct}%</span>`;
      return;
    }
    const byPkg = new Map();
    for (let i = 0; i < this.ct.func.length; i++) {
      const pkg = packageOf(funcName(this.p, this.ct.func[i]), funcFile(this.p, this.ct.func[i]));
      byPkg.set(pkg, (byPkg.get(pkg) || 0) + this.ct.self[i]);
    }
    const top = [...byPkg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    el.innerHTML = `<span style="color:${this.T.dim};margin-right:6px">color = module</span>` +
      top.map(([pkg]) => `<span style="margin-right:14px;white-space:nowrap;color:${this.T.fg}">${chip(colorForPackage(pkg))}${this._esc(pkg)}</span>`).join('');
  }
  // All-Instances aggregate for a function: self = Σ self of its nodes; total = time where
  // the function is anywhere on the stack (recursion counted once).
  _funcAggregate(f) {
    const ct = this.ct, n = ct.func.length, contains = new Uint8Array(n);
    let self = 0, total = 0;
    for (let i = 0; i < n; i++) {
      const pf = ct.prefix[i];
      contains[i] = (ct.func[i] === f || (pf >= 0 && contains[pf])) ? 1 : 0;
      if (ct.func[i] === f) self += ct.self[i];
      if (contains[i]) total += ct.self[i];
    }
    return { self, total };
  }
  _updateDetail(box) {
    const el = document.getElementById('detail');
    if (!el) return;
    this._selBox = box || null; // remembered so a theme swap can recolor the panel in place
    if (!box) { el.innerHTML = `<span style="color:${this.T.faint}">click a frame for details</span>`; return; }
    const f = box.func, name = funcName(this.p, f), gt = this.ct.grandTotal || 1;
    const chip = (c) => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:middle;background:${c}"></span>`;
    const pct = (v) => `${(100 * v / gt).toFixed(1)}%`;
    const fileI = this.p.funcTable.file[f], file = fileI >= 0 ? (this.p.stringTable[fileI] || '') : '';
    const row = (ff) => `<div style="white-space:nowrap">${chip(colorForFunc(this.p, ff))}${this._esc(funcName(this.p, ff))}</div>`;

    // This Instance — per mode (chart boxes are time spans, not call-nodes)
    let tiHtml;
    if (this.mode === 'chart' && this.chart) {
      const span = (this.chart.end - this.chart.start) || 1, dur = box.t1 - box.t0;
      tiHtml = `${(100 * dur / span).toFixed(1)}% of view<br>${this._fmtTime(dur)}`;
    } else if (this.mode === 'diff') {
      const d = (box.delta || 0) * 100;
      tiHtml = `Δ ${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
    } else {
      const tot = (this.mode === 'graph' && box.node != null) ? this.ct.total[box.node] : box.total;
      const slf = (this.mode === 'graph' && box.node != null) ? this.ct.self[box.node] : (box.self != null ? box.self : box.total);
      tiHtml = `total ${pct(tot)}<br>self ${pct(slf)}`;
    }

    // All Instances — function aggregate over the call-node table (graph/chart/sandwich)
    let aiHtml = '';
    if (this.mode !== 'diff') { const agg = this._funcAggregate(f); aiHtml = `total ${pct(agg.total)}<br>self ${pct(agg.self)}`; }

    // Stack trace (leaf → root). Graph walks the call-node prefix chain; chart reconstructs
    // from ancestor boxes at the clicked time; sandwich walks the local caller/callee table.
    let stack = '';
    if (this.mode === 'graph' && box.node != null) {
      const rows = []; let nn = box.node;
      while (nn >= 0) { rows.push(row(this.ct.func[nn])); nn = this.ct.prefix[nn]; }
      stack = rows.join('');
    } else if (this.mode === 'chart' && this.boxes) {
      const cx = box.x + box.w / 2, rows = [];
      for (let d = box.depth; d >= 0; d--) { const anc = this.boxes.find((bb) => bb.depth === d && cx >= bb.x && cx < bb.x + bb.w); if (anc) rows.push(row(anc.func)); }
      stack = rows.join('');
    } else if (this.mode === 'sandwich' && box.node != null && this.sandwich) {
      // Sandwich boxes index into the local caller/callee table (not this.ct).
      // Determine which side, walk prefix root→leaf so the focal function appears at the top.
      const isCaller = this.callerBoxes && this.callerBoxes.includes(box);
      const table = isCaller ? this.sandwich.callers : this.sandwich.callees;
      const rows = []; let nn = box.node;
      while (nn >= 0) { rows.push(row(table.func[nn])); nn = table.prefix[nn]; }
      rows.reverse();
      stack = rows.join('');
    }
    el.innerHTML =
      `<div class="dcol"><div class="dh">This Instance</div>${tiHtml}</div>` +
      (aiHtml ? `<div class="dcol"><div class="dh">All Instances</div>${aiHtml}</div>` : '') +
      `<div class="dcol dstack"><div class="dh">${this._esc(name)}${file ? ` <span style="color:${this.T.faint}">(${this._esc(file)})</span>` : ''}</div>${stack}</div>`;
  }
  _tooltip(b, e) {
    const tt = document.getElementById('tt');
    if (!tt) return;
    if (!b) { tt.style.display = 'none'; return; }
    const name = this._esc(funcName(this.p, b.func)); // names can contain <,>,& (<init>, vector<int>, …)
    if (this.mode === 'chart') tt.innerHTML = `<b>${name}</b><br>${this._fmtTime(b.t1 - b.t0)}`;
    else if (this.mode === 'diff') { const d = (b.delta || 0) * 100; tt.innerHTML = `<b>${name}</b><br>Δ ${d >= 0 ? '+' : ''}${d.toFixed(1)}%`; }
    else if (this.mode === 'sandwich') tt.innerHTML = `<b>${name}</b><br>${(100 * b.total / this.focalTotal).toFixed(1)}% of focal`;
    else {
      let s = `<b>${name}</b><br>total ${(100 * b.total / this.ct.grandTotal).toFixed(1)}% &middot; self ${(100 * b.self / this.ct.grandTotal).toFixed(1)}%`;
      if (b.collapsed > 0) s += `<br><span style="color:${this.T.dim}">${b.collapsed} folded: ${this._chainNames(b.node, b.tail).map((x) => this._esc(x)).join(' → ')}</span>`;
      tt.innerHTML = s;
    }
    if (!this._zoomLearned()) tt.innerHTML += `<br><span style="color:${this.T.faint};font-size:10px">double-click ▸ zoom</span>`;
    tt.style.display = 'block'; tt.style.left = (e.clientX + 12) + 'px'; tt.style.top = (e.clientY + 14) + 'px';
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────
// FlameView — the rectangular icicle/flame renderer. Geometry + paint + hit-testing +
// interaction (minimap crop, vertical scroll, ⌘-zoom, crosshair, axis). Extends BaseView.
// ──────────────────────────────────────────────────────────────────────────────────────
export class FlameView extends BaseView {
  constructor(canvas, profile, weightType, mode, opts) {
    super(canvas, profile, weightType, mode, opts);
    this.dpr = window.devicePixelRatio || 1;
    this._raf = 0;
    // Bound handlers kept for removal — a new view reuses the same <canvas>, so old listeners
    // must be disposed (see dispose()) or they accumulate and fight over state.
    this._on = {
      move: (e) => this._onMove(e),
      leave: () => { this.hover = null; this.hoverV = null; this._tooltip(null); this._schedule(); },
      down: (e) => this._onDown(e),
      click: (e) => this._onClick(e),
      dbl: (e) => this._onDblClick(e),
      wheel: (e) => this._onWheel(e),
      resize: () => this.relayout(),
    };
    canvas.addEventListener('mousemove', this._on.move);
    canvas.addEventListener('mouseleave', this._on.leave);
    canvas.addEventListener('mousedown', this._on.down);
    canvas.addEventListener('click', this._on.click);
    canvas.addEventListener('dblclick', this._on.dbl);
    canvas.addEventListener('wheel', this._on.wheel, { passive: false });
    window.addEventListener('resize', this._on.resize);
    this.relayout();
    this._updateLegend();
  }

  dispose() { // remove listeners so a replacement view on the same canvas doesn't double up
    const c = this.canvas, h = this._on;
    c.removeEventListener('mousemove', h.move); c.removeEventListener('mouseleave', h.leave);
    c.removeEventListener('mousedown', h.down); c.removeEventListener('click', h.click);
    c.removeEventListener('dblclick', h.dbl); c.removeEventListener('wheel', h.wheel);
    window.removeEventListener('resize', h.resize);
    if (this._mmMove) { window.removeEventListener('mousemove', this._mmMove); window.removeEventListener('mouseup', this._mmUp); }
  }

  _hasMinimap() { return !!((this.mode === 'chart' && this.chart) || this.mode === 'graph' || this.mode === 'diff'); }
  _winBounds() { return this.win ? this.win : [this.domStart, this.domEnd]; }
  // vertical extent of the viewport rect on the minimap (full strip unless content overflows)
  _miniVY() {
    if (!(this.maxScrollY > 0)) return [0, MINIMAP_H];
    return [(this.scrollY / this.contentFullH) * MINIMAP_H, ((this.scrollY + this.viewH) / this.contentFullH) * MINIMAP_H];
  }

  // Size the content viewport so the canvas fills the stage; taller content scrolls internally
  // (scrollY). `top` is the chrome above the content (minimap + axis for chart/graph, 0 for sandwich).
  _sizeContent(fullH, top) {
    const reserve = 8; // full-bleed: the top strip is already in offsetTop; just a small bottom margin
    const avail = (window.innerHeight || 800) - (this.canvas.offsetTop || 0) - reserve - top;
    this.contentFullH = fullH;
    this.viewH = Math.max(ROW * 2, avail); // full-bleed: fill the stage; shallow content leaves space below
    this.maxScrollY = Math.max(0, fullH - this.viewH);
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScrollY));
    this.cssH = top + this.viewH + 1;
  }

  relayout() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth || 1000;
    this.cssW = w;
    this.contentTop = 0;
    this.maxScrollY = 0;
    if (this.mode === 'sandwich' && this.sandwich) {
      this.callerBoxes = layout(this.sandwich.callers, { width: w, minWidth: 0.5 });
      this.calleeBoxes = layout(this.sandwich.callees, { width: w, minWidth: 0.5 });
      this.callerMaxDepth = maxDepthOf(this.callerBoxes);
      this.calleeMaxDepth = maxDepthOf(this.calleeBoxes);
      this.callerTop = 0; this.bandY = (this.callerMaxDepth + 1) * ROW; this.calleeTop = this.bandY + BAND;
      this.focalTotal = this.sandwich.callees.grandTotal || 1;
      this._sizeContent(this.calleeTop + (this.calleeMaxDepth + 1) * ROW, 0);
    } else if (this.mode === 'chart' && this.chart) {
      this.contentTop = MINIMAP_H + AXIS_H;
      this.domStart = this.chart.start; this.domEnd = this.chart.end;
      const [ws, we] = this._winBounds();
      this.boxes = chartLayout(this.chart, this.p, { width: w, minWidth: 0.5, winStart: ws, winEnd: we });
      this.miniBoxes = chartLayout(this.chart, this.p, { width: w, minWidth: 0.5, winStart: this.chart.start, winEnd: this.chart.end });
      this.miniMaxDepth = maxDepthOf(this.miniBoxes);
      this._sizeContent((maxDepthOf(this.boxes) + 1) * ROW, MINIMAP_H + AXIS_H);
    } else if (this.mode === 'diff') { // same machinery as graph, delta-colored
      this.contentTop = MINIMAP_H + AXIS_H;
      this.domStart = 0; this.domEnd = 1;
      const focus = this.focus == null ? undefined : this.focus;
      this.boxes = layout(this.ct, { width: w, minWidth: 0.5, focus, winFrac: this.win || undefined });
      this.miniBoxes = layout(this.ct, { width: w, minWidth: 0.5, focus });
      this.miniMaxDepth = maxDepthOf(this.miniBoxes);
      this._sizeContent((maxDepthOf(this.boxes) + 1) * ROW, MINIMAP_H + AXIS_H);
    } else { // graph (Aggregated) — with aggregated overview minimap (fraction domain)
      this.contentTop = MINIMAP_H + AXIS_H;
      this.domStart = 0; this.domEnd = 1;
      const focus = this.focus == null ? undefined : this.focus;
      this.boxes = layout(this.ct, { width: w, minWidth: 0.5, collapse: this.collapse, focus, winFrac: this.win || undefined });
      this.miniBoxes = layout(this.ct, { width: w, minWidth: 0.5, collapse: this.collapse, focus });
      this.miniMaxDepth = maxDepthOf(this.miniBoxes);
      this._sizeContent((maxDepthOf(this.boxes) + 1) * ROW, MINIMAP_H + AXIS_H);
    }
    this.canvas.style.height = this.cssH + 'px';
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(this.cssH * this.dpr);
    this._schedule();
  }

  _hit(px, py) {
    if (this.mode === 'sandwich') {
      const yy = py + this.scrollY;
      if (yy >= this.callerTop && yy < this.bandY) { const d = this.callerMaxDepth - Math.floor((yy - this.callerTop) / ROW); for (const b of this.callerBoxes) if (b.depth === d && px >= b.x && px < b.x + b.w) return b; }
      else if (yy >= this.calleeTop) { const d = Math.floor((yy - this.calleeTop) / ROW); for (const b of this.calleeBoxes) if (b.depth === d && px >= b.x && px < b.x + b.w) return b; }
      return null;
    }
    const depth = Math.floor((py - this.contentTop + this.scrollY) / ROW);
    if (depth < 0) return null;
    for (const b of this.boxes) if (b.depth === depth && px >= b.x && px < b.x + b.w) return b;
    return null;
  }

  // ---- minimap interaction (chart: time domain · graph: value-fraction domain) ----
  _miniX(v) { return (v - this.domStart) / (this.domEnd - this.domStart) * this.cssW; }
  _miniT(px) { return this.domStart + (px / this.cssW) * (this.domEnd - this.domStart); }
  _onDown(e) {
    const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    // scrollbar thumb (works in every contained-scroll mode, incl. sandwich)
    if (this.maxScrollY > 0 && px >= this.cssW - SCROLLBAR_W && py >= this.contentTop) {
      e.preventDefault();
      this.barDrag = { startPy: py, startScrollY: this.scrollY, range: this._thumb().range };
      this._mmMove = (ev) => this._onBarMove(ev); this._mmUp = () => this._onBarUp();
      window.addEventListener('mousemove', this._mmMove); window.addEventListener('mouseup', this._mmUp);
      return;
    }
    if (!this._hasMinimap() || py >= MINIMAP_H) return;
    e.preventDefault();
    const [ws, we] = this._winBounds();
    const x0 = this._miniX(ws), x1 = this._miniX(we), vAt = this._miniT(px);
    const [vy0, vy1] = this._miniVY();
    // "Move" (pan the viewport in time and/or depth) when you grab inside the viewport rect
    // AND there is something to pan — a horizontal crop or vertical overflow. Otherwise a
    // drag DRAWS a new horizontal window (so the first crop is reachable from zoomed-out).
    const canMove = !!this.win || this.maxScrollY > 0;
    const insideCrop = canMove && px >= x0 && px <= x1 && py >= vy0 && py <= vy1;
    this.miniDrag = insideCrop
      ? { mode: 'move', offset: vAt - ws, wdt: we - ws, startPy: py, startScrollY: this.scrollY }
      : { mode: 'draw', startV: vAt };
    this._mmMove = (ev) => this._onMiniMove(ev); this._mmUp = () => this._onMiniUp();
    window.addEventListener('mousemove', this._mmMove); window.addEventListener('mouseup', this._mmUp);
  }
  _onMiniMove(ev) {
    const r = this.canvas.getBoundingClientRect();
    const v = Math.max(this.domStart, Math.min(this.domEnd, this._miniT(ev.clientX - r.left)));
    const d = this.miniDrag;
    if (d.mode === 'move') {
      if (this.win) { const v0 = Math.max(this.domStart, Math.min(this.domEnd - d.wdt, v - d.offset)); this.win = [v0, v0 + d.wdt]; }
      if (this.maxScrollY > 0) { const dScroll = ((ev.clientY - r.top) - d.startPy) / MINIMAP_H * this.contentFullH; this.scrollY = Math.max(0, Math.min(this.maxScrollY, d.startScrollY + dScroll)); }
    } else { this.win = [Math.min(d.startV, v), Math.max(d.startV, v)]; }
    this.relayout();
  }
  _onMiniUp() {
    if (this.miniDrag && this.miniDrag.mode === 'draw' && this.win && (this.win[1] - this.win[0]) < (this.domEnd - this.domStart) * 0.004) { this.win = null; this.relayout(); }
    this.miniDrag = null;
    window.removeEventListener('mousemove', this._mmMove); window.removeEventListener('mouseup', this._mmUp);
  }
  _onBarMove(ev) {
    const dy = (ev.clientY - this.canvas.getBoundingClientRect().top) - this.barDrag.startPy;
    this.scrollY = Math.max(0, Math.min(this.maxScrollY, this.barDrag.startScrollY + dy / this.barDrag.range * this.maxScrollY));
    this._schedule();
  }
  _onBarUp() { this.barDrag = null; window.removeEventListener('mousemove', this._mmMove); window.removeEventListener('mouseup', this._mmUp); }
  _onWheel(e) {
    // ⌘/Ctrl + wheel (or pinch, reported as ctrl+wheel) → zoom about the cursor.
    if ((e.ctrlKey || e.metaKey) && this._hasMinimap()) {
      e.preventDefault();
      this._zoomAt(e.clientX - this.canvas.getBoundingClientRect().left, Math.pow(1.0018, e.deltaY));
      return;
    }
    // Horizontal intent (trackpad deltaX, or Shift+wheel) → pan the crop left/right.
    const dx = e.shiftKey ? e.deltaY : (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0);
    if (dx && this._hasMinimap() && this.win) { e.preventDefault(); this._panX(dx); return; }
    // Otherwise vertical scroll through stack depth (not over the minimap strip).
    if (this.maxScrollY <= 0) return;
    if (this._hasMinimap() && (e.clientY - this.canvas.getBoundingClientRect().top) < this.contentTop) return;
    e.preventDefault();
    this.scrollY = Math.max(0, Math.min(this.maxScrollY, this.scrollY + e.deltaY));
    this._schedule();
  }
  _panX(dx) { // shift the crop window by dx content-pixels, clamped to the domain
    const [ws, we] = this._winBounds(), wd = we - ws;
    let ns = ws + (dx / this.cssW) * wd, ne = ns + wd;
    if (ns < this.domStart) { ns = this.domStart; ne = ns + wd; }
    if (ne > this.domEnd) { ne = this.domEnd; ns = ne - wd; }
    this.win = [ns, ne];
    this.relayout();
  }
  _zoomAt(px, mult) { // mult > 1 widens (zoom out), < 1 narrows (zoom in); keeps cursor value fixed
    const [ws, we] = this._winBounds(), width = we - ws, full = this.domEnd - this.domStart;
    const v = ws + (px / this.cssW) * width;
    const newW = Math.min(full, Math.max(full * 1e-4, width * mult));
    let ns = v - (px / this.cssW) * newW, ne = ns + newW;
    if (ns < this.domStart) { ns = this.domStart; ne = ns + newW; }
    if (ne > this.domEnd) { ne = this.domEnd; ns = ne - newW; }
    this.win = (ns <= this.domStart && ne >= this.domEnd) ? null : [ns, ne];
    this.relayout();
  }

  _onMove(e) {
    const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    if (this.maxScrollY > 0 && px >= this.cssW - SCROLLBAR_W && py >= this.contentTop) {
      this.canvas.style.cursor = 'default'; this.hover = null; this.hoverV = null; this._tooltip(null); this._schedule(); return;
    }
    if (this._hasMinimap() && py < MINIMAP_H) {
      this.hover = null; this._tooltip(null);
      this.hoverV = this._miniT(px); // crosshair from the overview → main view
      const [ws, we] = this._winBounds(), [vy0, vy1] = this._miniVY();
      const insideCrop = (!!this.win || this.maxScrollY > 0) && px >= this._miniX(ws) && px <= this._miniX(we) && py >= vy0 && py <= vy1;
      this.canvas.style.cursor = insideCrop ? 'grab' : 'col-resize';
      this._schedule(); return;
    }
    this.canvas.style.cursor = 'default';
    this.hover = this._hit(px, py);
    if (this._hasMinimap()) { const [ws, we] = this._winBounds(); this.hoverV = ws + (px / this.cssW) * (we - ws); } // → overview crosshair
    this._schedule(); this._tooltip(this.hover, e);
  }
  _onClick(e) { // single click = select → detail panel
    const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    if (this._hasMinimap() && py < MINIMAP_H) return;
    const b = this._hit(px, py);
    this.selectedFunc = b ? b.func : null;
    this.selectedNode = (b && b.node != null) ? b.node : null;
    this._updateDetail(b);
    if (this._opts.onSelect) this._opts.onSelect(b || null); // shell shows/hides the slide-over
    this._schedule();
  }
  // zoom into a box: re-center (sandwich) / crop time (chart) / focus subtree (graph/diff).
  // box=null means "zoom out". Shared by double-click and the context menu's Focus action.
  focusBox(b) {
    if (this.mode === 'sandwich') { if (b) this.focalFunc = b.func; this._buildSandwich(); }
    else if (this.mode === 'chart') { this.win = b ? [b.t0, b.t1] : null; }
    else { this.focus = b ? b.node : null; this.win = null; } // focus changes the layout → reset the crop
    this.scrollY = 0; // re-show from the top after a zoom/crop
    this.relayout();
  }
  _onDblClick(e) { // double click = zoom (graph) / crop (chart) / re-center (sandwich)
    const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    if (this._hasMinimap() && py < MINIMAP_H) return;
    this._markZoomed();
    this.focusBox(this._hit(px, py));
  }

  _paintList(boxes, yTop, flip, maxDepth) {
    const ctx = this.ctx;
    for (const b of boxes) {
      const lit = this._lit(b);
      const w = Math.max(0, b.w - 1), y = yTop + (flip ? (maxDepth - b.depth) : b.depth) * ROW, badge = b.collapsed > 0 && w > 44;
      const fill = this.mode === 'diff' ? colorForDelta(b.delta || 0, this.diffMax) : colorForFunc(this.p, b.func);
      ctx.globalAlpha = lit ? 1 : 0.32; ctx.fillStyle = fill; ctx.fillRect(b.x, y, w, ROW - 1);
      const lab = fitLabel(funcName(this.p, b.func), w - (badge ? 24 : 0));
      const tx = this._textOn(fill);
      if (lab) { ctx.globalAlpha = lit ? 1 : 0.5; ctx.fillStyle = tx; ctx.fillText(lab, b.x + 4, y + (ROW - 1) / 2); }
      if (badge) { const bw = 20; ctx.globalAlpha = lit ? 0.18 : 0.08; ctx.fillStyle = tx; ctx.fillRect(b.x + w - bw - 3, y + 4, bw, ROW - 1 - 8); ctx.globalAlpha = lit ? 1 : 0.4; ctx.fillStyle = tx; ctx.fillText('+' + b.collapsed, b.x + w - bw + 1, y + (ROW - 1) / 2); }
      if (this.selectedFunc != null && b.func === this.selectedFunc && w > 2) { ctx.globalAlpha = 1; ctx.strokeStyle = this.T.sel; ctx.lineWidth = 1; ctx.strokeRect(b.x + 0.5, y + 0.5, w - 1, ROW - 2); }
    }
  }

  _drawMinimap() {
    const ctx = this.ctx, w = this.cssW;
    ctx.fillStyle = this.T.bg2; ctx.fillRect(0, 0, w, MINIMAP_H);
    const rowH = (MINIMAP_H - 4) / (this.miniMaxDepth + 1);
    ctx.globalAlpha = 0.85;
    for (const b of this.miniBoxes) { ctx.fillStyle = this.mode === 'diff' ? colorForDelta(b.delta || 0, this.diffMax) : colorForFunc(this.p, b.func); ctx.fillRect(b.x, 2 + b.depth * rowH, Math.max(0.5, b.w - 0.5), Math.max(1, rowH - 0.5)); }
    ctx.globalAlpha = 1;
    const [ws, we] = this._winBounds(); const x0 = this._miniX(ws), x1 = this._miniX(we);
    const [vy0, vy1] = this._miniVY(), vh = vy1 - vy0;
    ctx.fillStyle = this.T.accent; ctx.globalAlpha = 0.16; ctx.fillRect(x0, vy0, x1 - x0, vh); ctx.globalAlpha = 1;
    ctx.strokeStyle = this.T.accent; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, vy0 + 0.5, (x1 - x0) - 1, vh - 1);
    ctx.fillStyle = this.T.accent; ctx.fillRect(x0 - 1, vy0, 2, vh); ctx.fillRect(x1 - 1, vy0, 2, vh);
    ctx.strokeStyle = this.T.line; ctx.beginPath(); ctx.moveTo(0, MINIMAP_H - 0.5); ctx.lineTo(w, MINIMAP_H - 0.5); ctx.stroke();
  }

  // Right-edge scrollbar thumb for any contained-scroll mode (the only vertical-position cue
  // in sandwich, which has no minimap). Standard mapping: thumb fills proportionally.
  _thumb() {
    const h = Math.max(24, this.viewH * (this.viewH / this.contentFullH));
    const range = Math.max(1, this.viewH - h);
    return { h, range, y: this.contentTop + (this.scrollY / this.maxScrollY) * range };
  }
  _drawScrollbar() {
    if (!(this.maxScrollY > 0)) return;
    const ctx = this.ctx, t = this._thumb();
    ctx.fillStyle = this.barDrag ? 'rgba(139,148,158,0.8)' : 'rgba(139,148,158,0.4)';
    ctx.fillRect(this.cssW - 7, t.y, 5, t.h);
  }

  // x-axis ruler between the minimap and the content: elapsed time (chart) or % of total
  // (graph), with ticks pointing down toward the data. Matches speedscope's placement.
  _drawAxis() {
    const ctx = this.ctx, w = this.cssW, y0 = this.contentTop - AXIS_H;
    ctx.fillStyle = this.T.bg; ctx.fillRect(0, y0, w, AXIS_H);
    ctx.strokeStyle = this.T.line; ctx.beginPath(); ctx.moveTo(0, this.contentTop - 0.5); ctx.lineTo(w, this.contentTop - 0.5); ctx.stroke();
    ctx.font = '10px Menlo, Consolas, monospace'; ctx.textBaseline = 'middle';
    const [ws, we] = this._winBounds(), isChart = this.mode === 'chart';
    const N = Math.max(2, Math.min(8, Math.floor(w / 120))), ty = y0 + AXIS_H / 2, CW = 6;
    for (let i = 0; i <= N; i++) {
      const f = i / N, x = f * w, v = ws + f * (we - ws);
      const label = isChart ? this._fmtTime(v - this.chart.start) : (v * 100).toFixed(v * 100 < 10 && v > 0 ? 1 : 0) + '%';
      ctx.strokeStyle = this.T.line; ctx.beginPath(); ctx.moveTo(x + 0.5, this.contentTop - 4); ctx.lineTo(x + 0.5, this.contentTop); ctx.stroke();
      const tx = i === 0 ? x + 3 : i === N ? x - 3 - label.length * CW : x - (label.length * CW) / 2;
      ctx.fillStyle = this.T.dim; ctx.fillText(label, tx, ty);
    }
  }

  // Synced crosshair: a vertical line on the minimap at the hovered domain value, plus the
  // matching line on the main content when that value is inside the current window.
  _drawCrosshair() {
    if (this.hoverV == null) return;
    const ctx = this.ctx;
    ctx.strokeStyle = this._rgba(this.T.fg, 0.45); ctx.lineWidth = 1;
    const mx = Math.round(this._miniX(this.hoverV)) + 0.5;
    ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, MINIMAP_H); ctx.stroke();
    const [ws, we] = this._winBounds();
    if (this.hoverV >= ws && this.hoverV <= we && we > ws) {
      const cx = Math.round((this.hoverV - ws) / (we - ws) * this.cssW) + 0.5;
      ctx.beginPath(); ctx.moveTo(cx, this.contentTop); ctx.lineTo(cx, this.contentTop + this.viewH); ctx.stroke();
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.save(); ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = this.T.bg; ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.font = '11px Menlo, Consolas, monospace'; ctx.textBaseline = 'middle';
    if (this.mode === 'sandwich' && this.sandwich) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, this.cssW, this.viewH); ctx.clip();
      ctx.translate(0, -this.scrollY);
      this._paintList(this.callerBoxes, this.callerTop, true, this.callerMaxDepth);
      ctx.globalAlpha = 0.18; ctx.fillStyle = this.T.accent; ctx.fillRect(0, this.bandY, this.cssW, BAND);
      ctx.globalAlpha = 1; ctx.fillStyle = this.T.fg; ctx.fillText('▸ ' + funcName(this.p, this.sandwich.focalFunc) + '   (callers ↑ · callees ↓)', 6, this.bandY + BAND / 2);
      this._paintList(this.calleeBoxes, this.calleeTop, false, this.calleeMaxDepth);
      ctx.restore();
    } else if (this._hasMinimap()) {
      this._drawMinimap();
      ctx.save();
      ctx.beginPath(); ctx.rect(0, this.contentTop, this.cssW, this.viewH); ctx.clip();
      ctx.translate(0, -this.scrollY);
      this._paintList(this.boxes, this.contentTop, false, 0);
      ctx.restore();
      this._drawCrosshair();
      this._drawAxis();
    } else { // no minimap fallback
      this._paintList(this.boxes, this.contentTop, false, 0);
    }
    this._drawScrollbar();
    ctx.globalAlpha = 1; ctx.restore();
  }
}
FlameView.capabilities = { modes: ['graph', 'chart', 'sandwich'], minimap: true };
