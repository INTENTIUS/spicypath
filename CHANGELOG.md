# Changelog

What has shipped in spicypath, grouped by milestone. Open and planned work lives in
[GitHub issues](https://github.com/INTENTIUS/spicypath/issues) (the `FG-NNN` ids carry over
into issue titles). Conventions are in [`CONTRIBUTING.md`](./CONTRIBUTING.md); design rationale
is in [`docs/architecture.md`](./docs/architecture.md).

Everything below predates the squashed initial commit, so individual change hashes aren't
linkable — the entries record *what* shipped and *why*, not the original commit refs.

## Enhancements (post-M4)

- FG-060 Heap dumps (HPROF) — a second analysis family. spicypath now reads a JVM `.hprof` heap
  dump: `src/parse-hprof.js` parses the binary object graph (FG-058), `src/heap-dominators.js`
  computes the dominator tree + retained sizes (FG-059), and the shell renders it as a
  **retained-size icicle** on the existing renderer (FG-060) — biggest retainers widest, nesting =
  "dominates", coloured by class/package, with the detail panel's stack repurposed as the retainer
  path. The bet paid off: `buildCallNodeTable` gains a `kind:'heap'` branch that projects the
  dominator tree into the same call-node-table shape (retained = weight, which is monotone up the
  tree), so FlameView draws it with no renderer changes. Heap profiles route through the normal view
  path with `capabilities.kind:'heap'` gating the sampled-only chrome (threads, chart, sandwich);
  the sampled path is untouched. Validated end-to-end against a ground-truth heap fixture
  (`test/gen/HprofWorkload.java`): exclusive/shared/cycle/chain retention + conservation of retained
  size all hold. (Class histograms and heap diff are possible follow-ons.)
- FG-042 Vaus mode (hidden easter egg) — a brick-breaker where the flame-graph boxes are the
  bricks (toughness scales with box weight; root + runtime/gc frames are the indestructible back
  wall). Built as `GameView extends BaseView` (`src/view-vaus.js`) over a pure, DOM-free sim
  (`src/vaus.js`), overlaying a read-only snapshot of the host view's boxes. Reached only via the
  ⌘K "Play this profile" command or the Konami code — never a visible mode tab. The host view is
  paused, not mutated: the game's pointer/key listeners run in the capture phase and swallow events
  so the underlying view never hovers, zooms, or repaints, and quitting (Esc → Quit, or win/lose)
  restores the exact prior view — same object, boxes, mode, zoom — with no rebuild. Web-Audio
  synthesised SFX only (no asset files); `gameConfig` (difficulty, lives, indestructible set,
  power-ups, sound) persists to `localStorage`. Homage to Taito's Arkanoid (1986); see
  [`CREDITS.md`](./CREDITS.md). Tests: `test/vaus-test.ts` (pure physics/classification/win-lose/
  config) + `test/browser.ts` (both entry paths, deterministic brick destruction, host-untouched,
  exact-restore, no-leak, config persistence).

- FG-054 JFR GC events as metric tracks — `src/parse-jfr.js` now also decodes the stackless
  `jdk.GCPhasePause` (and `…PauseLevel1`) duration events into a `MetricSeries` ("GC pause", ms)
  on `Profile.metrics`, time-aligned to the recording's sample/chart axis. With no renderer change
  it surfaces through the FG-025 metric lanes on the Timeline, so a GC spike sits next to the flame
  and brushing it re-aggregates to that window — the "GC or the app?" question in one view. Purely
  additive: non-JFR profiles keep empty `metrics`. Validated against the `jfr` tool (pause
  durations match exactly).
- FG-053 Thread selector — multi-thread recordings can be sliced by thread. A new
  `mergedThread(profile)` (`src/callnode.js`) concatenates every thread's samples over the shared
  interned tables; `buildCallNodeTable`/`buildFlameChart` accept a Thread object or an index (the
  seam), and `BaseView` takes an `opts.thread`. A multi-thread profile **defaults to the merged
  "all threads" view** (nothing hidden), with a status-strip token + ⌘K entries to narrow to a
  single thread; single-thread profiles are unchanged (no token). This also completes FG-052: the
  JFR parser now resolves the real `eventThread` for allocation/lock/wait events and groups by real
  thread (no hardcoded dimension buckets), with the merged default preserving the all-dimensions
  reachability.
