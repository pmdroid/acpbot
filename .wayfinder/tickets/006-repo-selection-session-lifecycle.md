---
id: "006"
title: Design repo selection and session lifecycle
type: grilling
status: open
assignee: null
blocked_by: ["004"]
---

## Question

acpx scopes sessions per repo, and its CLI gets the repo for free from the shell's
cwd. A phone has no cwd. Decide how a session acquires a working directory, and
how sessions are managed over their whole life.

1. **Repo selection.** How does the operator, from a phone, say which repo a new
   session works in? A configured list of repo roots the bot offers as a keyboard?
   Free-text paths? Discovery by scanning a workspace root? Note the map's
   portability constraint: this must not hard-code local paths.
2. **Agent selection.** Same question for which agent (`codex`, `claude`, …) —
   chosen at session creation, or switchable mid-session?
3. **Creation.** What the operator types or taps to start a session, and what the
   bot needs from them before it can start one.
4. **Listing and status.** How the operator sees what sessions exist and which are
   mid-turn — and whether that is a command, a pinned message, or implicit in the
   surface model.
5. **Ending.** Cancel a running turn vs. end a session vs. delete its history.
   Three different things; decide which the operator can do and how they are
   distinguished.
6. **Survival.** What must still be true after the tacp daemon restarts, and after
   the Mac reboots. Which sessions resume automatically, which need a nudge, and
   which are simply gone. `acpx/runtime` persists its own session state — decide
   what tacp additionally owns.
7. **Limits.** Is there a cap on concurrent live sessions, and what happens at it?

Use `/grilling` and `/domain-modeling`. The output is a decided lifecycle, not
options.
