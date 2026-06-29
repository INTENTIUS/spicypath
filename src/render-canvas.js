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
import { aggregateWindow } from './metrics-window.js'; // FG-025 pass 3

const ROW = 22;
const BAND = 22;
const MINIMAP_H = 52;
const SCROLLBAR_W = 12; // right-edge hit zone for the vertical scrollbar thumb
const AXIS_H = 18;      // x-axis ruler height (time for chart, %-of-total for graph)
const METRIC_LANE_H = 52; // height of each metric track lane (chart mode only, FG-025 pass 1)
const METRIC_LABEL_W = 54; // px reserved on the left for the series name+unit label
const TIME_TO_SEC = { nanoseconds: 1e-9, microseconds: 1e-6, milliseconds: 1e-3, seconds: 1 };
const maxDepthOf = (bs) => { let m = 0; for (const b of bs) if (b.depth > m) m = b.depth; return m; };

// ──────────────────────────────────────────────────────────────────────────────────────
// BaseView — the shared, view-type-agnostic context. A concrete view extends this and adds
// geometry: relayout(), draw(), _hit(px,py), and interaction. The base supplies everything
// else (data, state, colors, legend/detail/tooltip, search, mode actions). It calls
// this.relayout()/this._updateLegend() (supplied by the subclass) from the mode actions.
// ──────────────────────────────────────────────────────────────────────────────────────
export class BaseView {
  // FG-053: opts may include { onSelect, thread } where thread is a Thread object or numeric
  // index. A Thread object (e.g. mergedThread result) is used directly; a number indexes
  // profile.threads. Defaults to 0 (prior behavior when thread is absent).
  constructor(canvas, profile, weightType, mode, opts) {
    this._opts = opts || {}; // { onSelect(box|null), thread } — shell hook for the detail slide-over
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.p = profile;
    this.weightType = weightType;
    this.mode = mode || 'graph';
    // FG-053: resolve the active thread — object (merged/per-thread) or numeric index (default 0)
    const threadArg = (opts && opts.thread != null) ? opts.thread : 0;
    this._activeThread = threadArg; // stored for _applyBrush and future seams
    this.ct = buildCallNodeTable(profile, threadArg, weightType);
    this.chart = profile.capabilities.hasTiming ? buildFlameChart(profile, threadArg) : null;
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
    this.hoverTime = null;    // time value when hovering a metric lane (FG-025 pass 2); null otherwise
    this.brush = null;        // FG-025 pass 3: active time-range brush [tb0, tb1] or null
    this.brushFuncs = null;   // FG-025 pass 3: Set of func indices lit by the brush, or null
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
  setMode(m) { this.mode = m; this.focus = null; this.win = null; this.scrollY = 0; this.hover = null; this.hoverV = null; this.hoverTime = null; this._clearBrush(); if (m === 'sandwich') { this.focalFunc = this._defaultFocal(); this._buildSandwich(); } this.relayout(); this._updateLegend(); }
  setCollapse(b) { this.collapse = b; this.relayout(); }
  resetZoom() { this.focus = null; this.win = null; this.scrollY = 0; this.hoverTime = null; if (this.mode === 'sandwich') { this.focalFunc = this._defaultFocal(); this._buildSandwich(); } this.relayout(); }
  // Enter diff. Clears search too: matchedFuncs are func indices in the ORIGINAL profile, but
  // diff swaps this.p/this.ct to the synthetic diff profile (different indexing) — a stale
  // search would highlight the wrong frames.
  showDiff(d) { this.mode = 'diff'; this.ct = d.ct; this.p = d.profile; this.diffMax = d.maxAbsDelta; this.focus = null; this.win = null; this.scrollY = 0; this.hover = null; this.hoverTime = null; this.selectedFunc = null; this.query = ''; this.matchedFuncs = null; this._clearBrush(); this.relayout(); this._updateLegend(); }
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

  // is a box "lit" (full opacity)? search match, hover call-path, lane-hover time span, or no filter active
  _lit(b) {
    if (this.matchedFuncs) return this.matchedFuncs.has(b.func);
    // FG-025 pass 3: brush filter — chart-only, gated when brushFuncs is set and no search is active
    if (this.brushFuncs && this.mode === 'chart') return this.brushFuncs.has(b.func);
    // lane hover (FG-025 pass 2): box is lit iff its time span contains the hovered time
    if (this.hoverTime != null) return b.t0 <= this.hoverTime && this.hoverTime < b.t1;
    if (!this.hover) return true;
    if (this.mode === 'graph' || this.mode === 'diff') return this._ancestors(this.hover.node).has(b.node) || this._isDesc(b.node, this.hover.node);
    return b.func === this.hover.func;
  }

  // FG-025 pass 3: clear the brush and its derived state; update the overlay.
  _clearBrush() {
    this.brush = null;
    this.brushFuncs = null;
    const el = typeof document !== 'undefined' ? document.getElementById('brushinfo') : null;
    if (el) { el.style.display = 'none'; el.textContent = ''; }
  }

  // FG-025 pass 3: set brush to [tb0, tb1], compute windowed aggregation, update overlay.
  // TODO FG-025: deferred to a later pass — a separate graph-mode weight selector, and full
  // per-frame correlation-coefficient coloring. The top-K brush highlight below is the
  // correlation signal for this pass.
  _applyBrush(tb0, tb1) {
    this.brush = [tb0, tb1];
    // aggregate the window and build the brushFuncs set
    // FG-053: use the active thread (merged or per-thread) for the brush window aggregation.
    // aggregateWindow accepts a numeric threadIndex; for a merged/synthetic thread object,
    // fall back to 0 (the brush is a best-effort highlight, not a correctness invariant).
    const brushTi = (typeof this._activeThread === 'number') ? this._activeThread : 0;
    const result = aggregateWindow(this.p, brushTi, this.weightType, tb0, tb1);
    const TOP_K = 10;
    const top = result.funcs.slice(0, TOP_K);
    this.brushFuncs = new Set(top.map((f) => f.func));
    // populate the #brushinfo overlay
    const el = typeof document !== 'undefined' ? document.getElementById('brushinfo') : null;
    if (el) {
      if (top.length === 0) {
        el.style.display = 'none';
      } else {
        const lines = top.map((f) => {
          const pct = (f.totalFrac * 100).toFixed(1);
          const nm = f.name.length > 32 ? f.name.slice(0, 29) + '…' : f.name;
          return `${pct}% ${nm}`;
        });
        el.textContent = lines.join('  ·  ');
        el.style.display = 'block';
      }
    }
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
    const chip = (c) => `<span class="chip" style="background:${c}"></span>`;
    const pct = (v) => `${(100 * v / gt).toFixed(1)}%`;
    const fileI = this.p.funcTable.file[f], file = fileI >= 0 ? (this.p.stringTable[fileI] || '') : '';
    // FG-050: row helpers emit actionable divs carrying data-node or data-func for click navigation.
    const rowStyle = 'white-space:nowrap;cursor:pointer;border-radius:3px;padding:1px 2px';
    const rowNode = (ff, node) => `<div class="dsr" style="${rowStyle}" data-node="${node}">${chip(colorForFunc(this.p, ff))}${this._esc(funcName(this.p, ff))}</div>`;
    const rowFunc = (ff) => `<div class="dsr" style="${rowStyle}" data-func="${ff}">${chip(colorForFunc(this.p, ff))}${this._esc(funcName(this.p, ff))}</div>`;

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
    // FG-050: each row carries data-node (graph) or data-func (chart/sandwich) for navigation.
    let stack = '';
    if (this.mode === 'graph' && box.node != null) {
      const rows = []; let nn = box.node;
      while (nn >= 0) { rows.push(rowNode(this.ct.func[nn], nn)); nn = this.ct.prefix[nn]; }
      stack = rows.join('');
    } else if (this.mode === 'chart' && this.boxes) {
      const cx = box.x + box.w / 2, rows = [];
      for (let d = box.depth; d >= 0; d--) { const anc = this.boxes.find((bb) => bb.depth === d && cx >= bb.x && cx < bb.x + bb.w); if (anc) rows.push(rowFunc(anc.func)); }
      stack = rows.join('');
    } else if (this.mode === 'sandwich' && box.node != null && this.sandwich) {
      // Sandwich boxes index into the local caller/callee table (not this.ct).
      // Determine which side, walk prefix root→leaf so the focal function appears at the top.
      const isCaller = this.callerBoxes && this.callerBoxes.includes(box);
      const table = isCaller ? this.sandwich.callers : this.sandwich.callees;
      const rows = []; let nn = box.node;
      while (nn >= 0) { rows.push(rowFunc(table.func[nn])); nn = table.prefix[nn]; }
      rows.reverse();
      stack = rows.join('');
    }
    el.innerHTML =
      `<style>.dsr:hover{background:rgba(137,180,250,0.15)}</style>` +
      `<div class="dcol"><div class="dh">This Instance</div>${tiHtml}</div>` +
      (aiHtml ? `<div class="dcol"><div class="dh">All Instances</div>${aiHtml}</div>` : '') +
      `<div class="dcol dstack"><div class="dh">${this._esc(name)}${file ? ` <span style="color:${this.T.faint}">(${this._esc(file)})</span>` : ''}</div>${stack}</div>`;

    // FG-050: wire click handlers on the stack rows for navigation.
    // Plain click → selectNode (if data-node) or selectFunc (if data-func).
    // Alt/Cmd click → focusBox for zoom (modifier click), degrading gracefully if unavailable.
    el.querySelectorAll('.dsr').forEach((div) => {
      div.addEventListener('click', (e) => {
        const nodeAttr = div.dataset.node;
        const funcAttr = div.dataset.func;
        if (nodeAttr != null) {
          const node = +nodeAttr;
          if (e.altKey || e.metaKey) {
            // modifier click: zoom/focus to that ancestor node
            try { if (typeof this.focusBox === 'function') { this.focusBox({ node, func: this.ct.func[node] }); } } catch { /* focus unavailable — degrade silently */ }
          } else {
            this.selectNode(node);
          }
        } else if (funcAttr != null) {
          const fi = +funcAttr;
          // chart/sandwich: no stable node index — both plain and modifier click degrade to selectFunc
          this.selectFunc(fi);
        }
        e.stopPropagation();
      });
    });
  }
  // FG-050: Select a specific call-node by index: set selectedNode + selectedFunc, update the
  // detail panel, fire onSelect, and schedule a redraw. Sibling of selectFunc.
  selectNode(node) {
    this.selectedNode = node;
    this.selectedFunc = this.ct.func[node];
    const box = { func: this.ct.func[node], node, self: this.ct.self[node], total: this.ct.total[node] };
    this._updateDetail(box);
    if (this._opts.onSelect) this._opts.onSelect(box);
    this._schedule();
  }
  // Select a function by index: outline all its instances, pick a representative call-node
  // (the one with the greatest self weight), open the detail slide-over, and fire onSelect.
  selectFunc(f) {
    this.selectedFunc = f;
    // find the representative call-node — highest self weight among nodes for this function
    const ct = this.ct, n = ct.func.length;
    let bestNode = -1, bestSelf = -1;
    for (let i = 0; i < n; i++) {
      if (ct.func[i] === f && ct.self[i] > bestSelf) { bestSelf = ct.self[i]; bestNode = i; }
    }
    this.selectedNode = bestNode >= 0 ? bestNode : null;
    const box = bestNode >= 0 ? { func: f, node: bestNode, self: ct.self[bestNode], total: ct.total[bestNode] } : { func: f };
    this._updateDetail(box);
    if (this._opts.onSelect) this._opts.onSelect(box);
    this._schedule();
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
      leave: () => { this.hover = null; this.hoverV = null; this.hoverTime = null; this._tooltip(null); this._schedule(); },
      down: (e) => this._onDown(e),
      click: (e) => this._onClick(e),
      dbl: (e) => this._onDblClick(e),
      wheel: (e) => this._onWheel(e),
      resize: () => this.relayout(),
      keydown: (e) => { if (e.key === 'Escape' && this.brush) { this._clearBrush(); this._schedule(); } },
    };
    // FG-025 pass 3: brush drag state — separate from _mmMove/_mmUp (which serve minimap)
    this._brushMove = null;
    this._brushUp = null;
    canvas.addEventListener('mousemove', this._on.move);
    canvas.addEventListener('mouseleave', this._on.leave);
    canvas.addEventListener('mousedown', this._on.down);
    canvas.addEventListener('click', this._on.click);
    canvas.addEventListener('dblclick', this._on.dbl);
    canvas.addEventListener('wheel', this._on.wheel, { passive: false });
    window.addEventListener('resize', this._on.resize);
    window.addEventListener('keydown', this._on.keydown); // FG-025 pass 3: Esc clears brush
    this.relayout();
    this._updateLegend();
  }

