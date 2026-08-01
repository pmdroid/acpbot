# acpbot.app

Static landing page for **[acpbot.app](https://acpbot.app)**.

## Install acpbot (binary — recommended)

Release builds ship standalone Bun-compiled binaries. You do **not** need Bun or a source checkout for normal use.

### 1. Download

From the [GitHub Releases](https://github.com/pmdroid/acpbot/releases) page, grab the assets for your platform (tag `vX.Y.Z`):

| Asset | Role |
|-------|------|
| `acpbot-vX.Y.Z-<platform>.tar.gz` | Telegram **worker** |
| `acpbot-host-vX.Y.Z-<platform>.tar.gz` | **acp-host** (agents + schedules) |

Platforms: `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`.

```bash
# example (darwin arm64, v0.1.0)
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

### 2. Configure

```bash
# minimum env (ACPBOT_* preferred; TACP_* still works)
export ACPBOT_BOT_TOKEN=...
export ACPBOT_OPERATOR_USER_ID=...
export ACPBOT_STORE_PATH="$PWD/data/store.json"
export ACPBOT_STATE_DIR="$PWD/data/state"   # absolute path recommended
export ACPBOT_REPOS_JSON='{"demo":"/absolute/path/to/repo"}'
export ACPBOT_DEFAULT_AGENT=grok-build
mkdir -p "$ACPBOT_STATE_DIR"
```

Install agent CLIs you want (e.g. `grok`, `claude` + adapter, `codex` + adapter, `opencode`) on `PATH`.

### 3. Run (two processes)

```bash
# terminal 1 — required
acpbot-host

# terminal 2
acpbot
```

Worker fails boot if the host socket is missing. Same `ACPBOT_STATE_DIR` on both.

### Docker (optional)

Release images are published to GHCR with the same tag:

```bash
docker pull ghcr.io/pmdroid/acpbot:v0.1.0
export ACPBOT_IMAGE=ghcr.io/pmdroid/acpbot:v0.1.0
# then use the repo docker-compose.yml with your .env
```

### From source (dev only)

```bash
git clone https://github.com/pmdroid/acpbot.git
cd acpbot && bun install
bun run acp-host   # terminal 1
bun run start      # terminal 2
```

---

## Landing page (this folder)

### Preview

```bash
# from repo root
bunx serve website -p 4321
# open http://127.0.0.1:4321
```

### Deploy

Publish this `website/` directory as the site root for `acpbot.app`
(Cloudflare Pages, Netlify, GitHub Pages, nginx, etc.).

Include `assets/acpbot-logo.png` and enable HTTPS.
