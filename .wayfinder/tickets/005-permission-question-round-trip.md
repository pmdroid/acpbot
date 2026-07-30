---
id: "005"
title: Design the permission and question round-trip
type: prototype
status: open
assignee: null
blocked_by: ["001", "003", "004"]
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
   the rest of this session", a scoped always-allow? Does that live in tacp or in
   acpx's policy layer? (Depends on what the acpx probe found.)
3. **The unanswered case.** The central question. If the operator does not reply
   for an hour, what happens — does the turn simply hang, is there a timeout with
   a default action, does the agent get cancelled, is there a nudge? State the
   chosen policy *and* what the operator sees when they finally return.
4. **Restart mid-flight.** tacp goes down holding an unanswered prompt. On restart,
   is the prompt re-offered, abandoned, or is the whole turn re-run? What makes
   the stale inline keyboard in the old message safe to ignore?
5. **Questions vs. permissions.** Depending on the ACP research: if clarifying
   questions are not a protocol primitive, decide whether tacp attempts to detect
   them, or whether the operator simply replies to a finished turn like any other
   prompt. Do not invent a protocol feature that does not exist.
6. **Wrong-session safety.** Given the surface model, what stops an approval
   landing on the wrong session's request.

Prototype the message flow concretely — the actual text and buttons of a
permission request, an approval, a timeout, and a restart-recovery — and link it
as an asset. Judge the design against the scenario where the operator is on a
phone, distracted, and has two agents running.
