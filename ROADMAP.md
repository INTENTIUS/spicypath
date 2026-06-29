# spicypath — Roadmap

**spicypath** is a profile inspector: point it at any source — view one profile, correlate
it with metrics, or compare several — and explore it as a flame graph, timeline, sandwich,
or radial view. Not a dashboard, not a Grafana plugin.
(See [`docs/`](./docs/) for architecture and formats; working code in [`src/`](./src/) and
[`test/`](./test/).)

## Legend

- **Status:** ✅ done · 🚧 in progress · ⬜ todo · 🅿️ deferred
- **Priority:** P0 next/blocker · P1 core · P2 later · P3 someday
- IDs are stable (`FG-NNN`). Each open issue has a metadata block + acceptance criteria.

## Milestones

| # | Milestone | Status |
|---|---|---|
| M0 | Research & strategy | ✅ |
| M1 | Spike: model + parsers + renderer + views + test data | ✅ |
| M2 | Promotion to `src/` + in-browser file ingestion | ✅ |
| M3 | Interaction parity (minimap, detail panel, diff, export) | ✅ |
| M3.5 | UI reshape: chrome-less, full-bleed, context-driven (sets the project vibe) | ✅ |
| **M4** | **Point-at-sources (remote adapters, metrics coupling) — NEXT** | 🚧 |

## Issue index

| ID | Title | Status | Pri | Area | M |
|---|---|---|---|---|---|
| FG-001 | Canonical data model (spec + validated) | ✅ | P0 | model | M1 |
| FG-002 | pprof parser | ✅ | P0 | parser | M1 |
| FG-003 | V8 `.cpuprofile` parser | ✅ | P0 | parser | M1 |
| FG-004 | folded/collapsed parser | ✅ | P1 | parser | M1 |
| FG-005 | speedscope parser (sampled + evented) | ✅ | P1 | parser | M1 |
| FG-006 | Canvas flame **graph** renderer (clean-dense) | ✅ | P0 | renderer | M1 |
| FG-007 | Flame **chart** (Timeline) | ✅ | P0 | renderer | M1 |
| FG-008 | Auto-collapse boring chains | ✅ | P1 | renderer | M1 |
| FG-009 | Search (regex + dim) | ✅ | P1 | renderer | M1 |
| FG-010 | Sandwich (caller/callee) | ✅ | P1 | renderer | M1 |
| FG-011 | Semantic color by package | ✅ | P1 | renderer | M1 |
| FG-012 | Hover path highlight | ✅ | P1 | renderer | M1 |
| FG-013 | Click-to-zoom (node + time window) | ✅ | P1 | renderer | M1 |
| FG-014 | Value-type selector | ✅ | P1 | ui | M1 |
| FG-015 | Test data: Scene → emitters + golden suite | ✅ | P1 | testing | M1 |
| FG-016 | Promotion to `src/` (app) + `test/` (harness) | ✅ | P0 | infra | M2 |
| FG-017 | In-browser file-drop ingestion (Import) | ✅ | P0 | parser/ui | M2 |
| FG-018 | `evented` speedscope parser | ✅ | P1 | parser | M2 |
| FG-019 | Minimap / draggable time-window crop | ✅ | P1 | renderer/ui | M3 |
| FG-020 | Detail panel: This Instance / All Instances | ✅ | P1 | ui | M3 |
| FG-021 | Export (save profile / snapshot) | ✅ | P2 | ui | M3 |
| FG-022 | View naming (Timeline / Aggregated / Sandwich) | ✅ | P2 | ui | M3 |
| FG-023 | Diff / comparison view | ✅ | P1 | renderer | M3 |
| FG-024 | Scale benchmark + viewport virtualization | ✅ | P1 | renderer | M3 |
| FG-025 | Metrics coupling (tracks + bidirectional hover + brush) | ⬜ | P2 | renderer | M4 |
| FG-026 | perf-script parser + emitter | ✅ | P2 | parser/testing | M4 |
| FG-027 | OTLP Profiles parser + emitter | ⬜ | P2 | parser/testing | M4 |
| FG-028 | Remote source adapters (live `/debug/pprof` first) | ✅ | P2 | infra | M4 |
| FG-029 | Persisted shareable links | ⬜ | P3 | ui | M4 |
| FG-030 | Source-line view | ⬜ | P3 | ui | — |
| FG-031 | JFR ingestion | 🅿️ | P3 | parser | — |
| FG-032 | Real-browser test harness (CDP, zero-dep) | ✅ | P1 | testing | M4 |
| FG-033 | Viewport parity: scroll / zoom / crosshair / scrollbar | ✅ | P1 | renderer/ui | M4 |
| FG-034 | Full-bleed canvas + persistent status strip | ✅ | P0 | ui | M3.5 |
| FG-035 | Right-click frame context menu + view action API | ✅ | P0 | renderer/ui | M3.5 |
| FG-036 | Command palette (⌘K) + floating search (⌘F) | ✅ | P1 | ui | M3.5 |
| FG-037 | On-demand detail slide-over + legend/help overlays | ✅ | P1 | ui | M3.5 |
| FG-038 | Decouple renderer: BaseView context + FlameView geometry | ✅ | P0 | renderer | M3.5 |
| FG-039 | Radial (sunburst) view — first alternative view type | ✅ | P1 | renderer | M3.5 |
| FG-040 | Ghostty theme import + featured roster (color engine) | ✅ | P1 | renderer/ui | M3.5 |
| FG-041 | Gecko (Firefox Profiler) ingestion | ⬜ | P3 | parser | M4 |
| FG-042 | "Vaus mode" — play Arkanoid against the profile (easter egg) | ⬜ | P3 | renderer | — |

