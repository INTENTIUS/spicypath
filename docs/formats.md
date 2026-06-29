# Supported formats

Inputs are detected by extension and a content sniff, gunzipped transparently
(`.gz` via `DecompressionStream`), and normalized into the canonical model described in
[`architecture.md`](./architecture.md). Nothing is uploaded — parsing happens in the
browser (or in Node for the test harness).

## Input formats

| Format | Extension(s) | Plane | Multi-value | Notes |
|---|---|---|---|---|
| **folded / collapsed** | `.folded`, `.txt` | aggregated | — | `a;b;c 42` lines; the lowest common denominator |
| **pprof** | `.pprof`, `.pb.gz` | aggregated | ✅ | protobuf; keeps all sample value types |
| **V8 `.cpuprofile`** | `.cpuprofile` | time-ordered | — | Chrome / Node CPU profile; per-sample timing reconstructed from the node tree + `timeDeltas` |
| **speedscope** | `.speedscope.json` | time-ordered | — | both `sampled` and `evented` variants; evented `O`/`C` events are reconstructed into per-interval timed samples |
| **perf script** | `.perf`, `.txt` | time-ordered | ⚠️ | `perf script` text output; blank-line-separated sample blocks |
| **OTLP Profiles** | `.otlp` | aggregated | ✅ | OpenTelemetry profiling signal (`profiles/v1development`, protobuf); shares the pprof value-type mapping. Lossless `pprof ↔ OTLP` in our model |

"Plane" is whether per-sample timing survives. Aggregated formats carry no timestamps, so
the time-ordered flame chart is unavailable for them (the chart tab hides itself when
`hasTiming` is false — see [`architecture.md`](./architecture.md)).

### Planned

- **Gecko** — the Firefox Profiler / `samply` JSON; per-sample, time-ordered.
- **JFR** — JVM Flight Recorder (binary, JVM-only); deferred.

## Export formats

The loaded profile can be saved as:

- `.speedscope.json` — re-importable by this viewer and by speedscope.
- `.folded` — the universal lowest-common-denominator text.
- `.svg` — a static flame-graph snapshot of the current view.

## Adding a parser

1. Write a pure core `src/parse-<format>.js` that takes bytes or text and returns the
   canonical model via `ProfileBuilder` (see `src/model.js`). Keep it free of Node APIs so
   it runs in the browser unchanged.
2. Register detection in `src/ingest.js` — an extension match plus a content sniff.
3. Add a fixture and an emitter under `test/` and wire it into the golden round-trip suite
   so `parse → model → re-emit` stays stable.

Keeping the parser core pure (bytes/text in, model out) is what lets the same code run in
the browser and under the Node test harness.
