---
id: "005"
title: Design the permission and question round-trip
type: prototype
status: open
assignee: null
blocked_by: ["001", "003", "004", "008"]
---

## Question

This is what distinguishes tacp from acpx. A terminal permission prompt blocks for
seconds with the operator watching; a chat prompt may sit unanswered for hours
while the agent's turn hangs and the repo sits half-modified.

Design the full round-trip:

1. **Presentation.** What does a permission request look like as a Telegram
   message? Enough context to decide safely — which tool, which paths, what diff —
   without becoming unreadable on a phone. Inline keyboard buttons, free-text
   reply, or both.
2. **Answer vocabulary.** Beyond yes/no: is there "approve this kind of thing for
   the rest of this session", a scoped always-allow? acpx offers
   `allow_once | allow_always | reject_once | reject_always | cancel` at its hook,
   but ACP's `optionId` set is agent-chosen and unbounded — so decide where the
   vocabulary is authored and how the two reconcile.
3. **The unanswered case.** The central question, and the research narrowed it to
   a real choice rather than an open one. Nothing in ACP or acpx will ever time a
   permission out: the spec has no deadline and acpx awaits the hook unbounded, so
   a turn hangs indefinitely by default and **any timeout is tacp's own
   invention**. Protocol-legal exits are exactly two — pick a rejection option, or
   cancel the whole turn. Decide the policy, note that cancelling is
   coarser than rejecting, and state what the operator sees when they return.
4. **Restart mid-flight.** tacp goes down holding an unanswered prompt. On restart,
   is the prompt re-offered, abandoned, or is the whole turn re-run? Telegram makes
   the *decision* recoverable — the keyboard stays live and a press queues for 24 h
   with `callback_data` intact — but `answerCallbackQuery` must be assumed to fail,
   so confirmation comes from editing the message. Note also gap G15: the two ACP
   cancellation mechanisms settle a pending permission differently (`cancelled`
   outcome vs. `-32800`), and both appear in real adapter code.
5. **Questions vs. permissions — premise corrected by the research.** Questions
   *are* a protocol primitive (`elicitation/create`), and ACP's authors
   deliberately refused to fold permissions into it, so these stay two mechanisms
   with two designs. Three decisions follow:
   - **Advertise `clientCapabilities.elicitation.form`?** Gap G2, and the
     highest-leverage call in the project: Claude *disables its question tool
     outright* unless tacp advertises it. Decide, and state what breaks either way.
   - **The prose path is unavoidable regardless.** Codex never elicits at all, and
     the spec's own prescribed fallback is to ask in turn text — which arrives as
     `agent_message_chunk` then `stopReason: "end_turn"`, byte-identical to a
     finished answer. Decide whether tacp attempts detection or simply lets the
     operator reply to a finished turn like any other prompt.
   - **No channel for "no, do it this way instead."** Gap G5: a permission
     response carries only `optionId`. Codex even labels an option *"No, provide
     feedback"* — an intent ACP cannot express. Decide how that lands in chat.

6. **Build against absent metadata.** Gap G7: `session/request_permission`
   requires only `toolCallId`; title, arguments, diff, and paths are all optional,
   and the spec's own example sends the bare id. There is no tool-name field at
   all — Claude smuggles one via `_meta`, Codex sends none. A prompt that renders
   "which tool, which paths" must correlate against the tool-call update stream,
   not read the request alone. Also G8: `optionId` is opaque and the option set is
   unbounded — never hardcode allow/deny.
7. **Wrong-session safety.** Given the surface model, what stops an approval
   landing on the wrong session's request.

Prototype the message flow concretely — the actual text and buttons of a
permission request, an approval, a timeout, and a restart-recovery — and link it
as an asset. Judge the design against the scenario where the operator is on a
phone, distracted, and has two agents running.