  dispose() { // remove listeners so a replacement view on the same canvas doesn't double up
    const c = this.canvas, h = this._on;
    c.removeEventListener('mousemove', h.move); c.removeEventListener('mouseleave', h.leave);
    c.removeEventListener('mousedown', h.down); c.removeEventListener('click', h.click);
    c.removeEventListener('dblclick', h.dbl); c.removeEventListener('wheel', h.wheel);
    window.removeEventListener('resize', h.resize);
    window.removeEventListener('keydown', h.keydown); // FG-025 pass 3
    if (this._mmMove) { window.removeEventListener('mousemove', this._mmMove); window.removeEventListener('mouseup', this._mmUp); }
    if (this._brushMove) { window.removeEventListener('mousemove', this._brushMove); window.removeEventListener('mouseup', this._brushUp); } // FG-025 pass 3
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
    this.metricsH = 0; // reset; only chart mode with metrics sets this > 0 (FG-025 pass 1)
    if (this.mode === 'sandwich' && this.sandwich) {
      this.callerBoxes = layout(this.sandwich.callers, { width: w, minWidth: 0.5 });
      this.calleeBoxes = layout(this.sandwich.callees, { width: w, minWidth: 0.5 });
      this.callerMaxDepth = maxDepthOf(this.callerBoxes);
      this.calleeMaxDepth = maxDepthOf(this.calleeBoxes);
      this.callerTop = 0; this.bandY = (this.callerMaxDepth + 1) * ROW; this.calleeTop = this.bandY + BAND;
      this.focalTotal = this.sandwich.callees.grandTotal || 1;
      this._sizeContent(this.calleeTop + (this.calleeMaxDepth + 1) * ROW, 0);
    } else if (this.mode === 'chart' && this.chart) {
      const metrics = (this.p.metrics && this.p.metrics.length) ? this.p.metrics : [];
      this.metricsH = metrics.length * METRIC_LANE_H; // 0 when no metrics (FG-025 pass 1)
      this.contentTop = MINIMAP_H + AXIS_H + this.metricsH;
      this.domStart = this.chart.start; this.domEnd = this.chart.end;
      const [ws, we] = this._winBounds();
      this.boxes = chartLayout(this.chart, this.p, { width: w, minWidth: 0.5, winStart: ws, winEnd: we });
      this.miniBoxes = chartLayout(this.chart, this.p, { width: w, minWidth: 0.5, winStart: this.chart.start, winEnd: this.chart.end });
      this.miniMaxDepth = maxDepthOf(this.miniBoxes);
      this._sizeContent((maxDepthOf(this.boxes) + 1) * ROW, MINIMAP_H + AXIS_H + this.metricsH);
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
    // FG-025 pass 3: brush drag on metric lanes (chart mode only)
    if (this.mode === 'chart' && this.metricsH > 0 && py >= MINIMAP_H && py < MINIMAP_H + this.metricsH) {
      e.preventDefault();
      const [ws, we] = this._winBounds();
      const tAt = ws + (px / this.cssW) * (we - ws);
      this._brushDrag = { startPx: px, startT: tAt };
      this._brushT = tAt; // current drag end
      this._brushMove = (ev) => this._onBrushMove(ev);
      this._brushUp = () => this._onBrushUp();
      window.addEventListener('mousemove', this._brushMove); window.addEventListener('mouseup', this._brushUp);
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
  // FG-025 pass 3: brush drag on metric lanes
  _onBrushMove(ev) {
    const r = this.canvas.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const [ws, we] = this._winBounds();
    this._brushT = ws + (px / this.cssW) * (we - ws);
    this._schedule();
  }
  _onBrushUp() {
    window.removeEventListener('mousemove', this._brushMove); window.removeEventListener('mouseup', this._brushUp);
    this._brushMove = null; this._brushUp = null;
    if (!this._brushDrag) return;
    const { startPx, startT } = this._brushDrag;
    this._brushDrag = null;
    const r = this.canvas.getBoundingClientRect();
    const endT = this._brushT != null ? this._brushT : startT;
    const tb0 = Math.min(startT, endT), tb1 = Math.max(startT, endT);
    const pxSpan = Math.abs((tb1 - tb0) / ((this._winBounds()[1] - this._winBounds()[0]) || 1) * this.cssW);
    if (pxSpan < 5) {
      // tiny drag — clear the brush
      this._clearBrush();
    } else {
      this._applyBrush(tb0, tb1);
    }
    this._brushT = null;
    this._schedule();
  }
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
      this.canvas.style.cursor = 'default'; this.hover = null; this.hoverV = null; this.hoverTime = null; this._tooltip(null); this._schedule(); return;
    }
    if (this._hasMinimap() && py < MINIMAP_H) {
      this.hover = null; this.hoverTime = null; this._tooltip(null);
      this.hoverV = this._miniT(px); // crosshair from the overview → main view
      const [ws, we] = this._winBounds(), [vy0, vy1] = this._miniVY();
      const insideCrop = (!!this.win || this.maxScrollY > 0) && px >= this._miniX(ws) && px <= this._miniX(we) && py >= vy0 && py <= vy1;
      this.canvas.style.cursor = insideCrop ? 'grab' : 'col-resize';
      this._schedule(); return;
    }
    // FG-025 pass 2 + 3: metric lane hover — the band between minimap and axis (chart mode only)
    if (this.mode === 'chart' && this.metricsH > 0 && py >= MINIMAP_H && py < MINIMAP_H + this.metricsH) {
      this.hover = null; this._tooltip(null);
      const [ws, we] = this._winBounds();
      this.hoverTime = ws + (px / this.cssW) * (we - ws); // time at cursor → lights frames
      this.hoverV = this.hoverTime;                        // drives the crosshair on both minimap + content
      this.canvas.style.cursor = 'crosshair';
      this._schedule(); return;
    }
    this.canvas.style.cursor = 'default';
    this.hoverTime = null; // leaving a lane clears the lane hover
    this.hover = this._hit(px, py);
    if (this._hasMinimap()) { const [ws, we] = this._winBounds(); this.hoverV = ws + (px / this.cssW) * (we - ws); } // → overview crosshair
    this._schedule(); this._tooltip(this.hover, e);
  }
  _onClick(e) { // single click = select → detail panel
    const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    if (this._hasMinimap() && py < MINIMAP_H) return;
    // FG-025 pass 3: click in the lane area starts/clears a brush (handled by _onBrushUp),
    // so skip the selection path when in the lane band
    if (this.mode === 'chart' && this.metricsH > 0 && py >= MINIMAP_H && py < MINIMAP_H + this.metricsH) return;
    // FG-025 pass 3: plain click outside the lanes clears any active brush
    if (this.brush) { this._clearBrush(); this._schedule(); }
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

  // Metric track lanes (FG-025 pass 1) — chart mode only, rendered between the axis and the
  // flame content. Each lane shows a filled area plot of value vs time, cropped to the current
  // window ([ws, we]) using the same domStart/domEnd → x mapping as the minimap and axis.
  // Pass 2 adds bidirectional hover: frame→track band (this.hover.t0/t1) and lane→frame
  // highlight (this.hoverTime — lit via _lit()).
  // y of the top of metric lane i (lane 0 abuts the minimap; lane band ends at the axis top,
  // contentTop − AXIS_H). Used by draw + asserted in tests so the lanes never overlap the axis.
  _laneTop(i) { return MINIMAP_H + i * METRIC_LANE_H; }
  _drawMetricLanes() {
    if (!this.metricsH) return;
    const metrics = this.p.metrics;
    if (!metrics || !metrics.length) return;
    const ctx = this.ctx, w = this.cssW;
    const [ws, we] = this._winBounds();
    const domSpan = (we > ws) ? (we - ws) : 1;
    // lane colors — both entries are hex strings so _rgba() works uniformly below
    const laneColors = [this.T.accent, this.T.accent];

    // FG-025 pass 2: frame→track band — when a flame box is hovered, compute its pixel span
    // on the lanes (clamped to the visible window) so the band shows what the metrics were
    // doing during that frame. bandX0/bandX1 = null when no box is hovered.
    let bandX0 = null, bandX1 = null;
    if (this.hover && this.hover.t0 != null && this.hover.t1 != null) {
      const clampedT0 = Math.max(this.hover.t0, ws);
      const clampedT1 = Math.min(this.hover.t1, we);
      if (clampedT1 > clampedT0) {
        bandX0 = (clampedT0 - ws) / domSpan * w;
        bandX1 = (clampedT1 - ws) / domSpan * w;
      }
    }
    // expose the band state for tests
    this._metricBandX = (bandX0 != null) ? [bandX0, bandX1] : null;

    for (let li = 0; li < metrics.length; li++) {
      const series = metrics[li];
      // lanes sit directly under the minimap; the time axis stays just above the flame
      // content (contentTop − AXIS_H), i.e. BELOW the lanes — so nothing overlaps.
      const laneY = this._laneTop(li);

      // lane background
      ctx.fillStyle = (li % 2 === 0) ? this.T.bg2 : this.T.bg;
      ctx.fillRect(0, laneY, w, METRIC_LANE_H);

      // separator line at the top of the lane
      ctx.strokeStyle = this.T.line; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, laneY + 0.5); ctx.lineTo(w, laneY + 0.5); ctx.stroke();

      // find the value range among visible samples (those whose time falls in [ws, we])
      const times = series.time, values = series.value, n = times.length;
      if (!n) continue;
      let vMin = Infinity, vMax = -Infinity;
      for (let i = 0; i < n; i++) {
        if (times[i] >= ws && times[i] <= we) {
          if (values[i] < vMin) vMin = values[i];
          if (values[i] > vMax) vMax = values[i];
        }
      }
      // fall back to full range if nothing is visible (shouldn't happen normally)
      if (!isFinite(vMin)) {
        for (let i = 0; i < n; i++) { if (values[i] < vMin) vMin = values[i]; if (values[i] > vMax) vMax = values[i]; }
      }
      const vSpan = (vMax > vMin) ? (vMax - vMin) : 1;
      // padding so the filled area doesn't touch the very top/bottom of the lane
      const plotPad = 4, plotH = METRIC_LANE_H - plotPad * 2 - 1 /* bottom border */;
      const toY = (v) => laneY + plotPad + (1 - (v - vMin) / vSpan) * plotH;
      const toX = (t) => (t - ws) / domSpan * w;

      // clip drawing to the lane rect so no overdraw leaks outside
      ctx.save();
      ctx.beginPath(); ctx.rect(0, laneY, w, METRIC_LANE_H); ctx.clip();

      // build path: walk samples in order; include one sample on each side of the window for
      // smooth clipping at the window boundary.
      const lineColor = laneColors[li % laneColors.length];
      ctx.beginPath();
      let started = false;
      // find first sample at or before ws (for smooth left edge)
      let iStart = 0;
      for (let i = 1; i < n; i++) { if (times[i] <= ws) iStart = i; else break; }
      for (let i = iStart; i < n; i++) {
        if (times[i] > we + domSpan * 0.01) { // one small step past the right edge
          const x = toX(times[i]), y = toY(values[i]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          break;
        }
        const x = toX(times[i]), y = toY(values[i]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      if (started) {
        // close the filled area down to the lane bottom; track the index of the last plotted point
        let iEnd = n - 1;
        for (let i = iStart; i < n - 1; i++) { if (times[i + 1] > we + domSpan * 0.01) { iEnd = i + 1; break; } }
        ctx.lineTo(toX(times[iEnd]), laneY + METRIC_LANE_H - 1);
        ctx.lineTo(toX(times[iStart]), laneY + METRIC_LANE_H - 1);
        ctx.closePath();
        ctx.fillStyle = this._rgba(lineColor, 0.22);
        ctx.fill();
        // re-draw the line on top
        ctx.beginPath(); ctx.moveTo(toX(times[iStart]), toY(values[iStart]));
        for (let i = iStart + 1; i < n; i++) {
          ctx.lineTo(toX(times[i]), toY(values[i]));
          if (times[i] > we + domSpan * 0.01) break;
        }
        ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5; ctx.stroke();
      }

      // FG-025 pass 2: frame→track band — translucent vertical highlight for the hovered box's
      // time span. Drawn inside the clip so it never bleeds outside the lane rect.
      if (bandX0 != null) {
        ctx.fillStyle = this._rgba(this.T.accent, 0.28);
        ctx.fillRect(bandX0, laneY, bandX1 - bandX0, METRIC_LANE_H);
      }

      // FG-025 pass 3: brush rectangle — drawn over the lane for both in-progress and committed brushes
      {
        let bx0 = null, bx1 = null;
        if (this.brush) {
          // committed brush
          bx0 = (Math.max(this.brush[0], ws) - ws) / domSpan * w;
          bx1 = (Math.min(this.brush[1], we) - ws) / domSpan * w;
        } else if (this._brushDrag && this._brushT != null) {
          // in-progress brush drag
          const tb0 = Math.min(this._brushDrag.startT, this._brushT);
          const tb1 = Math.max(this._brushDrag.startT, this._brushT);
          bx0 = (Math.max(tb0, ws) - ws) / domSpan * w;
          bx1 = (Math.min(tb1, we) - ws) / domSpan * w;
        }
        if (bx0 != null && bx1 > bx0) {
          ctx.fillStyle = this._rgba(this.T.accent, 0.18);
          ctx.fillRect(bx0, laneY, bx1 - bx0, METRIC_LANE_H);
          ctx.strokeStyle = this._rgba(this.T.accent, 0.7);
          ctx.lineWidth = 1;
          ctx.strokeRect(bx0 + 0.5, laneY + 0.5, bx1 - bx0 - 1, METRIC_LANE_H - 1);
        }
      }

      ctx.restore();

      // label: "name (unit)" left-aligned in the lane
      ctx.fillStyle = this.T.dim;
      ctx.font = '10px Menlo, Consolas, monospace'; ctx.textBaseline = 'middle';
      const label = series.unit ? `${series.name} (${series.unit})` : series.name;
      ctx.fillText(label, 4, laneY + METRIC_LANE_H / 2);
    }

    // bottom border of the last lane (the time axis is drawn just below this, above content)
    const lastLaneBot = this._laneTop(metrics.length);
    ctx.strokeStyle = this.T.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, lastLaneBot - 0.5); ctx.lineTo(w, lastLaneBot - 0.5); ctx.stroke();
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
      // draw from the top of the metric lanes (or contentTop when no lanes) down through the flames
      const crossTop = this.metricsH > 0 ? MINIMAP_H : this.contentTop;
      ctx.beginPath(); ctx.moveTo(cx, crossTop); ctx.lineTo(cx, this.contentTop + this.viewH); ctx.stroke();
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
      this._drawMetricLanes();
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
