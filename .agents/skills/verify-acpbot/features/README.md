# acpbot verification map

Maintained source for user-facing acpbot behavior. Read this index, then the matching feature file.

## Baseline preconditions

- Isolated run from `bun .agents/skills/verify-acpbot/scripts/verify.ts launch` (or `launch-docker`).
- `verify.ts doctor` passes.
- Operator is Telegram user `42` in private chat `1000` (seeded `operator.json`).
- Repos `demo` (local host) and `remote` (host id `remote`) exist in the run config.
- Never drive `~/.config/acpbot` or a live BotFather token.

## Driving conventions

- Start from the launched baseline unless a feature says otherwise.
- User input is a Telegram update. Prefer `inject --text` for lobby slash commands.
- Treat command strings as literal (`/ping`, `/new demo ping1`).
- After a mutation, read a second user-visible channel (`/sessions`, another inject, or outbound dump).
- Restore nothing that lives in the run dir; cleanup wipes the run. Keep artifacts.

## Proof and skip reporting

- Capture inject + outbound, not only the last message.
- Proof is mock outbound (and host logs / store.json when the feature mutates them).
- Record the feature id and entry point on the artifact.
- If an entry point is unreachable, report the command and the unmet precondition. Do not mark it verified via a different path.

## Feature entry contract

Each feature file: H1, one paragraph, then exactly `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-acpbot`, `Gotchas`.

## Features

- [Lobby ping](./lobby-ping.md) — `/ping` → `pong` through the real worker.
- [Pairing](./pairing.md) — unclaimed DM issues a code; `acpbot pair approve` claims the operator.
- [New session](./new-session.md) — `/new demo <name>` creates a forum topic and store row.
- [Multi-host](./multi-host.md) — repo `remote` routes to a second host over WSS (Docker or a second `acpbot host`).
