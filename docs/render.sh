#!/usr/bin/env bash
#
# Render every Graphviz .dot file in ./diagrams/ to SVG (default) and/or PNG.
#
# Usage:
#   ./render.sh            # render all diagrams to SVG
#   ./render.sh svg        # same
#   ./render.sh png        # render to PNG instead
#   ./render.sh all        # render to both SVG and PNG
#
# Requires Graphviz:  brew install graphviz   (macOS)
#                     apt-get install graphviz (Debian/Ubuntu)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIAGRAMS_DIR="${HERE}/diagrams"

if ! command -v dot >/dev/null 2>&1; then
  echo "error: graphviz 'dot' not found on PATH." >&2
  echo "       install it with:  brew install graphviz   (or)   apt-get install graphviz" >&2
  exit 1
fi

case "${1:-svg}" in
  svg) formats=(svg) ;;
  png) formats=(png) ;;
  all) formats=(svg png) ;;
  *)   echo "usage: $0 [svg|png|all]" >&2; exit 2 ;;
esac

shopt -s nullglob
dot_files=("${DIAGRAMS_DIR}"/*.dot)
if (( ${#dot_files[@]} == 0 )); then
  echo "error: no .dot files found in ${DIAGRAMS_DIR}" >&2
  exit 1
fi

echo "graphviz: $(dot -V 2>&1)"
for fmt in "${formats[@]}"; do
  for f in "${dot_files[@]}"; do
    out="${f%.dot}.${fmt}"
    printf 'rendering  %-28s -> %s\n' "$(basename "$f")" "$(basename "$out")"
    dot -T"$fmt" "$f" -o "$out"
  done
done

echo "done. output written to ${DIAGRAMS_DIR}/"
