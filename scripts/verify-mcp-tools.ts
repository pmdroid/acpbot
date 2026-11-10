import { createAcpHostClient } from "../src/acp-host/client";
const host = createAcpHostClient({
  sockPath: "/home/spooky/.local/share/acpbot/state/acp-host.sock",
  hooks: { onPermissionRequest: async req => ({
    outcome: /telegram_send|acpbot/.test(JSON.stringify(req.raw)) ? "allow_once" : "reject_once",
  }) },
});
const timeout = setTimeout(() => process.exit(1), 150_000);
try {
  for (const agent of ["mimo", "codex"]) {
    const sessionKey = `playground/${agent}-ready`;
    await host.ensureSession({sessionKey, agent, cwd:"/data/projects/playground", permissionMode:"ask"});
    const turn = host.startTurn({sessionKey, text:
      `Use the acpbot telegram_send MCP tool to send exactly ${agent.toUpperCase()}_MCP_OK to this session's Telegram topic. Discover that tool if necessary. Do not use shell tools, change files, or call any unrelated tools. Then reply Done.`});
    let output = "";
    const consume = (async () => {
      for await (const event of turn.events) {
        if (event.type === "text_delta" && event.stream !== "thought") output += event.text;
      }
    })();
    const result = await turn.result;
    await consume;
    console.log(agent, result.status, output.slice(0,600));
  }
} finally {
  clearTimeout(timeout);
  await host.dispose();
}
process.exit(0);
