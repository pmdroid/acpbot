# tacp — implementation tickets

Vertical slices cut from [`.wayfinder/SPEC.md`](../../../.wayfinder/SPEC.md).
Distinct from `.wayfinder/tickets/`, which holds *decision* tickets — questions
whose resolution is a decision, not a build.

Work the frontier one ticket at a time with `/implement`, clearing context between
tickets. The chain here is linear: 01 → 02 → 03.

| # | Ticket | Blocked by |
|---|---|---|
| 01 | [Authenticated daemon with a working lobby](01-authenticated-daemon-lobby.md) | None |
| 02 | [Sessions become topics, and survive restart](02-sessions-become-topics.md) | 01 |
| 03 | [Live agent turns with status projection](03-live-turns-status-projection.md) | 02 |
| 04 | [Fork acpx and add the elicitation seam](04-fork-acpx-elicitation-seam.md) | None — independent |

## Why it stops at 03

The spec is partial by construction, and these three slices carry it as far as it
goes. What is missing is not oversight:

- **Session lifecycle commands** — cancel vs. end vs. delete are three different
  operations whose semantics, along with how a repo is chosen from a phone, are
  wayfinder ticket 006. Ticket 02 deliberately takes session identity as given
  rather than inventing the picker.
- **The permission round-trip** — wayfinder ticket 005, itself blocked on having a
  real bot (ticket 008). This is the feature that motivated the project, and
  nothing here builds toward it beyond leaving the hook reachable.
- **The safety boundary** — wayfinder ticket 007. Until it reports, what an agent
  can do *without* prompting the operator is unestablished.

## The one thing slicing exposed

**Output volume policy is out of scope for the map, but not optional for the
build.** You cannot emit agent output to a topic without deciding what gets
emitted. Ticket 03 is scoped to turn boundaries and status only, which defers the
question cleanly. The first ticket that wants the agent's actual text in the chat
is hard-blocked on it, and that will need to be settled as its own effort.