- FG-052 JFR allocation/lock/wait events — `src/parse-jfr.js` (which read only `jdk.ExecutionSample`)
  now also decodes `jdk.ObjectAllocationSample`/`...InNewTLAB`/`...OutsideTLAB` (bytes →
  `alloc_bytes`), `jdk.JavaMonitorEnter`/`Wait`, and `jdk.ThreadPark` (duration → `monitor_nanos`/
  `park_nanos`), each resolved by name from the chunk metadata. All events are unified into one
  time-sorted sample stream with a sparse weight column per dimension (a sample's own dimension
  non-zero, 0 in the others), so the weight token cycles CPU ↔ allocations ↔ wait and the flame
  re-aggregates per dimension — reusing the FG-046 byte / FG-048 time formatters. A CPU-only
  recording is unchanged.
- FG-051 Call graph view — a third view type (after flame and radial): a weighted directed graph
  of the call structure (nodes = functions sized/colored by weight, edges = caller→callee scaled
  by cost). Built in five phases: `src/callgraph.js` folds the CallNodeTable into a function-level
  digraph (recursion → self-edges); `src/callgraph-layout.js` is a zero-dep Sugiyama-style layout
  (cycle-break → longest-path ranks → barycenter ordering, deterministic); `src/view-callgraph.js`
  (`GraphView extends BaseView` — the FG-038 seam, zero shared-context changes) renders nodes +
  edges with pan/zoom, hover-neighborhood highlight, double-click focus-subgraph, and weight-
  pruning (disclosed). Wired into the view-type cycle (⌘K → "View: Call graph"). Aggregated only;
  render-time (golden/bench unchanged). The layout's ranking, cycle-breaking, and `_hit`-under-
  transform were each independently verified.