---

## Done (M1) — the spike

All validated against real data (Go pprof + V8 `.cpuprofile`) and the golden corpus.

- **FG-001** canonical model — interned SoA + prefix-tree; validated by `test/run.ts`. Spec: [`docs/architecture.md`](./docs/architecture.md). _(bfbe9a8)_
- **FG-002/003/004** parsers: pprof (hand-rolled protobuf), `.cpuprofile`, folded. _(bfbe9a8, ef7df29)_
- **FG-006…FG-014** renderer + views: graph, chart, sandwich, auto-collapse, search, semantic color, hover path highlight, zoom, value-type selector. `test/{layout,flamechart,sandwich,render-canvas}.js`. _(fcbe1f1, d920213, eee1593, 85230a6, 311ee1b)_
- **FG-015** test data: one Scene → 4 emitters, 24/24 golden round-trips. `test/{scene.js,emit/*,golden.ts}`. _(ef7df29)_

The clean-dense combination from [`docs/architecture.md`](./docs/architecture.md)
(borderless · row rhythm · semantic color · labels-where-fit · path highlight · auto-collapse)
is complete in code.

---

## Open issues

## M3.5 — UI reshape: chrome-less, full-bleed, context-driven  ✅ **(shipped)**

**Why this is next, ahead of M4.** The current chrome is speedscope's silhouette: a top
toolbar + a bottom detail bar sandwiching the canvas. In `src/index.html` the page is four
static horizontal bands — `#bar` (37–65) → `#hint` (66) → `#legend` (67) → `<canvas#cv>`
(68) → `#detail` (69) — ≈30% of vertical space on a laptop spent on chrome before a single
sample is drawn. This phase makes the app *look and feel like its own project*: full-bleed
data, controls summoned on demand. It sets the visual identity everything after inherits,
so it goes first. **Same features, no removals** — controls move, state stays visible.
_(Strategic note, not a blocker: this is viewer-layer polish, not the moat. M4's first live
adapter is what makes spicypath a different **project**; M3.5 makes it stop looking like a
**clone**.)_

**Single shell (decided).** The old banded UI is *not* preserved — no `ui=classic`/`fullbleed`
toggle, no swappable-shell abstraction. The renderer is already ~decoupled (only 4 guarded DOM
hooks: `#searchInfo`/`#legend`/`#detail`/`#tt`), so the new chrome just keeps those ids; the
only renderer change is FG-037's `onSelect` callback. View **modes** (graph/chart/sandwich/diff)
are pure canvas states, independent of the chrome either way.

**The discipline line — non-negotiable across all four issues:**
> Hide **controls**, never **state**. Mode, weight, and diff-on stay legible at all times —
> a frame's width means different things in Timeline vs Aggregated, so hiding the current
> mode is a *correctness* bug, not just a UX one. View modes stay **visibly discoverable**
> (a minimal segmented control), never palette-only.

**Sequencing:** FG-034 → FG-035 → FG-036 → FG-037, each committed separately so the vibe is
eyeball-able in order. Across all four: preserve the `window.__fv` handle (set in `rebuild()`,
`index.html:104`) and keep `test/browser.ts` green — its DOM selectors break when `#bar` /
`#detail` are reshaped, so update them in the same commit. `#tt` (hover tooltip) and `#drop`
(drag overlay) already float — keep them. Drag-and-drop ingestion (`index.html:179–183`)
stays as-is. No `src/model.js` / parser / `render-canvas.js` data-path changes — this is
chrome + a thin action API only.

### FG-034 · Full-bleed canvas + persistent status strip ✅
- **Status** ✅ · **Pri** P0 · **Area** ui · **M** M3.5 · _(6bd6582)_
- Shipped: full-bleed canvas + one bottom status strip (mode segmented control · weight
  click-cycle token · [diff] exit token · file · nodes · total). Former toolbar commands sit
  in a compact actions group on the strip (palette relocation is FG-036). Detail → on-demand
  slide-over via a new `FlameView` `onSelect` callback; legend/tooltip float; empty-state
  centered. Canvas fills the stage (`viewH = available`), reserve 170→36. 28 browser checks green.
- Canvas → `position:absolute; inset:0`; every other surface floats over it with scoped
  `pointer-events`. **Delete** the static `#hint` and `#legend` bands (their content returns
  on demand in FG-037).
