# Multi-host

A repo can bind to a remote `acp-host` over authenticated WebSocket. The worker keeps the bot token. Agents run on the machine that owns that workspace. There is no fallback to local if that host is down or the token is wrong.

## Sub-features

- `mh-bind` `[repos.remote] host = "remote"` routes `/new remote …` to the remote host.
- `mh-local` `/new demo …` still uses the Unix `acp-host.sock` on the worker machine.
- `mh-auth` a bad host token never starts a session.
- `mh-docker` two host containers plus worker plus mock.

## How to get to it (user POV)

- Config: `[hosts.<id>]` `kind = "wss"`, `url`, `token`; repo table form `path` + `host`.
- On the remote machine: `acpbot host` with `[host_listen]` (or `ACPBOT_HOST_LISTEN_PORT` + `ACPBOT_HOST_TOKEN`).
- In Telegram: `/new` and pick the remote-bound repo.

## Driving it with verify-acpbot

Preconditions:

- `verify.ts launch-docker` (or a local extra `acpbot host` with `ACPBOT_HOST_LISTEN_PORT=18790` and matching token, plus worker config `url = "ws://127.0.0.1:18790"`).
- Doctor: mock healthy; remote container/process log contains `remote WebSocket on port`.
- Operator paired.

- **Remote new.** `inject --text "/new remote box1"`. Remote host log (`<run>/remote-host.log` in Docker, or the extra host log locally) shows an ensure/RPC for `remote/box1`. Local `host.log` does not spawn that session.
- **Local new.** `inject --text "/new demo box1"`. Local host log shows the ensure. Remote log does not.
- **Bad token.** Repeat with worker `hosts.remote.token` set to something else (or inject after changing the remote token and restarting). Outbound lobby text contains auth/token failure. No topic.
- **Proof.** Inject records + both host logs + outbound. Routing is the side effect; a topic on the mock is extra if an agent binary exists on that host.

## Gotchas

- Worker must load `hostsCatalog` (fixed in `src/worker-run.ts`). An old binary will silently send every repo to local Unix.
- `url` inside Compose is `ws://host-remote:8790`. From the Mac it is `ws://127.0.0.1:18790`. Mixing those breaks doctor vs worker.
- Production compose (`docker-compose.yml` at repo root) uses volume `acpbot-data` and a real bot token. Do not drive it.
- Docker runtime image has no coding agent. `/new remote …` may error after a successful WSS handshake (`agent binary not found`). Handshake + host log still prove routing.
- Invalid token must not fall back to local.
