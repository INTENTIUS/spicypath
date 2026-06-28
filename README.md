# spicypath

**Inspect any profile.** A fast, zero-build, offline profile inspector that runs in the
browser. Drop in a profile and explore it as a flame graph, a timeline, a sandwich
(caller/callee), or a radial view — with search, semantic color, auto-collapse, and
profile diffing.

- **No build, no dependencies.** Plain ES modules and a single Canvas 2D renderer; open it
  and it runs. Nothing is uploaded — parsing happens locally.
- **Reads common formats:** folded/collapsed, pprof, V8 `.cpuprofile`, speedscope
  (sampled + evented), and `perf script`. See [`docs/formats.md`](./docs/formats.md).
- **Views:** Timeline (flame chart) · Aggregated (flame graph) · Sandwich · Radial,
  plus a diff/comparison mode.

## Quickstart

Serve the `src/` directory and open it in a browser:

```sh
cd src
python3 -m http.server
# then open http://localhost:8000
```

A sample profile loads on start. Drag a profile onto the window (or use the file picker)
to open your own; `.gz` is decompressed automatically.

## Usage

- **Switch views** between Timeline, Aggregated, Sandwich, and Radial. Timeline is
  available only for profiles that carry per-sample timing.
- **Search** (regex) dims non-matching frames.
- **Zoom** by double-clicking a frame or span; **Esc** resets.
- **Diff** two profiles with *compare* — red marks regressions, blue improvements.
- **Export** the current profile as `.speedscope.json`, `.folded`, or an `.svg` snapshot.

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — the canonical data model and the
  rendering design principles.
- [`docs/formats.md`](./docs/formats.md) — supported input/export formats and how to add a
  parser.
- [`ROADMAP.md`](./ROADMAP.md) — planned work.

## Development

The app lives in `src/` (ES modules, no build step). The test harness lives in `test/`
and imports the same parser/renderer cores, run with Node (TypeScript type-stripping;
Node 23.6+ runs the `.ts` entry points directly):

```sh
node test/run.ts          # data-model validation
node test/golden.ts       # parse → model → re-emit round-trips
node test/ingest-test.ts  # format detection + ingestion
node test/export-test.ts  # export → re-import stability
node test/diff-test.ts    # diff math
node test/bench.ts         # scale benchmark
node test/browser.ts      # real-Chrome interaction checks (CDP)
```

## License

MIT — see [`LICENSE`](./LICENSE). Prior-art acknowledgements are in
[`CREDITS.md`](./CREDITS.md); bundled third-party assets and their licenses are in
[`THIRD_PARTY.md`](./THIRD_PARTY.md).
