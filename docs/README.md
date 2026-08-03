# Documentation moved

Operator docs now live on the Astro site:

| | |
|---|---|
| **Local** | `cd website && bun run dev` → [http://localhost:4321/docs](http://localhost:4321/docs) |
| **Site** | [https://acpbot.app/docs](https://acpbot.app/docs) |
| **Source** | [`website/src/content/docs/`](../website/src/content/docs/) |

Edit markdown under `website/src/content/docs/`. Landing page: `website/src/pages/index.astro`.

## Design notes (not shipped)

Parked ideas and future work under [`docs/ideas/`](ideas/):

| Doc | Topic |
|---|---|
| [multi-host-http3.md](ideas/multi-host-http3.md) | Run `acp-host` on remote servers; worker ↔ host over HTTP/3 (no Tailscale required) |
