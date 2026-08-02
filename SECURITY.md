# Security

acpbot connects Telegram to coding agents that can execute tools, edit files, and use network APIs on systems you configure.

## Reporting

If you find a vulnerability, please open a **private** security advisory on the GitHub repository (Security → Advisories → New draft advisory), or contact the maintainer via GitHub.

Do **not** open a public issue for exploitable bugs until a fix is available.

## Scope

In scope:

- Remote code execution or privilege issues in the worker / acp-host process
- Unauthorized access to sessions or OAuth tokens
- Injection that escapes the intended operator allowlist

Out of scope:

- Damage caused by agents the operator deliberately authorized
- Misconfiguration of mounted repos, API keys, or public OAuth endpoints
- Upstream agent CLIs (Claude, Codex, Grok, OpenCode) and Telegram itself

## Operator responsibilities

Config is **TOML-first** (`~/.config/acpbot/config.toml`) for the bot token and paths. The **operator is not in config** — only via CLI pairing:

1. DM the bot in a private chat → receive a pairing code  
2. On the host: `acpbot pair approve <code>`  

Only someone with **shell access to the host** can approve. See [docs/pairing.md](docs/pairing.md).

- Keep **`state_dir`** absolute and private (sessions, sockets, OAuth tokens, pairing state).
- Treat mounted workspaces as fully trusted by the agent.
- Review permission prompts; default mode prefers **ask** when advertised.
- Do not share the bot username until you have paired.

See also the [README disclaimer](README.md#disclaimer--use-at-your-own-risk) and [LICENSE](LICENSE).
