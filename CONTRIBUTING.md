# Contributing

spicypath is zero-build and offline: plain ES modules in `src/`, a single Canvas-2D renderer,
no bundler and no runtime dependencies. The Node test harness in `test/` imports the same cores
and runs under Node 23.6+ (which strips TypeScript). Keep both of those constraints — code that
needs a build step or a dependency doesn't fit.

## Where things live

- `src/` — the app. Parser cores (`parse-*.js`), the model (`model.js`), the renderer
  (`render-canvas.js` = `BaseView` + `FlameView`; `view-radial.js`), the shell (`index.html`).
- `test/` — the harness: golden round-trips, ingest/export/diff checks, the scale benchmark,
  and the real-Chrome interaction suite (`browser.ts`). See [`test/README.md`](./test/README.md).
- `docs/` — [`architecture.md`](./docs/architecture.md) (model + render principles) and
  [`formats.md`](./docs/formats.md) (supported formats + how to add a parser).

Run the suite from the repo root: `node test/run.ts`, `node test/golden.ts`,
`node test/ingest-test.ts`, `node test/export-test.ts`, `node test/diff-test.ts`,
`node test/sandwich-test.ts`, `node test/bench.ts`, `node test/browser.ts`.

## Issue conventions

Work is tracked in [GitHub issues](https://github.com/INTENTIUS/spicypath/issues). Shipped work
is in [`CHANGELOG.md`](./CHANGELOG.md).

- **`FG-NNN` ids** are stable and carry into issue titles (e.g. `FG-027 · OTLP Profiles
  parser`). They predate the issue tracker; keep using the next free number for new work.
- **Priority labels:** `priority:P2` (later / core-adjacent), `priority:P3` (someday). P0/P1
  were the spike-era blockers and core — there are none open.
- **Area labels:** `area:parser`, `area:ui`, `area:renderer`, `area:infra`.
- **`deferred`** marks parked work that isn't scheduled (e.g. JFR ingestion).
- **Milestones:** `M4` (point-at-sources) is the active milestone; earlier milestones (M0–M3.5)
  are complete and recorded in the changelog.

## Adding a parser or a view

- A parser is a pure core `src/parse-<fmt>.js` (bytes/text in → canonical model out, no Node
  APIs) built with `ProfileBuilder` from `src/model.js`, a thin Node wrapper `test/parse-<fmt>.ts`,
  an emitter under `test/emit/`, registration in `src/ingest.js`, and a row in `test/golden.ts`.
  The full recipe is in [`docs/formats.md`](./docs/formats.md).
- A view extends `BaseView` and supplies its own geometry (`relayout`/`draw`/`_hit`) +
  interaction, owns its listeners, and disposes them on rebuild. `RadialView` (~120 lines) is
  the reference. Register it in the shell's `VIEWS` map in `src/index.html`.

## Design lines to respect

- Width is sacred: x-extent is the metric; never restyle width. See
  [`docs/architecture.md`](./docs/architecture.md).
- Hide controls, never state: chrome is on demand, but mode/weight/diff stay visible.
- Nothing is uploaded by default: parsing is local; any network fetch is an explicit user action.