- **Status strip** (~22px, the one persistent surface — it replaces `#info` *and* the mode
  buttons *and* the weight `<select>` **as a display**): always shows
  `mode · weight · [diff vs …] · file · N nodes · total`. Source the text from the existing
  `updateInfo()` data (`index.html:105–109`) plus current mode + weight. Tokens are
  click-to-change: the **weight** token cycles `profile.capabilities.weightTypes`; the
  **mode** token is a minimal always-visible segmented control (Timeline / Aggregated /
  Sandwich) — discoverability, see the discipline line; clicking `[diff vs …]` exits diff
  (today's reset-from-diff path, `index.html:102`).
- Empty state: a centered prompt ("drop a profile · ⌘K to open") instead of a toolbar.
- **Acceptance:** canvas fills the viewport with no horizontal bands above or below; mode +
  weight + diff state remain visible at all times, including while a menu/palette is open;
  changing mode/weight from the strip drives the same `setMode` / `rebuild` paths as today;
  `test/browser.ts` green (selectors updated).

### FG-035 · Right-click frame context menu + view action API ✅
- **Status** ✅ · **Pri** P0 · **Area** renderer/ui · **M** M3.5 · _(d98affd)_ · **Depends** FG-034
- Shipped: `contextmenu` on the canvas → `view._hit` (gated to content; minimap/axis ignored)
  → menu: Focus subtree · Sandwich this · Search this frame · Copy stack. Action API on the
  views (no copy-pasted logic): `BaseView.sandwichFunc/frameLabel/frameStack` + per-view
  `focusBox` (double-click now routes through it). "Sandwich this" switches to the flame view
  if needed, restoring explicit per-function sandwich. 50 browser checks.
- Add a `contextmenu` listener on the canvas; reuse `_hit(px,py)` (`render-canvas.js:167`)
  to resolve the frame; gate the chrome region with `if (this._hasMinimap() && py < this.contentTop) return`
  (wheel uses this pattern ~`:252`; note `contentTop` is now `MINIMAP_H + AXIS_H` = 70, so it
  also excludes the axis ruler — don't gate on bare `MINIMAP_H`). Menu anchored at the cursor;
  Esc / blur / click-away dismiss.
- Promote the actions FlameView already performs implicitly into **named public methods**, so
  the menu (and later the palette) call one stable API instead of duplicating logic:
  - `focusNode(node)` — extract the subtree zoom/crop currently inside the dblclick path.
  - `sandwichFunc(func)` — mirror the sandwich path in `setMode` (`:78`, which sets the focal +
    calls `_buildSandwich()`) and the dblclick re-center (`_onDblClick`, `:307`): set
    `selectedFunc`, `_buildSandwich()`, then `setMode('sandwich')`.
  - `frameStack(node)` / `frameLabel(node)` — for *Copy stack* / *Search this frame* (caller
    escapes the label into a regex and calls the existing `setSearch`, `:85`).
- Menu items: **Focus subtree · Sandwich on this · Search this frame · Copy stack** (·
  *Hide frame* optional — may defer).
- **Acceptance:** right-click any frame → menu with working Focus / Sandwich / Search / Copy;
  each goes through the new public methods (no copy-pasted logic); right-click over the
  minimap does nothing; a `test/browser.ts` check drives `focusNode` / `sandwichFunc` via
  `window.__fv` and asserts resulting state.

### FG-036 · Command palette (⌘K) + floating search (⌘F) ✅
- **Status** ✅ · **Pri** P1 · **Area** ui · **M** M3.5 · _(4de17ad)_ · **Depends** FG-034
- **Palette** (⌘K / Ctrl-K): a centered overlay listing every former-toolbar command — Open
  file, Compare…, Load sample ▸ (the 4 bundled in `index.html:42–47`), Mode ▸, Weight ▸,
  Toggle collapse, Export ▸ (speedscope / folded / svg), Reset view. Each entry calls the
  *same function body* `index.html` already wires (`setMode`, the `export` `onchange` at
  `:155`, `openFile`, `resetView`) — relocate call sites, don't rewrite logic. Substring/fuzzy
  filter on the list.
- **Search** moves out of `#bar` into a floating pill (⌘F or `/`), collapsed when empty,
  carrying `searchInfo`; drives the existing `view.setSearch` (`:153`).
- Keyboard parity: `1/2/3` = modes, `c` = collapse, Esc = reset zoom (already
  `index.html:186`) then dismiss any open overlay.
- **Acceptance:** every action formerly reachable from `#bar` is reachable from the palette;
  ⌘F focuses search and live-filters the view; no static toolbar (`#bar`) remains in the DOM;
  `test/browser.ts` green with added palette-open + command-dispatch checks.

### FG-037 · On-demand detail slide-over + legend/help overlays ✅
- **Status** ✅ · **Pri** P1 · **Area** ui · **M** M3.5 · _(bbfec46)_ · **Depends** FG-034
- Slide-over shipped early (FG-034, `onSelect`). This added: on-demand legend (hidden by
  default; `colors` token / `l` / palette), a `?` help overlay (keys + gestures), and a
  one-time first-run coachmark (`localStorage`). No permanent detail/hint/legend bands remain.
- The `#detail` content from FG-020 (This Instance / All Instances / stack trace) moves into a
  **right slide-over** that appears on frame-select and dismisses on Esc / click-away — it
  overlays the canvas edge, never a permanent band. Selection still outlines all instances of
  the function (FG-020 behavior).
- **The one renderer change in M3.5** (single-shell decision — see preamble): add an
  `onSelect(node|null)` callback option to `FlameView`, fired from `_onClick`, so the shell can
  open/close the slide-over. `_updateDetail` keeps filling a `#detail` element *inside* the
  slide-over; `#legend`/`#tt`/`#searchInfo` stay as ids in the new chrome (FlameView's other 3
  DOM hooks, all `if (el)`-guarded). No broader decouple — we are not keeping a second shell.
- Legend (FG-011 colors) becomes on-demand: a corner chip or a hover-expand off the status
  strip's color token. Per-mode help (old `#hint` / the `HINTS` map, `index.html:89–93`) folds
  into a `?` overlay plus a one-time first-run coachmark (dismiss flag in `localStorage`).
- **Acceptance:** selecting a frame slides detail in **without resizing the canvas**;
  deselect / Esc hides it; legend reachable on demand; no permanent detail / hint / legend
  bands remain; the FG-020 recursion-aware aggregate (All-Instances counted once per sample)
  still renders correctly in the slide-over.

### FG-038 · Decouple renderer: BaseView context + FlameView geometry ✅
- **Status** ✅ · **Pri** P0 · **Area** renderer · **M** M3.5 · _(912a177)_
- Added because the project now wants **many view types** (rect today, radial next). Split
  `FlameView` into `BaseView` (view-type-agnostic context: data prep, selection, search,
  colors, legend/detail/tooltip, mode actions) + `FlameView extends BaseView` (rectangular
  geometry/paint/hit-test/interaction). Shell has a `VIEWS` registry; `rebuild()` instantiates
  by `viewType`. Pure restructure, no behavior change — 28 browser checks + golden 36/36.
- First cut keeps events in the view (not controller-routed); revisit when radial needs
  different interaction. `_updateDetail`'s chart branch still reads `this.boxes` (rect) — a
  radial view supports `graph`/`diff` modes where detail is node-based, so it's unaffected.

### FG-039 · Radial (sunburst) view — first alternative view type ✅
- **Status** ✅ · **Pri** P1 · **Area** renderer · **M** M3.5 · _(ec38aff)_ · **Depends** FG-038
- `src/view-radial.js`: `RadialView extends BaseView`. Reuses the SAME `layout()` with
  `width = 2π` so each box's `x`/`w` is an angular range and `depth` a ring — only `draw()`
  (wedges), `_hit()` (angular), and a small constructor/interaction set are radial. dblclick
  focuses a subtree; the center pops back out. `capabilities.modes = ['graph']` (aggregated;
  diff via compare). Shell: `VIEWS={flame,radial}` + a view-type token that cycles types +
  `applyCaps()` greying out Timeline/Sandwich for radial.
- **Validated the FG-038 interface:** a whole new view type was ~120 lines with **zero**
  changes to the shared context. It reused selection, search-dim, colors, the detail
  slide-over, and the legend as-is. Event-routing stayed in the view (radial's set is just
  move/click/dblclick) — **controller-routing wasn't needed**, so we keep view-owned events.
  31 browser checks (3 new radial), golden 36/36.

### FG-040 · Ghostty theme import + featured roster (color engine) ✅
- **Status** ✅ · **Pri** P1 · **Area** renderer/ui · **M** M3.5 · _(c38c753…ad92aba)_ · **Depends** FG-036 (picker UI)
- Shipped in 3 commits: parser + 20-theme vendored roster (`src/theme.js`+`themes.js`);
  OKLCH-degrade color engine in `colors.js`; CSS vars + canvas token routing +
  ⌘K picker + localStorage persist. 59 browser checks, golden 36/36.
- **Why:** color is the single biggest "vibe" lever, and a Ghostty theme is a near-perfect
  source — 16 ANSI colors + `background`/`foreground`/`cursor-color`/`selection-background`,
  which maps 1:1 onto spicypath's color budget (categorical hues for semantic-by-package,
  `red↔green` for diff, bg/fg for canvas, selection for highlight). Adopting the corpus gives
  a color story no flame-graph viewer has (speedscope ships ~4 hash palettes). Upstream
  roster is `mbadolato/iTerm2-Color-Schemes` (dir `ghostty/`, one file per theme,
  weekly-synced; ~552 themes; format example = Catppuccin Mocha).
- **The non-free part — hue assignment.** A theme yields ~8 categorical hues but a deep
  profile has 30+ packages, so the engine still needs a **deterministic** package→hue map
  that degrades past 8 (rotate the base hues + perturb L/C in OKLCH, stable per package name).
  The theme supplies palette *identity*; `colors.js` keeps the *bucketing* (`packageOf` at
  `src/colors.js:24`, currently hash→`PALETTE[10]`).
- **Scope:**
  1. **Theme model + parser** — `src/theme.js`: parse a Ghostty theme block → `{palette[16],
     bg, fg, cursor, selection}`. Pure JS, browser+Node (no build).
  2. **Vendored roster (zero-build/offline constraint)** — a converter in `test/` reads the
     cloned `ghostty/` corpus and emits a vendored `src/themes.js` (or `.json`) holding the
     **featured ~15–20** in full + (optionally) the full 552 lazily. App cannot fetch at
     runtime, so the data is generated and committed; record the upstream commit hash.
  3. **Theme-drive `colors.js`** — replace the hardcoded `PALETTE`/delta endpoints with values
     derived from the active theme: categorical hues from `palette[1..6,9..14]`; `colorForDelta`
     red/green from `palette` 1/9 (red) & 2/10 (green) instead of the baked rgb() ramp
     (`src/colors.js:45`); apply OKLCH hue-rotation for >8 packages.
  4. **Canvas + chrome bg/fg from theme** — today bg/fg/label colors are hardcoded across
     `render-canvas.js` (e.g. `#11161d`, label `#f4f7fb`) and `index.html`. Route them through
     the active theme so a light theme (Catppuccin Latte, Rose Pine Dawn) actually renders
     light. This is the only cross-file change of weight; keep a single `theme` accessor.
  5. **Picker** — a "Theme ▸" entry in the FG-036 command palette (featured list, fuzzy
     filter), persisted to `localStorage`. Optional drag-drop of a raw `.ghostty` theme file
     → live apply (dogfoods the parser).
- **Featured shortlist (curate; cover the spectrum):** Catppuccin Mocha · Tokyo Night ·
  Gruvbox Dark · Rose Pine · Nord · Everforest Dark · Solarized Dark · Dracula · a synthwave
  (Cyberpunk / Synthwave) · a monochrome (Vesper / Matte Black) + lights: Catppuccin Latte ·
  Rose Pine Dawn · Tokyo Night Day · Gruvbox Light · GitHub Light.
- **Acceptance:**
  1. `test/theme-test.ts`: parse ≥10 real Ghostty files → each yields 16 palette + bg/fg with
     no missing keys; a known file (Catppuccin Mocha) matches expected hexes exactly.
  2. switching theme in the running app recolors flame graph, diff, minimap, legend, detail,
     **and** canvas/chrome bg+fg — a light theme renders light (no dark remnants); verified in
     `test/browser.ts`.
  3. **>8-package determinism:** a profile with 20 packages → 20 visually distinct, **stable**
     colors (same package → same color across reloads/zoom); unit-assert the hue map.
  4. diff red/green derive from the active theme (Gruvbox diff ≠ Catppuccin diff), and the
     `colorForDelta` near-zero grey still reads as neutral on both light and dark bg.
  5. golden + bench unchanged (color is render-time only; no model/layout change).
- _Note:_ semantic bucketing (FG-011) and diff colors (FG-023) already centralize in
  `src/colors.js` — this issue makes that module **theme-driven** rather than constant, so the
  blast radius is mostly one file plus the bg/fg routing in (4).
- **Attribution (resolved):** the full 552-theme corpus is vendored; upstream
  iTerm2-Color-Schemes MIT license bundled (`licenses/iTerm2-Color-Schemes-LICENSE`) and
  palettes pinned to commit `982a5345` in `test/make-themes.ts`. Per-theme attribution
  follows the upstream's collection model (each theme belongs to its author; no 552-way
  enumeration) — see [`THIRD_PARTY.md`](./THIRD_PARTY.md).

