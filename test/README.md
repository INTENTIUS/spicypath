# Data-model validation spike

Proves the canonical model ([`../docs/flamegraphs/data-model.md`](../docs/flamegraphs/data-model.md))
represents **real** data on both planes, before building the renderer. Pure TypeScript,
zero dependencies — Node 24 runs it directly.

## Run

```bash
node test/run.ts
```

## Regenerate the sample data (optional — committed fixtures already present)

```bash
mkdir -p test/data
# timed plane — a real V8 .cpuprofile
node --cpu-prof --cpu-prof-dir test/data --cpu-prof-name node.cpuprofile test/gen/cpu_work.js
# aggregated, multi-value plane — a real Go pprof (gzipped protobuf)
go run test/gen/cpu_work.go
```

## What it validates

- **`parse-pprof.ts`** — hand-rolled protobuf decode (no deps) + gunzip of a real Go CPU
  profile → exercises **multi-value** sample types and **inlining** (`Location.Line` →
  `frameTable.inlineDepth`); `hasTiming=false` ⇒ graph-only, by design.
- **`parse-cpuprofile.ts`** — V8 node-tree + `samples[]` + `timeDeltas[]` → per-sample
  `stack` + `time`; `hasTiming=true` ⇒ flame-chart-capable.
- **`model.ts` `checkInvariants`** — index bounds, acyclic prefix forest, weight-column
  lengths, monotonic time, weight-sign vs `isDiff`.

## Result (last run)

```
=== Go pprof  (aggregated, multi-value, no timing) ===
  caps   : hasTiming=false  weightTypes=[samples, cpu_nanos]  isDiff=false
  views  : graph=YES  chart=no (aggregated)  multiValue=YES
  inlined frames (inlineDepth>0): 6
  invariants: all pass ✓

=== V8 .cpuprofile  (timed → flame chart capable) ===
  caps   : hasTiming=true  weightTypes=[cpu_nanos]  isDiff=false
  views  : graph=YES  chart=YES  multiValue=no
  invariants: all pass ✓

spike PASSED ✓ — model represents both planes from real data
```

## Conclusion

The model holds against real pprof + .cpuprofile, including inlining, multi-value, deep
recursion, and runtime/GC frames. The `hasTiming` capability cleanly gates the chart.

## Renderer (first on-screen frame)

Pure **layout** (`layout.js`) is shared by a headless **SVG** paint (`render-svg.js`,
for proof/screenshots) and the **Canvas 2D** product paint (`../src/render-canvas.js`).
The app (in `../src/`) ingests files directly in the browser — no pre-baked JSON.

```bash
# headless proofs (SVGs in test/out/)
node test/verify.ts
rsvg-convert test/out/node.svg -o test/out/node.png   # optional: rasterize to view

# interactive browser app (fetch needs http, not file://)
cd src && python3 -m http.server 8080      # open http://localhost:8080/
```

