# Lobby ping

`/ping` in the private-chat lobby replies `pong`. It never starts an agent and never opens a topic.

## Sub-features

- `ping-lobby` replies `pong` to `/ping` in the root chat.
- `ping-stranger` ignores `/ping` from a non-operator user.
- `ping-topic-scope` tells the operator `/ping` is a lobby command when typed in a session topic.

## How to get to it (user POV)

- Type `/ping` in the private chat with the bot (not inside a topic).
- Pick `/ping` from the Telegram command menu in that same root chat.

## Driving it with verify-acpbot

Preconditions:

- `verify.ts launch` (or `launch-docker`) is current.
- `verify.ts doctor` passes.
- Operator is user `42`.

- **Ping.** Run `bun .agents/skills/verify-acpbot/scripts/verify.ts inject --text "/ping"`. Then `… wait --contains pong`. Outbound `sendMessage` text is exactly `pong` (or starts with `pong`) and has no `message_thread_id`.
- **Stranger.** `POST $mockUrl/_mock/inject` with `{"text":"/ping","userId":99,"chatId":1000}`. `outbound` gains no new `sendMessage` for that update.
- **Proof.** Save `artifacts/<runId>/outbound.json` and `last-inject.json`. The inject payload is `/ping`; the matching outbound is `pong`.

## Gotchas

- `/ping` inside a mapped topic is wrong-scope, not `pong`. Use a thread id from `createForumTopic` only for `ping-topic-scope`.
- Worker long-poll is ~25s. `wait` exists so you do not race `outbound` immediately after inject.
- In-process `fakeTelegram` tests are not this feature.
