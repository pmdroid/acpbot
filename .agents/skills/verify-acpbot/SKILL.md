---
name: verify-acpbot
description: Drive acpbot through a mocked Telegram Bot API (real worker + host processes). Use when proving lobby/topic behavior, pairing, or multi-host routing without touching a live bot or the operator's XDG install.
---

# verify-acpbot

acpbot's user surface is Telegram. Proof goes Telegram update → worker → host → outbound Bot API. Do not call `createDaemon` / `handleUpdate` in-process for a proof; that path is already covered by `bun test`.

Isolation is mandatory. Never point `ACPBOT_CONFIG` / `ACPBOT_STATE_DIR` at `~/.config/acpbot` or `~/.local/share/acpbot`. The helper refuses those paths.

## Launch

From the repo root:

```bash
bun .agents/skills/verify-acpbot/scripts/verify.ts launch
```

Ready when stdout prints `{ "ok": true, "mockUrl": "http://127.0.0.1:<port>", ... }` and `doctor` passes. The helper starts, in order:

1. `scripts/telegram-mock.ts` (Bot API subset + `/_mock/*`)
2. `bun run src/main.ts host` with the run's `config.toml`
3. `bun --no-env-file run src/main.ts worker` with `ACPBOT_TELEGRAM_API_BASE=$mockUrl`

`--no-env-file` is required. The repo `.env` often sets `TACP_OAUTH_CALLBACK_BASE`; if the host inherits that and port 8788 is taken, it exits after bind failure.

The worker is the real process. `realTelegram` already accepted `apiBase`; `ACPBOT_TELEGRAM_API_BASE` is the production env that points it at the mock (`$root/bot$token`).

Two-host Docker (worker + local Unix host + remote WSS host + mock):

```bash
bun .agents/skills/verify-acpbot/scripts/verify.ts launch-docker
```

Needs Docker. Builds `acpbot:verify` from this repo's Dockerfile. Project name is `acpbot-verify-<pid>` so it never touches compose volume `acpbot-data`. Remote host publishes `127.0.0.1:18790`. Mock publishes `127.0.0.1:18080` for inject/outbound from the host.

If a current run exists, cleanup first. Do not launch a second copy against the same run dir.

## Doctor

```bash
bun .agents/skills/verify-acpbot/scripts/verify.ts doctor
```

Read-only. Fail the run if any check fails:

- Mock `GET $mockUrl/_mock/health` is ok
- State/config paths are not the operator XDG install
- Local mode: `acp-host.sock` exists, mock/host/worker pids are alive, worker log contains `acp-host: ok`
- `acpbot pair status` against the run env shows the seeded operator (Telegram user 42)

Writes `artifacts/<runId>/doctor.json`.

## Drive

Harness is `verify.ts`. Inject is a private-chat message from user `42` / chat `1000` (seeded operator).

```bash
bun .agents/skills/verify-acpbot/scripts/verify.ts inject --text "/ping"
bun .agents/skills/verify-acpbot/scripts/verify.ts wait --contains pong
bun .agents/skills/verify-acpbot/scripts/verify.ts outbound
```

`inject` POSTs `/_mock/inject`. The worker's long-poll `getUpdates` wakes and runs the real daemon. `wait` polls `/_mock/outbound` for a `sendMessage` whose `text` contains the needle.

Slash commands are the user handles. Lobby: `/ping`, `/new`, `/sessions`, `/help`. Topic: `/status`, `/cancel`, `/fresh`, `/steer`, `/mode`, `/agent`, `/permissions`. `/new <repo> <name>` skips the picker (`demo` and `remote` are seeded).

Callback buttons: inject a full update with `callback_query` via `POST $mockUrl/_mock/inject` (raw Telegram snake_case). Topic prompts: inject with `message_thread_id` from the `createForumTopic` outbound.

Default agent in local mode is `echo`, launched as `bun scripts/echo-acp.ts` (ACP stdio stub). Docker images do not include that stub; `/new` on Docker proves routing/errors, not an agent reply.

Read `features/` before claiming a feature. Driving one entry point does not cover the others listed there.

## Evidence

Directory: `.agents/skills/verify-acpbot/artifacts/<runId>/`. Cleanup deletes the run dir (`runs/<id>` plus pids/containers) and **keeps** `artifacts/`.

Minimum for a proof:

- `last-inject.json` (the user action)
- `outbound.json` (resulting Bot API calls)
- `doctor.json`
- For mutations: a second read (`/sessions`, store.json, host log, or a second inject)

Standards:

- Real worker + host, mocked Telegram only. Telegram is the production boundary (`TelegramPort` / `api.telegram.org`).
- Capture action and result, not only the final outbound.
- Side effects: `store.json` sessions, `state/pairing/operator.json`, `createForumTopic` thread ids, remote host logs for multi-host.
- In-process `fakeTelegram` / `createFakeEnvironment` is **not** verification evidence.
- Do not use the operator's live bot token.

## Cleanup

```bash
bun .agents/skills/verify-acpbot/scripts/verify.ts cleanup
```

Kills the pids recorded in `runs/current.json` (SIGTERM then SIGKILL). Docker mode runs `docker compose -p <project> down -v` for that project only. Removes `runs/<id>`. Leaves `artifacts/<id>/`.

If launch fails halfway, still run cleanup. Do not `pkill acpbot`.

## Helpers

All from repo root:

| Command | What |
|---|---|
| `bun .agents/skills/verify-acpbot/scripts/verify.ts launch` | Isolated host+worker+mock |
| `bun .agents/skills/verify-acpbot/scripts/verify.ts launch-docker` | Same, two hosts in Compose |
| `bun .agents/skills/verify-acpbot/scripts/verify.ts doctor` | Health |
| `bun .agents/skills/verify-acpbot/scripts/verify.ts inject --text "/ping"` | Operator lobby message |
| `bun .agents/skills/verify-acpbot/scripts/verify.ts wait --contains pong` | Block until outbound text |
| `bun .agents/skills/verify-acpbot/scripts/verify.ts outbound` | Dump mock outbound |
| `bun .agents/skills/verify-acpbot/scripts/verify.ts cleanup` | Tear down run, keep artifacts |
| `bun .agents/skills/verify-acpbot/scripts/verify.ts prove-ping` | Launch, doctor, `/ping`, cleanup (self-check) |

`scripts/telegram-mock.ts` can be run alone (`--bind 127.0.0.1 --port 0 --token …`). Control routes: `GET /_mock/health`, `POST /_mock/inject`, `GET /_mock/outbound`, `POST /_mock/reset-outbound`. Bind localhost in local mode.

Smoke the skill with `prove-ping` after changing launch/doctor/drive.
