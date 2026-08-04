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
| [multi-agent-spawn.md](ideas/multi-agent-spawn.md) | Parent spawns children via MCP tools; parent-linked slots; **always new git worktree**; A2A (no CLI in v1) |
