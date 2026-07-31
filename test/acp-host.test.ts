import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { defaultAcpHostSock } from "../src/acp-host/protocol";
import { startAcpHostServer } from "../src/acp-host/server";
import {
  createAcpHostClient,
  shouldUseAcpHost,
} from "../src/acp-host/client";
import { createMemoryHostSessionStore } from "../src/acp/session-store";
import type { SessionHost } from "../src/acp/session-host";

describe("acp-host protocol helpers", () => {
  test("default sock under state dir", () => {
    expect(defaultAcpHostSock("/tmp/x")).toBe("/tmp/x/acp-host.sock");
  });

  test("shouldUseAcpHost respects env", () => {
    expect(shouldUseAcpHost({ TACP_ACP_HOST: "1" })).toBe(true);
    expect(shouldUseAcpHost({ TACP_ACP_HOST: "0" })).toBe(false);
  });
});

describe("acp-host server", () => {
  test("ping / list over unix socket; slots survive client disconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tacp-host-"));
    const sockPath = join(dir, "h.sock");
    const { close } = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
    });

    const reply = await new Promise<string>((resolve, reject) => {
      const s = createConnection(sockPath);
      let buf = "";
      s.setEncoding("utf8");
      s.on("connect", () => {
        s.write(
          JSON.stringify({ type: "ping", reqId: "1" }) +
            "\n" +
            JSON.stringify({ type: "list", reqId: "2" }) +
            "\n",
        );
      });
      s.on("data", (c) => {
        buf += c;
        if (buf.includes("list_ok")) {
          s.end();
          resolve(buf);
        }
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(reply).toContain("pong");
    expect(reply).toContain("list_ok");
    expect(reply).toContain('"slots":[]');

    await close();
    await rm(dir, { recursive: true, force: true });
  });

  test("client detach does not require live agent for dispose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tacp-host-"));
    const sockPath = join(dir, "h.sock");
    const { close } = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
    });

    const client: SessionHost = createAcpHostClient({ sockPath });
    // dispose without ensure — should not throw hard
    await client.dispose();
    await close();
    await rm(dir, { recursive: true, force: true });
  });
});
