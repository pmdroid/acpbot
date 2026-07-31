/**
 * Starts the peer-chat WebSocket server + Vite together.
 */
const chat = Bun.spawn({
  cmd: ["bun", "run", "server/chat-server.ts"],
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

const vite = Bun.spawn({
  cmd: [
    "bunx",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    "4096",
  ],
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

async function shutdown(code = 0) {
  chat.kill();
  vite.kill();
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

const codes = await Promise.all([chat.exited, vite.exited]);
const failed = codes.find((c) => c !== 0);
process.exit(failed ?? 0);
