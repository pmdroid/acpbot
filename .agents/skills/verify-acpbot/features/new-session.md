# New session

`/new` opens a forum topic bound to a repo + session name. The topic is the agent session. A later prompt in that thread is a turn.

## Sub-features

- `new-args` `/new demo ping1` creates a topic without the picker.
- `new-picker` bare `/new` sends an inline-keyboard repo picker.
- `new-missing-repo` unknown repo name is rejected in the lobby.
- `new-prompt` text in the new thread gets an agent reply (local `echo` stub).

## How to get to it (user POV)

- `/new` then tap a repo and type a short name.
- `/new <repo> <name>` in the lobby.
- After the topic appears, type a prompt in that topic.

## Driving it with verify-acpbot

Preconditions:

- Local `launch` (not Docker) so `echo` ACP is on the host PATH via `command_json`.
- Doctor passes. Repos `demo` and `remote` exist.
- No session named `ping1` yet.

- **Create.** `inject --text "/new demo ping1"`. Wait until outbound includes `createForumTopic` (method) or a lobby message that names the new topic. Record `message_thread_id` from that `createForumTopic` result.
- **List.** `inject --text "/sessions"`. Wait for text containing `demo/ping1` or `ping1`.
- **Prompt.** `POST /_mock/inject` with `{"text":"hello","message_thread_id":<id>}`. Wait for a `sendMessage` in that thread whose text contains `[echo]` or `hello`.
- **Proof.** `outbound.json` has create + sessions list + thread reply. `store.json` has `demo/ping1`.

## Gotchas

- `/new` calls `ensureSession` on the host before `createForumTopic`. If echo ACP fails to boot, you get a lobby error and no topic. Read `host.log`.
- Docker images do not ship echo ACP. Skip `new-prompt` there; use [multi-host](./multi-host.md) for routing.
- Session names are one token: letters, digits, `-`, `_`, `.`.
- Picker callbacks are `callback_query` updates, not `/new` text.
