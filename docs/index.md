---
title: Home
nav_order: 1
---

# spicypath

**Inspect any profile.** A fast, zero-build, offline profile inspector that runs in the
browser. Drop in a profile and explore it as a flame graph, a timeline, a sandwich
(caller/callee), or a radial view — with search, semantic color, auto-collapse, profile
diffing, and metric track coupling.

[View on GitHub](https://github.com/INTENTIUS/spicypath){: .btn .btn-primary .mr-2 }
[Changelog](https://github.com/INTENTIUS/spicypath/blob/main/CHANGELOG.md){: .btn }

---

## What it is

- **No build, no dependencies.** Plain ES modules and a single Canvas 2D renderer — open it
  and it runs. Nothing is uploaded; parsing happens locally in your browser.
- **Reads common formats:** folded/collapsed, pprof, OTLP Profiles, V8 `.cpuprofile`,
  speedscope (sampled + evented), `perf script`, Gecko (Firefox Profiler / `samply`), and
  JFR (JDK Flight Recorder). See [Formats](./formats.md).
- **Views:** Timeline (flame chart) · Aggregated (flame graph) · Sandwich · Radial, plus a
  diff/comparison mode.

It inspects profiles you point it at. It is deliberately **not** a dashboard, not a Grafana
panel plugin, and it does not own collection or storage — those are permanent non-goals.

## Documentation

- **[Architecture](./architecture.md)** — the canonical data model and the rendering design
  principles (width is sacred · borderless · semantic color · scale via "draw less").
- **[Formats](./formats.md)** — every supported input/export format and how to add a parser.
- **[Changelog](https://github.com/INTENTIUS/spicypath/blob/main/CHANGELOG.md)** — what has
  shipped, by milestone.
- **[Contributing](https://github.com/INTENTIUS/spicypath/blob/main/CONTRIBUTING.md)** —
  conventions and how to add a parser or view.

## Run it

Serve the `src/` directory and open it in a browser:

```sh
cd src
python3 -m http.server
# then open http://localhost:8000
```

A sample profile loads on start. Drop a profile onto the window (or **⌘K → Open profile**)
to open your own; **⌘K → Open from URL** fetches one by link; **⌘K → Connect to a profile
source** pulls from a live `/debug/pprof`, Pyroscope, or Parca backend.