### FG-005 · speedscope parser (sampled + evented) ✅
- **Status** ✅ · **Pri** P1 · **Area** parser · **M** M1
- Both variants parse (`test/parse-speedscope.ts`); evented reconstructed into
  per-interval timed samples. Covered by golden (`evt.speedscope.json` format) + the real
  Downloads export. _(see FG-018)_

### FG-016 · Promotion to `src/` (app) + `test/` (harness) ✅
- **Status** ✅ · **Pri** P0 · **Area** infra · **M** M2
- **Zero-build** layout (option c — no bundler, no deps, works offline): app modules +
  `index.html` + bundled `sample.cpuprofile` in `src/` (each ES module imports siblings,
  runs directly in the browser); Node harness, fixtures, generators in `test/` (importing
  `../src/`). App no longer depends on pre-baked `*-model.json` — it ingests
  `sample.cpuprofile` on load and any dropped file. Pure parser cores in `src/`, thin
  Node file-wrappers in `test/`.
- **Verified:** full suite green from repo root — `run`, golden 36/36, ingest 37/37,
  export 5/5, diff, verify, bench. Serve with `python3 -m http.server` in `src/`.
- _Bundler/`tsconfig` intentionally deferred — not needed for the zero-build setup._

### FG-017 · In-browser file-drop ingestion (Import) ✅
- **Status** ✅ · **Pri** P0 · **Area** parser/ui · **M** M2
- Parsers split into pure cores (`parse-*.js`, bytes/text, shared `model.js`) + thin Node
  wrappers (`parse-*.ts`). `ingest.js` gunzips via `DecompressionStream` and detects format
  by extension + content sniff. `index.html` has drag-drop + file picker; nothing uploaded.
