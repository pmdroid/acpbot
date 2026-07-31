# tacp demo workspace

Tiny throwaway project for trying tacp + Grok over Telegram.

## Try this from Telegram

1. Start tacp: `bun --env-file=.env run src/main.ts`
2. In the bot chat: `/new` → pick **demo** → send a name (e.g. `scratch`)
3. Open the new topic and try:

- `What files are in this repo?`
- `Add a greet(name) function to hello.ts and a one-line usage example`
- `Run whatever checks make sense and report the result`

## Layout

```
demo/
  README.md      — this file
  hello.ts       — sample source
  package.json   — optional scripts
  notes.md       — free space for the agent to edit
```

Safe to reset: delete `notes.md` changes or recreate the folder.
