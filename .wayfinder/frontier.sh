#!/usr/bin/env bash
# Frontier: open, unblocked, unclaimed tickets — the edge of the known.
# Usage: .wayfinder/frontier.sh [--all]
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tickets"

field() { sed -n "s/^$2: *//p" "$1" | head -1 | tr -d '"'; }

status_of() {
  local id="$1" f
  for f in "$dir"/*.md; do
    [ "$(field "$f" id)" = "$id" ] && { field "$f" status; return; }
  done
  echo missing
}

for f in "$dir"/*.md; do
  [ -e "$f" ] || continue
  status=$(field "$f" status)
  [ "$status" = open ] || continue

  assignee=$(field "$f" assignee)
  blockers=$(sed -n 's/^blocked_by: *//p' "$f" | head -1 | tr -d '[]"' | tr ',' ' ')

  blocked=""
  for b in $blockers; do
    [ -n "$b" ] || continue
    [ "$(status_of "$b")" != closed ] && blocked="$blocked $b"
  done

  if [ -n "$blocked" ]; then
    [ "${1:-}" = --all ] && printf 'BLOCKED   %s  [%s]  (waiting on:%s)\n' \
      "$(field "$f" id)" "$(field "$f" type)" "$blocked"
  elif [ "$assignee" != null ] && [ -n "$assignee" ]; then
    [ "${1:-}" = --all ] && printf 'CLAIMED   %s  [%s]  %s  (%s)\n' \
      "$(field "$f" id)" "$(field "$f" type)" "$(field "$f" title)" "$assignee"
  else
    printf 'FRONTIER  %s  [%s]  %s\n' \
      "$(field "$f" id)" "$(field "$f" type)" "$(field "$f" title)"
  fi
done