- **Verified:** `node test/ingest-test.ts` → 31/31 fixtures ingest (+ gzipped pprof via
  DecompressionStream). golden still 30/30.
- _Note:_ delivered the **ingestion** substance; the `src/` move landed in FG-016.

### FG-018 · `evented` speedscope parser ✅
- **Status** ✅ · **Pri** P1 · **Area** parser · **M** M2
- Parses `O`/`C` events into per-interval timed samples (`hasTiming=true`). Emitter
  `emit/emit-speedscope-evented.js` added → golden round-trips (30/30). The real
  `perf_vertx_stacks_01_collapsed_all.speedscope.json` loads → 199 samples, 244 boxes
  (`test/out/real-vertx.svg`).

### FG-019 · Minimap / draggable crop — **per mode** ✅
- **Status** ✅ · **Pri** P1 · **Area** renderer/ui · **M** M3
- Matches speedscope: the preview strip appears in **both** flamechart modes showing
  *that mode's* layout, and **not** in sandwich (speedscope's `FlamechartView` includes
  the minimap; sandwich's `FlamechartWrapper` doesn't).
  - **Timeline**: time overview; crop = a **time** window.
  - **Aggregated**: aggregated overview; crop = a **value-fraction** window
    (`layout(... winFrac)`), independent of double-click focus (focus resets the crop).
  - **Sandwich**: no minimap.
- One generalized impl over a domain (`domStart/domEnd`): drag inside = move (clamped),
  outside = draw-new, tiny-drag → reset; `window`-level listeners; grab/col-resize cursors.
  Time-domain for chart, fraction-domain for graph; no WebGL/AffineTransform.
- **Proofs:** `test/out/node-minimap.svg` (time crop), `test/out/node-graph-minimap.svg`
  (Left-Heavy fraction crop). golden 36/36, bench unchanged (default `winFrac` path identical).