- FG-044 Source-map remapping — transpiled/bundled profiles can be mapped back to original
  source. `src/sourcemap.js` is a pure Source Map v3 decoder (base64-VLQ `mappings` →
  `lookup(line, col)`, independently verified against the spec's canonical example) plus
  `remapProfile(profile, maps)`, which rewrites each frame's name/file/line generated→original
  (matched by generated-file basename) and re-interns a new profile, leaving weights/stacks
  intact. `.map` files load by drag-drop / picker; embedded `sourcesContent` feeds the FG-030
  source-line view (original source with no separate drop). Labels, color/grouping, and search
  then operate on original names. Profiles with no maps are unchanged.
- FG-046 First-class allocation/heap profiles — allocation profiles (multiple value types incl.
  a bytes metric) are now a verified, covered path: the weight token cycles `alloc_bytes` ↔
  `alloc_objects`, byte-valued weights format as KB/MB/GB in the total and the Markdown report
  (counts stay counts), and a synthesized `alloc-heap` Scene preset round-trips through pprof +
  OTLP in the golden suite. Bundled as a "heap" sample for discovery.
- FG-048 Weight unit/label for non-sample profiles — a profile's weight can be relabeled to what
  it actually means, so a wait-time (off-CPU) or byte-valued folded profile reads in µs/ms/s or
  bytes instead of "samples". `parseFoldedText(text, opts)` accepts a value-type hint, and ⌘K →
  "Weight unit: …" relabels the active weight (renamed across `weightsByType`/`capabilities`/the
  weight token, numbers untouched) so `_fmtWeight` picks the right formatter everywhere. Guards
  against relabeling to a name that already exists on a multi-value profile.
- FG-050 Interactive call stack — the detail slide-over's stack trace is now navigable: each row
  carries its call-node (graph) or function (chart/sandwich) identity, and clicking an ancestor
  selects it (new `BaseView.selectNode`, sibling of `selectFunc`) — outlining its instances and
  refreshing the panel — while a modifier-click focuses/zooms it via the per-view focus path.
  Chart/sandwich rows degrade to function-select. No layout change; the All-Instances aggregate
  stays correct.
- FG-049 Function list panel — an on-demand sortable table of every function (self · total ·
  `file:line`), summoned from ⌘K or a status-strip token, with a substring/regex filter, header
  sort, and a disclosed row cap. Backed by the shared `functionStats`. A row click selects the
  function (outlines all instances + opens the detail slide-over) via a new `BaseView.selectFunc`;
  a per-row action sandwiches it — both through the existing public methods, no duplicated logic.
- FG-045 Markdown hotspot report export — Export → "Markdown report" writes a portable
  `.md`: a metadata header (weight type + unit · total · counts), a ranked **Top functions**
  table (self/total, value + %, `file:line`, units-aware), and a **Hottest stacks** section.
  Backed by a new pure `src/funcstats.js` (`functionStats(ct, profile)`) that computes per-
  function self + recursion-safe once-per-sample total for every function in one pass — shared
  with the upcoming function-list panel.
- FG-047 Native profiles group by shared object — `src/parse-perf.js` now keeps the DSO/binary
  it parses from each `perf script` frame (it used to discard it) and stores it as the func's
  file, so `packageOf` colors and groups native C frames by binary (the main executable vs
  `libc` vs `kernel`). Extends "color = module" to native code, where the symbol name carries no
  package. Same-named symbols in different binaries are now distinct funcs.

## M3.5 — UI reshape: chrome-less, full-bleed, context-driven

The viewer stopped looking like a speedscope clone: full-bleed data, controls summoned on
demand, a persistent status strip. Governing rule for the phase — hide *controls*, never
*state* (mode/weight/diff stay legible at all times).

- FG-034 Full-bleed canvas + persistent status strip. Canvas fills the stage; one bottom
  strip shows mode · weight · diff · file · nodes · total, with click-to-change tokens.
  Detail became an on-demand slide-over via a new `FlameView` `onSelect` callback.
- FG-035 Right-click frame context menu + view action API. `contextmenu` → Focus subtree ·
  Sandwich this · Search this frame · Copy stack, routed through named public methods on the
  views (`focusNode`/`sandwichFunc`/`frameStack`/`frameLabel`) so the menu and palette share
  one API instead of duplicating logic.
- FG-036 Command palette (⌘K) + floating search (⌘F). Every former-toolbar command moved into
  a fuzzy-filtered palette; search moved into a floating pill; `1/2/3` modes, `c` collapse,
  Esc dismiss.
- FG-037 On-demand detail slide-over + legend/help overlays. No permanent detail/hint/legend
  bands; legend, a `?` help overlay, and a first-run coachmark are summoned on demand.
- FG-038 Decouple renderer into `BaseView` (view-type-agnostic context) + `FlameView`
  (rectangular geometry). Shell has a `VIEWS` registry keyed by view type.
  Decision: events stay view-owned, not controller-routed — revisited when radial landed and
  still held, so new view types own their own listeners.
- FG-039 Radial (sunburst) view — the first alternative view type. ~120 lines reusing the
  same `layout()` with `width = 2π`; validated the FG-038 interface with zero shared-context
  changes.
- FG-040 Ghostty theme import + color engine. Parser + 552-theme vendored roster
  (`src/theme.js` + `themes.js`), OKLCH-degrade engine in `colors.js`, CSS-var + canvas token
  routing, ⌘K picker, localStorage persistence. Upstream provenance is in
  [`THIRD_PARTY.md`](./THIRD_PARTY.md).

## M3 — Interaction parity (minimap, detail, diff, export)

- FG-019 Minimap / draggable crop, per mode — time window in Timeline, value-fraction window
  in Aggregated, none in Sandwich.
- FG-020 Detail panel: This Instance / All Instances / stack trace. The All-Instances
  aggregate is recursion-aware (a function on the stack is counted once per sample).
- FG-021 Export — speedscope JSON, folded, and an SVG snapshot, all from the canonical model.
- FG-022 View naming: Timeline / Aggregated / Sandwich.
  Decision: deliberately *not* speedscope's "Time Order / Left Heavy" vocabulary — Aggregated
  is a true aggregation and the names match the semantics.
- FG-023 Diff / comparison view. `buildDiff(A,B)` merges call trees by function-name path,
  normalizes to fractions, emits a layout-compatible table with per-node `delta`; red marks
  regressions, blue improvements. (speedscope has no equivalent.)
- FG-024 Scale benchmark + viewport virtualization analysis. Drawn boxes stay ~600–1000 from
  10k→1M samples because sub-pixel pruning caps them at ≈ width×depth.
  Decision: draw cost is viewport-bounded, not N-bounded, so no virtualization is needed for
  the MVP range; vertical row-virtualization is deferred to >~1000-deep stacks (see
  `docs/architecture.md`).

## M2 — Promotion to `src/` + in-browser ingestion

- FG-016 Zero-build layout: app ES modules + `index.html` in `src/` (run directly in the
  browser, no bundler/deps); Node harness, fixtures, generators in `test/` importing `../src/`.
- FG-017 In-browser file-drop ingestion. Parsers split into pure cores (bytes/text → model) +
  thin Node wrappers; `ingest.js` gunzips via `DecompressionStream` and detects format by
  extension + content sniff. Nothing is uploaded.
- FG-018 Evented speedscope parser — `O`/`C` events reconstructed into per-interval timed
  samples.

## M1 — The spike: model + parsers + renderer + views + test data

The foundation, validated against real Go pprof and V8 `.cpuprofile` data plus the golden
corpus. The canonical model and the clean-dense render combination (borderless · row rhythm ·
semantic color · labels-where-fit · path highlight · auto-collapse) landed here.

- FG-001 Canonical data model — interned structure-of-arrays + a prefix-tree for stacks;
  aggregation at render time. Spec + invariants in `docs/architecture.md`.
- FG-002 / FG-003 / FG-004 / FG-005 Parsers: pprof (hand-rolled protobuf, multi-value),
  V8 `.cpuprofile`, folded/collapsed, speedscope (sampled + evented).
- FG-006 … FG-014 Renderer + views: Canvas flame graph, flame chart (Timeline), auto-collapse
  of boring single-child chains, regex search + dim, sandwich (caller/callee), semantic color
  by package, hover path highlight, click-to-zoom, value-type selector.
- FG-015 Test data: one Scene → four emitters → golden round-trips.

## M4 — Point-at-sources (in progress)

The differentiating layer — making spicypath not file-only. Remaining M4 work is tracked in
[GitHub issues](https://github.com/INTENTIUS/spicypath/issues?q=is%3Aopen+milestone%3AM4).

- FG-025 Metrics coupling — metric track lanes (CPU/RAM/… time-series) locked to the Timeline
  time axis, with bidirectional hover and brush re-aggregation. Hovering a lane lights the call
  stack active at that instant; hovering a frame bands its time span across the lanes. Brushing a
  time range on a lane (`src/metrics-window.js` `aggregateWindow`, half-open `[t0,t1)`) surfaces
  the functions that dominated that window and highlights them in the flame. `Profile.metrics`
  carries the series; `window.__app.setMetrics()` injects synthesized ones for tests. Chart-mode
  only; additive (golden/bench untouched). Shipped in three passes (tracks → hover → brush).
  _Deferred: a graph-mode weight selector and per-frame correlation-coefficient coloring._
- FG-030 Source-line view — `src/sourceline.js` aggregates per-line self/total weight for a
  selected function (recursion-safe: a line of `f` on the stack at multiple depths counts once
  per sample; callee lines never leak into `f`). Drop source files (or "Load source files…" in
  ⌘K) and a selected function's source renders with a per-line weight gutter + heat shading;
  source is matched locally by basename and never uploaded. The panel is opt-in — it stays
  hidden until source is loaded — and shows a clear "source not loaded" state otherwise.
- FG-029 Persisted shareable links — view state (view type · mode · weight · search · zoom/
  focal · crop) is encoded into `location.hash` (`history.replaceState`, debounced) and
  restored on load. Focus is stored as a stable root→leaf name path and re-resolved after
  rebuild, not as a volatile node index. Tier A source addressing: links to a bundled sample
  or a live `/debug/pprof` URL reopen the same data; a link whose source was a dropped local
  file degrades with a clear status message. No upload — the hash holds only state + a path/URL.
- FG-043 Open profile from URL — ⌘K → *Open from URL* fetches any supported format by URL and
  ingests it by magic/extension through the same `loadProfile` path as a dropped file (`.gz`
  handled). Errors surface in the status line without wedging the current profile. A URL source
  is re-fetchable, so it round-trips in the share-link hash (`srcType: 'url'`, distinct from a
  live `/debug/pprof` URL). CORS is the only limitation; nothing is uploaded.
- FG-031 JFR ingestion — `src/parse-jfr.js` is a native, browser-pure decoder for JDK Flight
  Recorder binaries: chunk headers → metadata schema → constant-pool checkpoints →
  `jdk.ExecutionSample` events, resolving frames to `Class.method` (type IDs resolved by name
  from metadata, not hardcoded). Per-sample timing preserved; detected by the `FLR\0` magic.
  No emitter exists for JFR, so instead of a synthetic golden round-trip, `test/parse-jfr-test.ts`
  generates a *real* recording with the local JDK (`test/gen/JfrWorkload.java`) and asserts the
  parser's hot leaf matches the `jfr` tool's oracle; it skips when no JDK is present and commits
  no binary. Cross-checked against a real third-party `.jfr` (leaf ordering matches `jfr print`
  exactly). Was deferred (🅿️); the JDK-generates-at-test-time approach removed the
  capture-only/binary-fixture blocker.
- FG-041 Gecko ingestion — `src/parse-gecko.js` reads the Firefox Profiler / `samply`
  processed-profile JSON (`meta.version` 5), handling both the raw `{schema, data}` and
  processed column-array table forms; per-sample timing is preserved (`hasTiming`, ms axis),
  weight type is `samples`. Detected by content sniff (`threads` + `meta`/`stackTable`),
  ordered ahead of the `.cpuprofile` check. Golden 48/48, ingest 50/50.
- FG-027 OTLP Profiles parser + emitter — `src/parse-otlp.js` decodes the OpenTelemetry
  profiling signal (dictionary model, `profiles/v1development`, schema pinned to
  opentelemetry-proto v1.7.0) with a hand-rolled protobuf reader and no deps; reuses the pprof
  value-type mapping for multi-value. `test/otlp-test.ts` proves the lossless `pprof ↔ OTLP`
  edge: the same payload encoded both ways parses to the identical canonical model, and a real
  `go.pprof` survives a pprof→OTLP→model round-trip. Golden 42/42, ingest 44/44.
- FG-026 perf-script parser + emitter (timed; blank-line sample blocks). Wired into golden +
  ingest, synthesized with no Linux dependency.
- FG-028 Remote source adapters — point spicypath at a live source, not just files.
  - Slice A: live `/debug/pprof` fetch (`src/fetch-pprof.js`) — a time-scoped HTTP GET feeding
    the existing pprof parser into the same load path as a dropped file.
  - Slice B: a backend-agnostic adapter interface (`src/source-adapter.js`: `{ id, label,
    fetchProfile, describe }`) with Pyroscope (`render?format=pprof`) and Parca (Connect-JSON
    `{pprof: base64}` envelope) query adapters, all reusing `parsePprofBytes`. A source picker
    in the shell (backend + query + time range, with per-backend epoch units) routes every
    result through the same load path; the live token + refetch re-run the same adapter. Driven
    in tests by mock Pyroscope/Parca endpoints. _Live-tail streaming deferred._
- FG-032 Real-browser test harness — `test/browser.ts` drives the system Chrome over the
  DevTools Protocol using only Node built-ins (no selenium/puppeteer), asserting computed
  layout and state.
- FG-033 Viewport interaction parity — contained vertical scroll, ⌘/Ctrl-wheel zoom about the
  cursor, synced minimap↔content crosshair, draggable scrollbar, Esc reset.
