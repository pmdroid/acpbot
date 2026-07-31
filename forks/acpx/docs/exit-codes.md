---
title: Exit codes
description: Stable acpx exit codes for scripting — success, runtime errors, usage errors, timeouts, no-session, permission denial, and interrupts.
---

`acpx` uses a small, stable set of exit codes so wrapping scripts can branch on them.

| Code  | Meaning                                                             |
| ----- | ------------------------------------------------------------------- |
| `0`   | Success                                                             |
| `1`   | Agent / protocol / runtime error                                    |
| `2`   | CLI usage error (bad flags, conflicting flags, malformed `--agent`) |
| `3`   | Timeout (`--timeout` exceeded)                                      |
| `4`   | No session found (prompt requires an explicit `sessions new`)       |
| `5`   | Permission denied (every request denied/cancelled, none approved)   |
| `130` | Interrupted (`SIGINT` / `SIGTERM`)                                  |

## Notes

- **`0`** is also returned by `cancel` when there is nothing to cancel. The text/JSON output makes the distinction.
- **`1`** is the catch-all for adapter errors, transport failures, and unexpected runtime errors. Stderr or the JSON error envelope contains details.
- **`2`** signals "you typed something `acpx` cannot run" — combining `--agent` with a positional agent token, mutually exclusive permission flags, missing required arguments, etc.
- **`3`** is reserved for `--timeout` expiry. Adapter-side timeouts that are not surfaced as `acpx` timeouts come through as `1`.
- **`4`** is the "directory walk found no active session" signal. Run `sessions new` (or `sessions ensure` for idempotent scripts) and retry.
- **`5`** only fires when at least one permission request happened, and every one ended in a denial or cancellation. If at least one was approved, the result reflects whatever the agent returned.
- **`130`** matches the conventional shell signal exit code for `Ctrl+C` (`128 + SIGINT`). `acpx` cancels cooperatively before exiting with this code.

## Branching example

```bash
if acpx --format quiet codex 'one-line summary' >summary.txt; then
  echo "ok"
else
  case $? in
    2)   echo "usage error" ;;
    3)   echo "timed out"   ;;
    4)   echo "no session — run sessions new"; acpx codex sessions new ;;
    5)   echo "all denied"  ;;
    130) echo "interrupted" ;;
    *)   echo "agent or runtime error" ;;
  esac
fi
```

## See also

- [Permissions](permissions.md) — what makes exit `5` happen.
- [Sessions](sessions.md) — what makes exit `4` happen and how to fix it.
- [Prompting](prompting.md) — `--timeout` and `--no-wait` semantics.