### FG-033 · Viewport interaction parity (scroll / zoom / crosshair) ✅
- **Status** ✅ · **Pri** P1 · **Area** renderer/ui · **M** M4 · **Depends** FG-019
- Contained vertical viewport (canvas fits the window; deeper content scrolls via `scrollY`
  with draw clip+translate) across chart/graph/**sandwich**, replacing page-scroll.
  - **Minimap 2D viewport**: vertical extent on the rect; drag it to scroll depth.
  - **Wheel**: scrolls depth; **⌘/Ctrl-wheel (and pinch)** zooms about the cursor (`_zoomAt`).
  - **Crosshair**: hovered domain value synced minimap↔content (speedscope bidirectional hover).
  - **Scrollbar**: right-edge draggable thumb (only vertical cue in sandwich).
  - **Esc** resets zoom/crop; minimap drag-to-crop works from the zoomed-out state.
- Also fixed: `FlameView.dispose()` removes listeners on rebuild (was leaking/​double-handling
  on the shared canvas). Verified by `test/browser.ts` — a zero-dep CDP harness driving real
  Chrome (18 checks: real clicks/drags/wheel/keys asserting computed layout + state).

### FG-020 · Detail panel: This Instance / All Instances ✅
- **Status** ✅ · **Pri** P1 · **Area** ui · **M** M3
- Bottom `#detail` panel: **This Instance** (selected call node total/self %), **All
  Instances** (function aggregate; recursion-aware total counted once per sample), and the
  **stack trace** (ancestors root→leaf with color chips). Single-click selects (+ outlines
  all instances of the function); **double-click** now does the zoom/crop/re-center
  (supersedes single-click zoom from FG-013).
- **Verified:** aggregate math — deeply-recursive `app.fib` → All-Instances total 100%
  (counted once, not per recursion level).

### FG-021 · Export (save profile / snapshot) ✅
- **Status** ✅ · **Pri** P2 · **Area** ui · **M** M3
- `export.js`: `exportSpeedscope` / `exportFolded` from the canonical model; SVG snapshot
  via `render-svg.js`. UI export dropdown downloads via Blob.
- **Verified:** `node test/export-test.ts` → export → re-import → distribution unchanged
  for 5 fixtures (incl. real vertx + multi-value pprof).

### FG-022 · View naming parity ✅
- **Status** ✅ · **Pri** P2 · **Area** ui · **M** M3
- UI labels are **Timeline** (chart) · **Aggregated** (graph, children sorted by
  total desc) · **Sandwich**, in that order — deliberately *not* speedscope's "Time Order /
  Left Heavy" vocabulary. Aggregated is a true aggregation; semantics match the names.
  _(Optional alphabetical/as-recorded ordering not added — low value.)_

### FG-023 · Diff / comparison view ✅
- **Status** ✅ · **Pri** P1 · **Area** renderer · **M** M3
- `diff.js buildDiff(A,B)` merges call trees by function-**name** path (independent func
  tables), normalizes to fractions, emits a layout-compatible CallNodeTable with per-node
  `delta = fracB−fracA` + a synthetic label profile. `colorForDelta` (red=regression,
  blue=improvement); `render-svg`/`render-canvas` honor it; browser **compare…** input.
  speedscope lacks this — a wedge.
- **Verified:** `node test/diff-test.ts` → db.query Δ+0.314 (red), json/gc Δ<0 (blue);
  proof `test/out/diff.svg`.

### FG-024 · Scale benchmark + viewport virtualization ✅
- **Status** ✅ · **Pri** P1 · **Area** renderer · **M** M3
- `test/bench.ts`: at 1400px, **drawn boxes stay ~600–1000 from 10k→1M samples**
  (pruning caps them at ≈ width×depth); layout <1ms, build ≤21ms. Draw cost is
  viewport-bounded, not N-bounded → **no virtualization needed** for the MVP range;
  vertical row-virtualization deferred (only matters for >~1000-deep stacks). Results
  from `test/bench.ts`.

### FG-025 · Metrics coupling ⬜
- **Status** ⬜ · **Pri** P2 · **Area** renderer · **M** M4 · **Depends** FG-019
- CPU/RAM/disk track lanes locked to the chart time axis; **bidirectional hover**
  (frame → its spans on tracks); metric-brush → re-aggregate the graph; correlation
  coloring + weight selector on the graph.
- **Acceptance:** bidirectional hover, metric-brush re-aggregation, and correlation
  coloring all work on a profile + a metric series.

### FG-026 · perf-script parser + emitter ✅
- **Status** ✅ · **Pri** P2 · **Area** parser/testing · **M** M4
- `parse-perf.js` (timed; blank-line sample blocks, leaf-first frames, period→weight) +
  `emit/emit-perf.js`; wired into golden (**36/36**) and ingest (`.perf`). Synthesized,
  no Linux dependency.

### FG-027 · OTLP Profiles parser + emitter ⬜
- **Status** ⬜ · **Pri** P2 · **Area** parser/testing · **M** M4
- Build behind an isolation boundary — schema is **Alpha** and moving. The convergence
  target: `pprof ↔ OTLP` is the only lossless bidirectional edge, so riding it beats one
  more legacy importer. See [`docs/formats.md`](./docs/formats.md).
- **Scope:** `parse-otlp.js` (pure core, bytes → canonical model, sibling of the other
  `parse-*.js`) + `emit/emit-otlp.js`; wire into `ingest.js` (extension + content sniff)
  and the golden suite. Pin the exact OTLP Profiles schema revision in a comment; keep all
  OTLP-specific decoding inside `parse-otlp.js` so an Alpha schema change is a one-file edit.
- **Acceptance:**
  1. golden round-trip green at the new count (a `*.otlp` fixture → canonical → re-emit → identical distribution).
  2. **Lossless-edge proof:** a real `.pprof` fixture → (its existing pprof parse) and the
     same payload converted to OTLP → `parse-otlp` produce the **same** canonical model
     (same nodes, same per-weight totals) — the `pprof ↔ OTLP` round-trip holds in our model.
  3. `node test/ingest-test.ts` ingests the `.otlp` fixture (incl. gzipped via `DecompressionStream`).
  4. Multi-value sample types map to the existing `weightsByType` columns (reuse the pprof path).

### FG-028 · Remote source adapters (live `/debug/pprof` first) ✅
- **Status** ✅ · **Pri** P2 · **Area** infra · **M** M4 · **Depends** FG-001, FG-002 · _(Slice A shipped — `src/fetch-pprof.js`; Slice B query adapters still ⬜)_
- The "point-at-sources" layer — a backend-agnostic adapter that normalizes a live source
  into the canonical model the UI already consumes. This is the move that makes spicypath
  **not file-only** — the literal thing speedscope and FF don't do.
- **Sequence the cheapest slice first — `/debug/pprof`:** it's one authenticated,
  time-range-scoped HTTP GET feeding the **existing** pprof parser (FG-002). No new parsing,
  no query language. Defer the Pyroscope/Parca **query** adapters (auth + pagination +
  time-range/aggregation pushdown + live-tail — the perpetual integration tax) until the
  viewer depth is proven.
  - **Slice A — `/debug/pprof` fetch (P2, do first):** a `fetch-pprof.js` adapter (URL +
    optional `seconds=`/auth header) → bytes → existing pprof parse → canonical model the UI
    already consumes. Browser-side first (CORS-permitting endpoints); a thin Go/Node proxy
    only if CORS forces it. **No daemon required for this slice.**
  - **Slice B — Pyroscope/Parca query (P3, later):** speak one query API, map its response to
    the canonical model. Behind an adapter interface so each backend is isolated.
- **Acceptance (Slice A):**
  1. point at a mock server serving a pprof body → flame graph renders from the live fetch
     (no file touched), via the same `loadProfile` path as a dropped file.
  2. refetch re-pulls and rebuilds the view (proves it's a source, not a one-shot import).
  3. a fetch error surfaces in the status line without wedging the current profile.
  4. driven by a mock HTTP server in the test harness (no real prod dependency), consistent
     with the zero-dep posture (cf. `test/browser.ts`).

### FG-029 · Persisted shareable links ⬜
- **Status** ⬜ · **Pri** P3 · **Area** ui · **M** M4
- State-in-URL (view, zoom, search, focal) + optional upload, FF-Profiler-style.

### FG-030 · Source-line view ⬜
- **Status** ⬜ · **Pri** P3 · **Area** ui
- Annotated source for a selected function (needs source access; out of MVP).

### FG-031 · JFR ingestion 🅿️
- **Status** 🅿️ deferred · **Pri** P3 · **Area** parser
- Binary, JVM-only, capture-only. Never synthesize; one real capture if ever needed.

### FG-041 · Gecko (Firefox Profiler) ingestion ⬜
- **Status** ⬜ · **Pri** P3 · **Area** parser · **M** M4
- Per-sample, time-ordered JSON; the native output of `samply` and the Firefox Profiler
  export, so ingesting it covers that producer family. Add `parse-gecko.js` (pure core,
  sibling of the other `parse-*.js`) → canonical model; wire into `ingest.js` (extension +
  content sniff) and the golden suite. Time order survives (both sides are per-sample).
- **Acceptance:** a Gecko fixture ingests to the canonical model with timing preserved;
  golden round-trip green at the new count; `node test/ingest-test.ts` picks it up by sniff.

### FG-042 · "Vaus mode" — play Arkanoid against the profile (easter egg) ⬜
- **Status** ⬜ · **Pri** P3 · **Area** renderer · **M** — (fun; never ahead of real work) · **Depends** FG-038
- A hidden Breakout/Arkanoid mode where the flame-graph boxes **are** the bricks. Cheap
  because the renderer already provides the whole brick field: `this.boxes`
  (`{x, w, depth, func}`), `colorForFunc`, the rAF Canvas-2D draw loop, mouse-x tracking, and
  the AABB math (the same geometry as `_pointAt` hit-testing → reflect ball velocity on the
  hit face). Build as a `GameView extends BaseView` (the FG-038 boundary; FG-039 proved a new
  view type is ~120 lines) that takes a **read-only snapshot** of the current `boxes`.
- **Mappings that make it more than a gimmick** (the profile's own structure becomes the level):
  - **Brick toughness = box weight** — hot frames take multiple hits; trivial leaves shatter
    in one (you work hardest to break the expensive code).
  - **Indestructible bricks = root + runtime/GC frames** (`main`, `runtime.*`, `gc.*`) — the
    back wall you can't optimize away.
  - **Brick color = package hue** — the FG-040 Ghostty themes make the bricks genuinely
    beautiful (same palette serves game and graph).
  - **Power-up capsules drop from heavy boxes** — multi-ball, wide Vaus, slow ball, laser.
  - **Clearing the profile = winning;** score = samples destroyed.
- **Controls:**
  - **Paddle (Vaus):** mouse-x (already tracked by the host) is primary; **←/→** (or `A`/`D`)
    for keyboard play.
  - **Launch / fire:** the ball starts stuck to the paddle; **Space** or click launches it
    (and fires the laser power-up).
  - **Pause / resume:** **P**; **Esc** opens a pause overlay (Resume / Quit).
  - **Mute:** **M** (sound is optional, synthesized via WebAudio, off by default).
  - **Sound = Web Audio synthesized SFX** (oscillator blips + gain envelopes) — **no MIDI, no
    asset files** (Web MIDI ships no synth and isn't in Safari; `.mid` needs a bundled
    soundfont — both violate the zero-dep/offline ethos). Create/`resume()` the `AudioContext`
    on the **Start gesture** (autoplay policy), which doubles as the lazy init when sound is
    first enabled.
  - `GameView` owns all key/mouse handling while active and restores the host's handlers on
    exit (the `FlameView.dispose()` listener pattern).
- **Settings — a small `gameConfig`, persisted to `localStorage`:** difficulty (ball speed ·
  paddle width · lives, default 3) · toughness curve (box weight → hit-points, with a max-hits
  cap) · indestructible set (`root` / `root+runtime+gc` / `off`) · power-ups (on/off + drop
  rate) · sound (on/off). Colors come from the **active FG-040 theme** — no separate game
  palette. A one-screen pre-game splash shows the controls + the few toggles (difficulty,
  power-ups) and a **Start** button; everything else stays at config defaults.
- **Enter / exit:**
  - **Enter:** a "Play this profile" entry in the FG-036 command palette, **or** the Konami
    code (`↑ ↑ ↓ ↓ ← → ← → B A`) anywhere in the app. On enter it **snapshots the current view
    exactly** (mode / zoom / crop included) and overlays the game — the underlying view is
    paused, never mutated.
  - **Exit:** **Esc → Quit** from the pause overlay, or after win/lose. The overlay + snapshot
    are discarded and the **exact prior view is restored with no rebuild** (it was only paused),
    with all game listeners removed.
- **Discipline (non-negotiable):** pure easter egg, zero analytical value. **Quarantined** —
  all game state inside `GameView`, read-only over a `boxes` snapshot, **no** model/renderer/
  data-path changes. **Hidden** — reached via a command-palette "Play this profile" entry or a
  Konami code, never a visible mode tab (must not dilute the M3.5 serious-tool identity). Never
  scheduled ahead of M3.5 / the first M4 adapter.
- **Soft payoff beyond delight:** a themed GIF of a ball demolishing a real flame graph is
  shareable — a low-key distribution/landing-page asset.
- **Attribution:** a homage to Taito's *Arkanoid* (1986); credit it (and the "Arkanoid"/"Vaus"
  trademark note) in [`CREDITS.md`](./CREDITS.md). Keep names clearly parodic, no endorsement.
- **Acceptance:**
  1. Enters from **both** the palette entry and the Konami code; a ball + paddle overlay the
     current view and the underlying profile view is untouched.
  2. Paddle responds to **mouse and** ←/→; **Space** launches/fires; **P** pauses and resumes.
  3. Ball reflects correctly off box faces and the paddle; boxes take **weight-scaled** hits
     and disappear; root/runtime bricks are unbreakable.
  4. Win on field clear, lose on losing all lives; the pre-game splash + `gameConfig`
     (difficulty, power-ups, lives) take effect and **persist** across sessions.
  5. **Esc → Quit (or game-over) restores the exact prior view** — same mode/zoom/crop — with
     no state leak and all game listeners removed.

### FG-032 · Real-browser test harness ✅
- **Status** ✅ · **Pri** P1 · **Area** testing · **M** M4
- `test/browser.ts` drives the system Chrome over the DevTools Protocol using only Node
  built-ins (global `WebSocket` + `fetch`) — no selenium/chromedriver/puppeteer, preserving
  the no-build/no-deps architecture. Loads a profile via the real file-open path, performs
  real clicks (`Input.dispatchMouseEvent`), and asserts **computed** bounding rects. The
  headless Node tests stub `getContext`/layout (logic only); this catches CSS/layout render
  bugs — legend swatch sizing and detail-panel stack reconstruction in both Aggregated and
  Timeline. Exposes a small `window.__fv` test handle from `rebuild()`.

---

## Notes

- **Non-goals** (permanent): a dashboard / panel grid; a Grafana **panel** plugin as the
  flagship; owning collection/storage.
- **Shipped:** **M3.5 — the UI reshape** (FG-034 → FG-035 → FG-036 → FG-037, plus FG-038 →
  FG-039 → FG-040): full-bleed canvas + persistent status strip, right-click frame menu + view
  action API, ⌘K palette + ⌘F search, detail slide-over, the BaseView/FlameView decouple, the
  radial view, and the Ghostty theme engine. The project's chrome-less, context-driven visual
  identity is established. **FG-028 Slice A** (live `/debug/pprof` fetch — the step that makes
  spicypath *not file-only*) also landed (`src/fetch-pprof.js`).
- **Next up (M4):** the remaining differentiating moat — **FG-027** (OTLP file, the
  `pprof ↔ OTLP` convergence target, reuses the pprof parser), then **FG-025** (metrics
  coupling) as the deeper differentiator, and **FG-028 Slice B** (Pyroscope/Parca query
  adapters).
