import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteLinearBinding,
  formatLinearBindingContext,
  formatLinearBindingLine,
  formatLinearSessionListLabel,
  formatLinearStickyPrefix,
  formatLinearTopicTitle,
  linearBindingEnvVars,
  listLinearBindings,
  loadLinearBinding,
  parseLinearProjectRef,
  saveLinearBinding,
  withLinearStickyContext,
} from "../src/linear/bindings";
import {
  applyLinearTurnContext,
  LINEAR_COMMAND_USAGE,
  linearDrainPrompt,
  linearExportPrompt,
  linearFanoutPrompt,
  linearNextPrompt,
  linearWorkPrompt,
} from "../src/linear/prompts";
import {
  getKnownRemote,
  LINEAR_MCP,
  LINEAR_MCP_ID,
} from "../src/mcp/known-remotes";
import {
  injectSessionEnv,
  writeRemoteMcpServer,
  readMcpConfig,
} from "../src/mcp/repo-mcp";
import { mkdir } from "node:fs/promises";

describe("parseLinearProjectRef", () => {
  test("accepts UUID", () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(parseLinearProjectRef(id)).toEqual({ projectId: id });
  });

  test("extracts UUID from Linear URL", () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const url = `https://linear.app/acme/project/auth-rewrite-${id}`;
    const parsed = parseLinearProjectRef(url);
    expect(parsed.projectId).toBe(id);
    expect(parsed.projectUrl).toContain("linear.app");
  });

  test("uses last path segment when no UUID", () => {
    const parsed = parseLinearProjectRef(
      "https://linear.app/acme/project/auth-rewrite",
    );
    expect(parsed.projectId).toBe("auth-rewrite");
    expect(parsed.projectUrl).toContain("auth-rewrite");
  });

  test("name becomes id + projectName", () => {
    expect(parseLinearProjectRef("Auth rewrite")).toEqual({
      projectId: "Auth rewrite",
      projectName: "Auth rewrite",
    });
  });

  test("rejects empty", () => {
    expect(() => parseLinearProjectRef("  ")).toThrow();
  });
});

