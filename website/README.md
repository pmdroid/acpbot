# acpbot.app (Astro)

Landing page + full documentation for [acpbot](https://github.com/pmdroid/acpbot).

## Commands

```bash
cd website
bun install
bun run dev      # http://localhost:4321
bun run build    # static output → dist/
bun run preview
```

From the monorepo root:

```bash
bun run website:build    # install website deps + build → website/dist
```

## Cloudflare Pages

**Recommended** — Root directory = `website`:

| Setting | Value |
|---|---|
| Root directory | `website` |
| Build command | `bun run build` |
| Build output directory | `dist` |
| Deploy config | [`wrangler.toml`](wrangler.toml) (`pages_build_output_dir = "dist"`) |

**Repo root** (if Root directory is empty):

| Setting | Value |
|---|---|
| Build command | `bun run website:build` |
| Build output directory | `website/dist` |
| Deploy config | root [`../wrangler.toml`](../wrangler.toml) |

## Structure

| Path | Role |
|---|---|
| `src/pages/index.astro` | Marketing landing |
| `src/pages/docs/` | Docs routes |
| `src/content/docs/` | Markdown docs (content collection) |
| `src/styles/global.css` | Brand system (dark metallic) |
| `public/assets/` | Logo |
| `wrangler.toml` | Cloudflare Pages output dir |

Site: https://acpbot.app · Docs: https://acpbot.app/docs
