import { describe, expect, test } from "bun:test";
import {
  TerminalManager,
  trimToUtf8Boundary,
  buildTerminalShellSpawnCommand,
} from "../src/acp/terminal-manager";

describe("trimToUtf8Boundary", () => {
  test("keeps short buffers", () => {
    const b = Buffer.from("hello");
    expect(trimToUtf8Boundary(b, 10).toString()).toBe("hello");
  });

  test("trims to limit", () => {
    const b = Buffer.from("abcdefghijklmnopqrstuvwxyz");
    const out = trimToUtf8Boundary(b, 5);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.toString()).toBe("vwxyz");
  });

  test("does not split multi-byte UTF-8", () => {
    // emoji is 4 bytes
    const b = Buffer.from("ab👍cd");
    const out = trimToUtf8Boundary(b, 5);
    // should be valid utf8
    expect(() => out.toString("utf8")).not.toThrow();
    expect(out.toString("utf8")).not.toContain("\uFFFD");
  });
});

describe("TerminalManager", () => {
  test("create + output + wait + release", async () => {
    const tm = new TerminalManager({ cwd: process.cwd() });
    const { terminalId } = await tm.createTerminal({
      command: "echo",
      args: ["hello-tacp-terminal"],
      outputByteLimit: 1024,
    });
    expect(typeof terminalId).toBe("string");

    const exit = await tm.waitForTerminalExit({ terminalId });
    expect(exit.exitCode).toBe(0);

    const out = await tm.terminalOutput({ terminalId });
    expect(out.output).toContain("hello-tacp-terminal");
    expect(out.truncated).toBe(false);
    expect(out.exitStatus?.exitCode).toBe(0);

    await tm.releaseTerminal({ terminalId });
    await expect(tm.terminalOutput({ terminalId })).rejects.toThrow(/Unknown/);
  });

  test("outputByteLimit truncates", async () => {
    const tm = new TerminalManager({ cwd: process.cwd() });
    const { terminalId } = await tm.createTerminal({
      command: "python3",
      args: ["-c", "print('x' * 5000)"],
      outputByteLimit: 100,
    });
    await tm.waitForTerminalExit({ terminalId });
    const out = await tm.terminalOutput({ terminalId });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.output, "utf8")).toBeLessThanOrEqual(100);
    await tm.releaseTerminal({ terminalId });
  });

  test("shell spawn command for pipes", () => {
    const cmd = buildTerminalShellSpawnCommand("echo hi | cat");
    expect(cmd.command).toBe("/bin/sh");
    expect(cmd.args).toEqual(["-c", "echo hi | cat"]);
    expect(cmd.killProcessGroup).toBe(true);
  });

  test("kill long-running process", async () => {
    const tm = new TerminalManager({ cwd: process.cwd(), killGraceMs: 200 });
    const { terminalId } = await tm.createTerminal({
      command: "sleep",
      args: ["30"],
    });
    await tm.killTerminal({ terminalId });
    const exit = await tm.waitForTerminalExit({ terminalId });
    // killed → non-zero or signal
    expect(
      exit.exitCode !== 0 || exit.signal != null || exit.exitCode === null,
    ).toBe(true);
    await tm.releaseTerminal({ terminalId });
  });
});
