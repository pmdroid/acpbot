---
name: computer
description: >
  Isolated Playwright browser on this topic's acp-host: navigate, screenshot,
  click, type. Use when the operator granted /computer on and you need to see
  or drive a web UI. Desktop is never captured.
---

# Computer use (isolated browser)

You drive **this topic’s isolated Chromium** on the session’s **acp-host** — not
the operator’s desktop, and not the worker laptop. Multi-host: if the repo is
bound to `studio`, you drive **studio’s** browser.

**Required:** the operator must send `/computer on` (or Watch). Without a grant,
every `computer_*` tool fails closed. `[computer].enabled` must also be true on
that host.

The desktop is **never** captured. Click / type / key work **only** inside this
browser.

Host MCP server: **`acpbot`**. Call tools by name (clients may show them as
`acpbot__computer_screenshot`).

## Typical loop

```
computer_navigate({ url: "https://…" })
computer_screenshot({})
computer_click({ x, y })
computer_type({ text: "…" })
computer_screenshot({})
```

First action after grant if no page yet: **navigate** (or screenshot a blank
“no page” JPEG). URLs must be `http`/`https`.

Coordinates are the downsampled viewport JPEG (`frameId`). If navigation or
size changed since `frameId`, the host aborts with `stale_frame` — screenshot
again.

## Tool map

| Tool | When |
|------|------|
| **`computer_navigate`** | Open a URL (first step if no page) |
| **`computer_screenshot`** | See the viewport; same JPEG goes to Telegram |
| **`computer_click`** / **`move`** / **`drag`** / **`scroll`** | Pointer inside the viewport |
| **`computer_type`** / **`computer_key`** | Type into whatever is focused in the browser |
| **`computer_status`** | Grant / budget / backend / last frame |

Prefer **`update`** for progress text. Frames already land in Telegram via the
supervisor — do **not** also `telegram_send_photo` the same bitmap, and do not
dump pixels into `update`.

## Operator grants (for your awareness)

| Operator | Effect |
|----------|--------|
| `/computer on` | Grant this topic (TTL). You may drive the isolated browser. |
| `/computer watch` | Grant + periodic frames while a turn is running |
| `/computer off` | Revoke grant; **the coding turn continues** |
| `/cancel` | Abort the turn **and revoke the grant** (panic) |
| `/steer` | Interrupt the turn; **grant remains** |
| `/fresh` | New session; grant revoked |

If a tool says `no_grant` / `disabled` / `no_owner`, tell the operator to
`/computer on` on this topic (and that the host needs `[computer].enabled`).
Do not invent a desktop screenshot fallback.

## Threat (operator is watching)

This browser is isolated (fresh profile, no operator cookies) — but it can
still **open banking URLs, paste passwords, and submit forms**. The operator
sees every frame. Do not visit secrets or type credentials unless they
explicitly asked.

## Do not

- Claim you can see or click the **desktop** / login session
- Call `computer_*` from a schedule or EVE turn (those are `bad_source`)
- Mention filesystem paths for frames (there are none)
