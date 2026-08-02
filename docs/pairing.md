# Operator pairing (CLI approve)

acpbot does **not** put an operator id in `config.toml`. Pairing is always:

1. Telegram DM → pairing code  
2. Host CLI → `acpbot pair approve <code>`

The approved operator is stored under:

```text
$state_dir/pairing/operator.json
```

(default `state_dir`: `~/.local/share/acpbot/state`)

## Flow

1. Start **acp-host** and **acpbot** with a valid `bot_token`.
2. Open a **private** chat with the bot and send any message (e.g. `/ping`).
3. The bot replies with a **pairing code** (e.g. `AB3K-9Q2M`).
4. On the machine that runs acpbot:

```bash
acpbot pair list
acpbot pair approve AB3K-9Q2M
acpbot pair status
```

5. The worker picks up the pair on the next poll and confirms in Telegram.
6. Only that Telegram account can control the bot afterward.

## Why this is safer

| Step | Proves |
|------|--------|
| Telegram DM | Control of that Telegram account |
| `acpbot pair approve` on the host | Shell access to the machine that holds the bot token |

Random people who find the bot username only get a code; without CLI access they cannot complete pairing.

## Commands

```text
acpbot pair status              # current paired operator (if any)
acpbot pair list                # pending codes
acpbot pair approve <code>      # store operator in state_dir
acpbot pair clear               # unpair (allow a new approve)
```

## Re-pair

```bash
acpbot pair clear
# DM the bot again for a new code, then:
acpbot pair approve <new-code>
```
