import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0z8AAAAASUVORK5CYII=";

type CliRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type CliRunOptions = {
  timeoutMs?: number;
  cwd?: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
};

test("integration: live Cursor ACP accepts a structured image prompt", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-live-cursor-cwd-"));

    try {
      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--timeout", "60", "--format", "quiet", "cursor", "exec"],
        homeDir,
        {
          timeoutMs: 90_000,
          stdin: JSON.stringify([
            {
              type: "text",
              text: "Reply briefly once this prompt and image are received. Do not use tools.",
            },
            { type: "image", mimeType: "image/png", data: TINY_PNG_BASE64 },
          ]),
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim().length > 0, true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-home-"));
  try {
    await run(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

async function runCli(
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: homeDir,
        ...options.env,
      },
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 15_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: acpx ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });

    const stdin = options.stdin;
    if (typeof stdin === "string") {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}
