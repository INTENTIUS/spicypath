# Changelog

What has shipped in spicypath, grouped by milestone. Open and planned work lives in
[GitHub issues](https://github.com/INTENTIUS/spicypath/issues) (the `FG-NNN` ids carry over
into issue titles). Conventions are in [`CONTRIBUTING.md`](./CONTRIBUTING.md); design rationale
is in [`docs/architecture.md`](./docs/architecture.md).

Everything below predates the squashed initial commit, so individual change hashes aren't
linkable — the entries record *what* shipped and *why*, not the original commit refs.

## Enhancements (post-M4)

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