The renderer implements the clean-dense combination from
[`../docs/flamegraphs/design-decisions.md`](../docs/flamegraphs/design-decisions.md):
borderless via 1px gaps, consistent row rhythm, **semantic color by package**, labels
only where they fit, sub-pixel pruning. The Canvas build adds **hover path highlight**
(ancestors + descendants lit, rest dimmed to 32%), **click-to-zoom** (focus), a tooltip,
and a **value-type selector** (e.g. pprof's `samples` vs `cpu_nanos`).

### Both views: graph and chart

- **Flame graph** (`layout.js`) — aggregated; x = merged population, left-heavy.
- **Flame chart** (`flamechart.js`) — time-ordered; x = real time, stacks **not merged**,
  built by extending boxes across consecutive samples. Available only when `hasTiming`.
  In the chart, hover lights **same-function** spans and click zooms a **time window**.

The chart makes the distinction visible: in `out/node-chart.svg` the `handleRequest` loop
appears as **many separate iterations over time**, whereas the graph merges them into one
box. The Go pprof has no per-sample time, so the chart is correctly unavailable for it.

### Auto-collapse of boring chains (graph)

A single-child chain whose child carries ≥99% of the parent's weight folds into one box
with a `+N` badge (hover lists the folded frames). Folds recursion and straight-line
call chains; nothing is lost (the weights are ~identical). Toggle in the UI (graph-only).

Density win on the real fixtures (flat → collapsed):

| fixture | boxes | maxDepth |
|---|---|---|
| Go pprof | 79 → **33** | 28 → **7** |
| V8 .cpuprofile | 45 → **19** | 34 → **12** |

See `out/go.svg` (collapsed) vs `out/go-flat.svg`.

### Search (graph + chart)

Regex with substring fallback (a plain query like `fib` is a valid regex matching
substrings). Matching functions stay lit; everything else dims to 0.3 with labels
suppressed (speedscope-style). A readout shows `N fn · X% self`. Works in both views.
Proof: `out/{go,node}-search.svg` (query `fib` → only `main.fib` lit).

### Sandwich (caller/callee)

For a focal function F, two aggregated trees built from all occurrences of F
(`sandwich.js`): **callers** (merged inverted ancestor paths, drawn flipped so F sits at
the bottom of the top panel) over a focal band over **callees** (merged subtrees below F).
Click any box to re-center on that function. Proof: `out/{go,node}-sandwich.svg`
(focal `handleRequest`: callers = the loop's ancestor chain; callees = `jsonWork` / `fib`
recursion / `hashStrings`).

Proof renders (real data): `test/out/go.png` (Go pprof — amber `main.fib` recursion,
blue `strconv.*`, slate `runtime.*`) and `test/out/node.png` (V8 — `jsonWork` / `fib` /
`hashStrings`). Both are genuine flame graphs produced by the layout the Canvas paint
uses.

## Test data — one Scene, an emitter per format, golden round-trips

Instead of N workloads in N toolchains, there is one format-neutral **Scene** (`scene.js`)
and a thin **emitter per format** (`emit/*.js`). The golden runner (`golden.ts`) emits each
preset Scene into every format, parses it back, and asserts the call-tree distribution
survived — so the emitters double as a **parser test oracle**.

```bash
node test/golden.ts     # → writes test/testdata/* and checks every round-trip
node test/theme-test.ts # → Ghostty theme parser + vendored roster + OKLCH round-trip
node test/color-test.ts # → theme-driven package coloring (distinct/stable) + diff colors
node test/make-themes.ts # (dev) re-vendor src/themes.js from the iTerm2-Color-Schemes corpus
```

- **Formats:** folded · speedscope JSON · V8 .cpuprofile · pprof (uncompressed protobuf,
  hand-rolled encoder). Each has a matching parser (`parse-*.ts`).
- **Presets (`PRESETS`):** tiny · deep-recursion · wide-fanout · multi-value · unicode ·
  scale-5000. Comparison is by **fraction-of-total per path**, so unit differences
  (e.g. .cpuprofile µs→ns) cancel; capability checks confirm `.cpuprofile` is timed and
  pprof carries multiple value types.
- **Result:** 24/24 round-trips pass. A real finding surfaced: V8's `(root)` wrapper adds
  a synthetic top frame the other formats lack (normalized in the oracle).
- **Realness complement:** the captured `data/go.pprof` + `data/node.cpuprofile` (from the
  Go/Node workloads in `gen/`) catch real-world quirks (inlining, runtime/GC frames) that
  synthetic scenes don't.

Not yet generated (deliberately): **perf script** (synthesize later — Linux-only to
capture), **OTLP Profiles** (emitter later; schema is Alpha), **JFR** (capture-only,
never synthesize). Live sources (pprof endpoint, Pyroscope/Parca APIs) are Phase-2 mock
servers, not file generators.

## Status

Model validated and the **full view set renders on real data**: flame **graph** (with
**auto-collapse**), time-ordered flame **chart**, **sandwich** (caller/callee), plus
**search** — all sharing one pure layout boundary, in the clean-dense style. The
`combination-gap` thesis is now demonstrated in working code.

Next: **promote `test/` into a real `src/`** — proper build/serve, and in-browser
**file-drop ingestion** (refactor parsers to accept bytes/text + `DecompressionStream`
for gzip) instead of the pre-baked JSON models.
