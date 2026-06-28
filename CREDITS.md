# Credits & acknowledgements

spicypath is released under the [MIT License](./LICENSE). It stands on a lot of prior
art. Nothing below is copied code — these are the projects and people whose formats,
data-model ideas, rendering techniques, and inspiration shaped this one.

Bundled third-party data and any assets that carry their own license are listed
separately in [`THIRD_PARTY.md`](./THIRD_PARTY.md).

## Prior art & inspiration

- **[speedscope](https://github.com/jlfwong/speedscope)** (Jamie Wong) — the interactive
  flame-graph viewer this category grew from. spicypath reads and writes the speedscope
  file format for interoperability.
- **[Firefox Profiler](https://github.com/firefox-devtools/profiler)** (Mozilla) — the
  interned structure-of-arrays + prefix-tree data model and the "borderless via a ~1px
  background gap" rendering technique are both adapted from its approach.
- **[Brendan Gregg](https://www.brendangregg.com/flamegraphs.html)** — the flame graph
  itself, and the original FlameGraph tooling.
- **[Grafana](https://github.com/grafana/grafana)** — the auto-collapse heuristic for
  near-equal-weight single-child chains.

## Color themes

The full corpus of color schemes in `src/themes.js` is vendored from
**[iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)** (MIT), the
collection bundled by the [Ghostty](https://ghostty.org) terminal. Individual theme
families (Catppuccin, Dracula, Tokyo Night, Nord, Gruvbox, and others) are the work of
their respective authors and carry their own licenses; the attribution model and bundled
license are detailed in [`THIRD_PARTY.md`](./THIRD_PARTY.md).

## "Vaus mode" (easter egg)

The optional brick-breaker mode (roadmap FG-042) is an affectionate homage to
**Taito's *Arkanoid*** (1986). spicypath is not affiliated with or endorsed by Taito;
"Arkanoid" and "Vaus" are their trademarks, used here only to reference the game being
parodied.
