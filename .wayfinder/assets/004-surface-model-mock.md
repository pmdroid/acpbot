# Surface model mock — one topic per session, private chat

Prototype asset for [Choose the session-to-Telegram surface model](../tickets/004-session-surface-model.md).
Throwaway artifact to react to, not a design document and not the start of an
implementation. Renders the scenario the ticket demanded: **two sessions in
different repos, one asking permission while the other streams, and the operator
switching between them.**

---

## 1. The topic list — what a glance costs you

This is the whole point of the model. The operator opens Telegram and, without
entering anything, knows which session wants them.

```
Chat with @tacp_bot                     [topics]

  ❓ acpx/reconnect-bug        WAITING ON YOU      14:22
  ▶  tacp/auth-refactor        running             14:21
  ⏸  dotfiles/cleanup          idle                11:04
  ✓  tacp/bump-deps            done                Mon
  ✕  acpx/flaky-test           failed              Sun

  #  (root — lobby)
```

Telegram sorts by last activity, so live and blocked work floats without tacp
managing order. Finished sessions sink on their own.

Status is carried in the **topic name**, rewritten via `editForumTopic` on each
transition. The name is the reliable channel — 128 chars, plain unicode — because
custom icons need ids from `getForumTopicIconStickers`.

---

## 2. Creating a session — the lobby

Agent output never appears in root. Root is where you go when no session is
selected.

```
#  root                                            14:19

  you   /new

  bot   Which repo?
        [ tacp ]  [ acpx ]  [ dotfiles ]  [ other… ]

  you   [ acpx ]

  bot   Name this session?
        (or tap to reuse a name)
        [ reconnect-bug ]  [ scratch ]

  you   reconnect-bug

  bot   Created ▶ acpx/reconnect-bug — opening topic.
        └─ tap to jump
```

> The repo picker's *content* — where the list comes from, whether paths are
> configurable, what "other…" does — is **not decided here**. That belongs to
> [Design repo selection and session lifecycle](../tickets/006-repo-selection-session-lifecycle.md).
> This mock only fixes that creation *happens in root*.

---

## 3. Two sessions at once — the scenario that matters

### 3a. `tacp/auth-refactor` — streaming, no interruption

```
▶  tacp/auth-refactor                              14:21

  you   refactor the auth middleware to drop the
        session cookie fallback

  bot   ▶ codex · tacp · main

  bot   reading src/auth/middleware.ts
        reading src/auth/session.ts

  bot   ✎ editing src/auth/middleware.ts
        +18 −34

  bot   running tests… 41 passed
```

### 3b. Meanwhile `acpx/reconnect-bug` blocks

The topic name flips to `❓ … WAITING ON YOU` **before** the message lands, so the
chat list is already correct when the notification arrives.

```
❓ acpx/reconnect-bug                              14:22

  bot   ▶ claude · acpx · fix/reconnect

  bot   investigating the reconnect path…

  bot   ❓ Permission needed

        write  src/transport/reconnect.ts
        +42 −7

        ┌────────────────────────────────┐
        │ Allow once      │ Allow always │
        │ Reject once     │ Reject all   │
        │ Cancel turn                    │
        └────────────────────────────────┘
```

**What this mock does *not* settle.** The button vocabulary, what the diff
preview contains, timeout behaviour, and the unanswered case are all
[Design the permission and question round-trip](../tickets/005-permission-question-round-trip.md).
Shown here only to prove the *routing* works: the prompt is in its session's
topic, and it is answered there.

---

## 4. Switching — there is no switch

The operator taps a topic. That is the entire interaction. No `/switch`, no
current-session pointer, no mode to remember.

```
  tap ❓ acpx/reconnect-bug

❓ acpx/reconnect-bug                              14:23

  you   [ Allow once ]

  bot   ✓ allowed — write src/transport/reconnect.ts
        (keyboard removed)

  bot   ✎ wrote src/transport/reconnect.ts

  bot   ⏸ turn complete
```

Topic name returns to `▶` then `⏸` as the turn finishes.

Anything typed here goes to *this* session. Retargeting is navigation, and
Telegram does it.

---

## 5. The wrong-session mistake — what it looks like

**It largely cannot happen, and that is the finding.** Under one-chat-plus-switch
the failure is invisible: you answer "yes" believing you are in session A while
the pointer is on B, and nothing on screen contradicts you.

Here, an approval is a button press *inside a topic*. The permission message, its
buttons, and its diff are all in the topic they belong to. There is no ambient
"current session" to be stale.

The residual risks are narrower and worth carrying into ticket 005:

- **Stale prompt in an old topic.** Two sessions each asked permission; you
  answered one, scrolled the other's topic later, pressed its still-live button.
  Correct routing, but possibly a decision you have forgotten the context for.
  Mitigation is the message edit — the prompt should visibly carry its own age
  and current state.
- **Notification without context.** A push notification is read on a lock screen
  with the topic name attached but no diff. The name must therefore identify the
  session unambiguously (`repo/name`), never just the session name.

---

## 6. Retirement

```
  you   /end

  bot   End acpx/reconnect-bug?
        History is kept — the topic is renamed, not deleted.
        [ End session ]  [ Cancel ]

  you   [ End session ]

  bot   ✓ acpx/reconnect-bug — ended.
```

Topic renamed `✓ acpx/reconnect-bug`. Nothing is destroyed.

Deletion is a separate, explicitly destructive command, because
`deleteForumTopic` removes the topic **and every message in it**:

```
  you   /delete acpx/reconnect-bug

  bot   ⚠ This destroys the topic and its entire transcript.
        This cannot be undone.
        Type the session name to confirm.
```

---

## 7. What this mock commits tacp to

1. A durable `message_thread_id` → session mapping that tacp owns outright.
   Telegram cannot enumerate topics and acpx's store has no `list()`, so neither
   side can rebuild it after a restart.
2. An `editForumTopic` call on every session state transition.
3. A startup assertion on `getMe.has_topics_enabled` — topic mode in private
   chats is switched on via @BotFather, not the API, so the daemon should refuse
   to start rather than degrade silently.
4. Root-area message handling that is *only* commands, so agent output can never
   be emitted without a `message_thread_id`.
