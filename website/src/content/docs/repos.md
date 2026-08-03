---
title: Repos
description: Workspace roots via acpbot repo manager and folder browser.
order: 3
section: start
---

Named workspace roots live in `config.toml` under `[repos]`.  
Telegram `/new` uses these keys as the repo picker.

```toml
[repos]
acpbot = "/Users/you/code/acpbot"
demo   = "/Users/you/code/demo"
```

## Commands

```bash
acpbot repo                 # interactive manager (list / add / edit / remove)
acpbot repo list            # print keys → paths
acpbot repo add             # key + folder browser
acpbot repo add <key>       # browser for path
acpbot repo add <key> <path>
acpbot repo set <key> [path]
acpbot repo remove <key>
acpbot repo browse          # pick folder first, then key
acpbot repo path <key>      # print path only
acpbot repos …              # alias
```

### Folder browser

When a path is not given on the CLI (or you choose **Browse folders…**):

- Arrow keys move; **Use this folder** confirms
- `..` goes up; **Home** jumps to `$HOME`
- Subfolders are listed (non-hidden)
- **Type path…** accepts absolute or `~/…` paths

`acpbot setup` uses the same browser when adding a workspace.

### Config write

Only the `[repos]` table is rewritten; bot token, speech, OAuth, etc. are left alone.  
Empty list becomes a commented stub (`# [repos]`).

### Apply changes

Host and worker **hot-reload** `[repos]` (and a few other fields) from `config.toml`
when the file changes — usually within ~1s after `acpbot repo add` / save.

No restart needed for `/new` to see new keys. Boot logs show `hot-reload on`.

Still restart if you change **bot_token**, paths (`state_dir` / `store_path`), or OAuth listen bind.

## Related

- [Configuration](/docs/configuration) — full `config.toml`
- [Getting started](/docs/getting-started) — first `/new`
- [Commands](/docs/commands) — `/new` lobby slash
