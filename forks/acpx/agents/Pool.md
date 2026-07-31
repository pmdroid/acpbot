# Pool

- Built-in name: `pool`
- Default command: `pool acp`
- Upstream: [Poolside pool](https://github.com/poolsideai/pool)

`acpx pool` launches the installed `pool` CLI through its ACP stdio entrypoint. Install `pool` using the [official instructions](https://github.com/poolsideai/pool#install), then authenticate the CLI before using it through `acpx`; `pool login` is the normal interactive path. Pool reads its configuration from `~/.config/poolside/`.

Examples:

```bash
acpx pool sessions new
acpx pool 'review this branch'
acpx pool exec 'summarize this repository'
```

If the binary lives outside `PATH` or needs extra startup arguments, override the built-in argv in `~/.acpx/config.json`:

```json
{
  "agents": {
    "pool": {
      "argv": ["/opt/pool/bin/pool", "acp"]
    }
  }
}
```
