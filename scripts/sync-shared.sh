#!/bin/sh
# Copies each master file in shared/ over the copies the mods hold in hooks/shared/: a mod loads
# and installs on its own, so it cannot import from outside its folder. A mod takes a shared
# file by holding a copy of it; `--check` changes nothing and fails on a copy that drifted.
set -eu
cd "$(dirname "$0")/.."

check=0
[ "${1:-}" = "--check" ] && check=1
drifted=0

for copy in */hooks/shared/*.ts; do
  [ -e "$copy" ] || continue
  master="shared/$(basename "$copy")"
  if [ ! -e "$master" ]; then
    echo "no master for $copy" >&2
    drifted=1
  elif ! cmp -s "$master" "$copy"; then
    if [ "$check" = 1 ]; then
      echo "drifted: $copy" >&2
      drifted=1
    else
      cp "$master" "$copy"
      echo "updated: $copy"
    fi
  fi
done

exit "$drifted"
