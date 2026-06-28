# Third-party bundled assets

Files redistributed in this repository that originate elsewhere and/or carry their own
license. (Prior-art and inspiration credits that do *not* involve bundled material are in
[`CREDITS.md`](./CREDITS.md).)

## Sample profiles

Bundled under `src/samples/` (and mirrored as test fixtures) so the app has something to
show on load.

| File | Origin | License |
|---|---|---|
| `real-vertx.speedscope.json` | From [speedscope](https://github.com/jlfwong/speedscope)'s example profiles (a vert.x `perf` capture, popularized by Brendan Gregg's flame-graph examples). | MIT (speedscope) |
| `node.cpuprofile`, `multi-value.pprof`, `scale-5000.cpuprofile` | Synthesized for spicypath's test/sample corpus. | MIT (this project) |

> Confirm the exact upstream and license of `real-vertx.speedscope.json` before the first
> public release; if in doubt, replace it with a self-captured sample.

## Color themes (shipped — `src/themes.js`, roadmap FG-040)

The **full corpus of 552 color schemes** in `src/themes.js` is vendored from
[iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (MIT,
© 2011–present Mark Badolato), the collection bundled by the
[Ghostty](https://ghostty.org) terminal. The palettes are pinned to commit
[`982a5345`](https://github.com/mbadolato/iTerm2-Color-Schemes/tree/982a5345c3ac4075320598100aa4155fdf8193fd)
and regenerated with `node test/make-themes.ts`. The upstream license is bundled at
[`licenses/iTerm2-Color-Schemes-LICENSE`](./licenses/iTerm2-Color-Schemes-LICENSE).

**Per-theme attribution follows the upstream's own model** (it does not, and practically
cannot, enumerate 552 individual licenses): the collection is redistributed under its MIT
umbrella, and — quoting the bundled license verbatim — *"the copyright/license for each
individual theme belongs to the author of that theme."* The upstream repository is the
authoritative source for any individual theme's provenance and license.

Most well-known families are permissively licensed (e.g. Catppuccin, Tokyo Night, Nord,
Gruvbox, Rose Pine, Solarized — MIT; Dracula and a few others carry their own permissive
terms); a handful of the 552 are novelty/community palettes whose authorship lives only in
the upstream repo. Preserving the collection license + the per-author clause (both above)
is the same basis on which Ghostty and the upstream itself redistribute the set.
