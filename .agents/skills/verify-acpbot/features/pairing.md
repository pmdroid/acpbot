# Pairing

An unclaimed bot answers a private DM with a short code. Approving that code on the machine (`acpbot pair approve`) makes that Telegram user the operator. After that, `/ping` works.

## Sub-features

- `pair-issue` DMs an unpaired bot and receives a code (not a session).
- `pair-approve` CLI approve stores `state/pairing/operator.json`.
- `pair-stranger` after claim: other user ids are ignored.

## How to get to it (user POV)

- First DM to a new bot (any text) in the private chat.
- On the host: `acpbot pair list` then `acpbot pair approve ABCD-1234`.
- `acpbot pair status` / `acpbot pair clear` to inspect or unpair.

## Driving it with verify-acpbot

Preconditions:

- Launch a run **without** using the seeded operator. Delete `state/pairing/operator.json` (or write a helper launch that skips the seed) before starting the worker, then doctor.
- `ACPBOT_CONFIG` / `ACPBOT_STATE_DIR` are the run paths.

- **Issue.** Inject any lobby text from user `42`. Wait for outbound text containing `pair approve`. Copy the code from that message or from `bun run src/main.ts pair list` with the run env.
- **Approve.** `ACPBOT_CONFIG=<run>/config.toml ACPBOT_STATE_DIR=<run>/state bun run src/main.ts pair approve <code>`. Exit 0. `pair status` prints `paired: Telegram user 42`.
- **Use.** Inject `/ping`. Wait for `pong`.
- **Proof.** Keep inject outbound (the code message), `pair status` stdout, and the `/ping` `pong` outbound.

## Gotchas

- Default `launch` already seeds operator 42 so lobby features skip this. Pairing proofs must start unpaired.
- Approve is CLI on the host, not a Telegram button.
- Worker picks up the claim without restart (`applied.json` consume). If `/ping` still issues a new code, the worker is not the process using that state dir.
