# Local-markdown tracker — wayfinding operations

No hosted issue tracker is configured for this repo, so the map and its tickets
live here as markdown. This file is the tracker doc: it defines how the map,
child tickets, blocking, and frontier queries are expressed.

## Layout

```
.wayfinder/
  README.md        this file — tracker conventions
  map.md           the map (label: wayfinder:map)
  frontier.sh      frontier query
  tickets/         child issues of the map
    NNN-slug.md
```

## Ticket format

Every ticket is one file with YAML frontmatter and a `## Question` body.

```markdown
---
id: "004"
title: Choose the session <-> Telegram surface model
type: prototype          # research | prototype | grilling | task
status: open             # open | closed
assignee: null           # a name here IS the claim
blocked_by: ["002"]      # ids that must be closed first
---

## Question

<the decision or investigation this ticket resolves>
```

- **Identity** is the `id`. **Name** is the `title` — always refer to tickets by
  title in anything a human reads.
- **Claiming**: set `assignee` before doing any work, so concurrent sessions skip it.
- **Blocking**: `blocked_by` lists ids. A ticket is unblocked when every id in it
  has `status: closed`.
- **Resolution**: append a `## Resolution` section to the ticket body, set
  `status: closed`, then add a one-line pointer to the map's Decisions-so-far.
- **Assets** (prototypes, research notes) are linked from the ticket, not pasted in.

## Frontier query

The frontier is the open, unblocked, unclaimed tickets — the edge of the known.

```bash
.wayfinder/frontier.sh
```
