# Documentation

Operator docs live on the Astro site (current release **[v0.4.0](https://github.com/pmdroid/acpbot/releases/tag/v0.4.0)**):

| | |
|---|---|
| **Local** | `cd website && bun run dev` → [http://localhost:4321/docs](http://localhost:4321/docs) |
| **Site** | [https://acpbot.app/docs](https://acpbot.app/docs) · [install](https://acpbot.app/#install) |
| **Source** | [`website/src/content/docs/`](../website/src/content/docs/) |

Edit markdown under `website/src/content/docs/`. Landing page: `website/src/pages/index.astro`.

## Design notes (repo-only)

Parked ideas and background under [`docs/ideas/`](ideas/):

| Doc | Topic |
|---|---|
| [multi-agent-spawn.md](ideas/multi-agent-spawn.md) | Parent spawns children via MCP; parent-linked slots; worktrees; A2A (shipped as [Multi-agent](https://acpbot.app/docs/multi-agent)) |
| [workflows.md](ideas/workflows.md) | EVE design (shipped as [EVE](https://acpbot.app/docs/eve)) |
| [multi-host-http3.md](ideas/multi-host-http3.md) | Future transport notes (current multi-host is WSS — [docs](https://acpbot.app/docs/multi-host)) |