describe("linear binding store", () => {
  test("save load delete list", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "acpbot-linear-"));
    try {
      const sessionKey = "demo/auth-rewrite";
      const saved = await saveLinearBinding(stateDir, {
        sessionKey,
        repoKey: "demo",
        projectId: "proj-1",
        projectName: "Auth rewrite",
        projectUrl: "https://linear.app/acme/project/proj-1",
        teamKey: "ENG",
        boundBy: "command",
      });
      expect(saved.projectId).toBe("proj-1");
      expect(saved.boundAt).toBeTruthy();

      const loaded = await loadLinearBinding(stateDir, sessionKey);
      expect(loaded?.projectName).toBe("Auth rewrite");
      expect(loaded?.teamKey).toBe("ENG");

      const all = await listLinearBindings(stateDir);
      expect(all.some((b) => b.sessionKey === sessionKey)).toBe(true);

      expect(formatLinearBindingLine(loaded)).toContain("Auth rewrite");
      expect(formatLinearBindingContext(loaded)).toContain("proj-1");
      expect(formatLinearBindingContext(undefined)).toContain("not** bound");

      const removed = await deleteLinearBinding(stateDir, sessionKey);
      expect(removed).toBe(true);
      expect(await loadLinearBinding(stateDir, sessionKey)).toBeUndefined();
      expect(await deleteLinearBinding(stateDir, sessionKey)).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("isolated by sessionKey", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "acpbot-linear-iso-"));
    try {
      await saveLinearBinding(stateDir, {
        sessionKey: "demo/a",
        repoKey: "demo",
        projectId: "p-a",
        boundBy: "attach",
      });
      await saveLinearBinding(stateDir, {
        sessionKey: "demo/b",
        repoKey: "demo",
        projectId: "p-b",
        boundBy: "attach",
      });
      expect((await loadLinearBinding(stateDir, "demo/a"))?.projectId).toBe(
        "p-a",
      );
      expect((await loadLinearBinding(stateDir, "demo/b"))?.projectId).toBe(
        "p-b",
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("linear prompts + known remote", () => {
  test("known remote is official Linear MCP", () => {
    expect(LINEAR_MCP_ID).toBe("linear");
    expect(LINEAR_MCP.url).toBe("https://mcp.linear.app/mcp");
    expect(getKnownRemote("linear")?.url).toBe(LINEAR_MCP.url);
  });

  test("prompts enforce one-issue / fanout and usage lists fanout", () => {
    const binding = {
      sessionKey: "demo/x",
      repoKey: "demo",
      projectId: "p1",
      projectName: "X",
      boundAt: new Date().toISOString(),
      boundBy: "command" as const,
    };
    expect(linearExportPrompt(binding)).toContain("linear_bind_project");
    expect(linearNextPrompt(binding)).toContain("exactly one issue");
    expect(linearNextPrompt(binding)).toContain("lastIssueId");
    expect(linearWorkPrompt("ENG-9", binding)).toContain("only** focus");
    expect(linearFanoutPrompt(binding)).toContain("agent_spawn");
    expect(LINEAR_COMMAND_USAGE).toContain("/linear fanout");
    expect(LINEAR_COMMAND_USAGE).toContain("/linear drain");
    expect(LINEAR_COMMAND_USAGE).toMatch(/write \+ run|author/i);
    const drain = linearDrainPrompt(binding, { sequential: true });
    expect(drain).toContain("eve_write");
    expect(drain).toContain("eve_run");
    expect(drain).toMatch(/no built-in|not ship|author/i);
    expect(drain).toContain("sequential");
  });

  test("connect writes linear mcp.json entry only", async () => {
    const repo = await mkdtemp(join(tmpdir(), "acpbot-linear-repo-"));
    try {
      await mkdir(join(repo, ".acpbot"), { recursive: true });
      const entry = await writeRemoteMcpServer(repo, {
        name: LINEAR_MCP_ID,
        url: LINEAR_MCP.url,
      });
      expect(entry).toEqual({
        name: "linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
      });
      const cfg = await readMcpConfig(repo);
      expect(cfg.mcpServers).toEqual([entry]);
      // No token fields
      expect(JSON.stringify(cfg)).not.toContain("accessToken");
      expect(JSON.stringify(cfg)).not.toContain("Authorization");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("phase 2 sticky context + labels + env", () => {
  const binding = {
    sessionKey: "demo/auth",
    repoKey: "demo",
    projectId: "proj-uuid",
    projectName: "Auth rewrite",
    lastIssueId: "ENG-12",
    boundAt: new Date().toISOString(),
    boundBy: "command" as const,
  };

  test("sticky prefix prepends once; skips when [Linear] already present", () => {
    const prefix = formatLinearStickyPrefix(binding);
    expect(prefix).toContain("Auth rewrite");
    expect(prefix).toContain("ENG-12");

    const free = withLinearStickyContext("fix the login bug", binding);
    expect(free.startsWith("[Linear]")).toBe(true);
    expect(free).toContain("fix the login bug");

    const already = withLinearStickyContext(
      "[Linear] Bound project already\n\nmore",
      binding,
    );
    expect(already).toBe("[Linear] Bound project already\n\nmore");

    expect(withLinearStickyContext("hi", undefined)).toBe("hi");
    expect(applyLinearTurnContext("hi", binding)).toContain("hi");
  });

  test("session list label and topic title", () => {
    expect(formatLinearSessionListLabel(binding)).toBe(
      "Linear: Auth rewrite · ENG-12",
    );
    expect(formatLinearSessionListLabel(undefined)).toBeUndefined();

    const title = formatLinearTopicTitle("demo/auth", binding);
    expect(title).toContain("Auth rewrite");
    expect(title.startsWith("demo/auth")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(128);

    const longBase = "x".repeat(200);
    expect(formatLinearTopicTitle(longBase, binding).length).toBeLessThanOrEqual(
      128,
    );
  });

  test("linearBindingEnvVars and injectSessionEnv", () => {
    const env = linearBindingEnvVars(binding);
    expect(env).toContainEqual({
      name: "ACPBOT_LINEAR_PROJECT_ID",
      value: "proj-uuid",
    });
    expect(env.some((e) => e.name === "ACPBOT_LINEAR_LAST_ISSUE")).toBe(true);
    expect(linearBindingEnvVars(undefined)).toEqual([]);

    const server = injectSessionEnv(
      {
        name: "acpbot",
        command: "acpbot",
        args: ["mcp-server"],
        env: [{ name: "ACPBOT_STATE_DIR", value: "/tmp/state" }],
      },
      {
        sessionKey: "demo/auth",
        repoRoot: "/tmp/repo",
        repoStateDir: "/tmp/repo/.acpbot",
        extraEnv: env,
      },
    );
    expect(server).toMatchObject({ name: "acpbot" });
    if ("env" in server) {
      const map = new Map(server.env.map((e) => [e.name, e.value]));
      expect(map.get("ACPBOT_LINEAR_PROJECT_ID")).toBe("proj-uuid");
      expect(map.get("ACPBOT_SESSION_KEY")).toBe("demo/auth");
    }
  });
});
