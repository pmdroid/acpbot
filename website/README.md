# acpbot.app static site

Landing page assets for [acpbot.app](https://acpbot.app). Serve `index.html` + `styles.css` + `assets/`.

## Binary install (primary)

### 1. Download release binaries

From [GitHub Releases](https://github.com/pmdroid/acpbot/releases) — grab worker + host for your platform.

```bash
# example: v0.1.0 on Apple Silicon
curl -sL -o acpbot.tar.gz \
  "https://github.com/pmdroid/acpbot/releases/download/v0.1.0/acpbot-v0.1.0-darwin-arm64.tar.gz"
curl -sL -o acpbot-host.tar.gz \
  "https://github.com/pmdroid/acpbot/releases/download/v0.1.0/acpbot-host-v0.1.0-darwin-arm64.tar.gz"
tar -xzf acpbot.tar.gz && tar -xzf acpbot-host.tar.gz
chmod +x acpbot-v0.1.0-darwin-arm64 acpbot-host-v0.1.0-darwin-arm64
# optional: install on PATH
sudo mv acpbot-v0.1.0-darwin-arm64 /usr/local/bin/acpbot
sudo mv acpbot-host-v0.1.0-darwin-arm64 /usr/local/bin/acpbot-host
```

### 2. Configure (TOML)

```bash
mkdir -p ~/.config/acpbot ~/.local/share/acpbot
# copy config.example.toml from the repo release notes / source tree
cp config.example.toml ~/.config/acpbot/config.toml
chmod 600 ~/.config/acpbot/config.toml
```

Minimal `config.toml`:

```toml
bot_token = "…"
operator_user_id = 12345
default_agent = "grok-build"

[repos]
demo = "/absolute/path/to/repo"

# Optional speech (OpenAI):
# [speech]
# tts_provider = "openai"
# stt_provider = "openai"
# [speech.openai]
# api_key = "sk-…"
```

Store/state default under `~/.local/share/acpbot/`. Same file for host + worker.

Install agent CLIs you want (`grok`, `claude`, `codex`, `opencode`) on `PATH`.

### 3. Run (two processes)

```bash
# terminal 1 — required
acpbot-host --config ~/.config/acpbot/config.toml

# terminal 2
acpbot --config ~/.config/acpbot/config.toml
```

Worker fails boot if the host socket is missing.

### Docker (optional)

```bash
docker pull ghcr.io/pmdroid/acpbot:v0.1.0
export ACPBOT_IMAGE=ghcr.io/pmdroid/acpbot:v0.1.0
# mount config.toml — see repo docker-compose.yml
```

### From source (dev only)

```bash
git clone https://github.com/pmdroid/acpbot.git
cd acpbot && bun install
cp config.example.toml ~/.config/acpbot/config.toml
bun run acp-host   # terminal 1
bun run start      # terminal 2
```

Full docs: [docs/configuration.md](../docs/configuration.md), [docs/getting-started.md](../docs/getting-started.md).
