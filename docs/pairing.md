# Operator pairing (CLI approve)

When `operator_user_id = 0` (default / unclaimed), the bot does **not** trust the first Telegram user automatically.

## Flow

1. Start **acp-host** and **acpbot** (worker) with a valid `bot_token` and `operator_user_id = 0`.
2. Open a **private** chat with the bot and send any message (e.g. `/ping`).
3. The bot replies with a **pairing code** (e.g. `AB3K-9Q2M`).
4. On the machine that runs acpbot:

```bash
acpbot pair list                 # optional
acpbot pair approve AB3K-9Q2M
```

5. The CLI writes `operator_user_id` into `config.toml`. The worker picks it up on the next poll (or next message) and confirms in Telegram.
6. Only that Telegram account can control the bot afterward.

## Why this is safer

| Step | Proves |
|------|--------|
| Telegram DM | Control of that Telegram account |
| `acpbot pair approve` on the host | Shell access to the machine that holds the bot token |

Random people who find the bot username only get a code; without CLI access they cannot complete pairing.

## Commands

```text
acpbot pair status              # current operator from config
acpbot pair list                # pending codes (from state_dir/pairing/)
acpbot pair approve <code>      # claim operator + write config
```

## Re-pair

Edit config:

```toml
operator_user_id = 0
```

Restart the worker (or wait until unclaimed path is used), DM again, approve a new code.

## Optional: set id without pairing

In setup or config you can still set a fixed id:

```toml
operator_user_id = 123456789
```

Then no pairing code is issued; only that user is accepted.
