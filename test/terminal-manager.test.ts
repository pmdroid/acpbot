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
    const b = Buffer.from("ab👍cd");
    const out = trimToUtf8Boundary(b, 5);
    expect(() => out.toString("utf8")).not.toThrow();
    expect(out.toString("utf8")).not.toContain("\uFFFD");
  });
});

describe("TerminalManager", () => {
  test("create + output + wait + release", async () => {
    const tm = new TerminalManager({ cwd: process.cwd() });
    const { terminalId } = await tm.createTerminal({
      sessionId: "s1",
      command: "echo",
      args: ["hello-acpbot-terminal"],
      outputByteLimit: 1024,
    });
    expect(typeof terminalId).toBe("string");

    const exit = await tm.waitForTerminalExit({ sessionId: "s1", terminalId });
    expect(exit.exitCode).toBe(0);

    const out = await tm.terminalOutput({ sessionId: "s1", terminalId });
    expect(out.output).toContain("hello-acpbot-terminal");
    expect(out.truncated).toBe(false);
    expect(out.exitStatus?.exitCode).toBe(0);

    await tm.releaseTerminal({ sessionId: "s1", terminalId });
    await expect(tm.terminalOutput({ sessionId: "s1", terminalId })).rejects.toThrow(/Unknown/);
  });

  test("outputByteLimit truncates", async () => {
    const tm = new TerminalManager({ cwd: process.cwd() });
    const { terminalId } = await tm.createTerminal({
      sessionId: "s1",
      command: "python3",
      args: ["-c", "print('x' * 5000)"],
      outputByteLimit: 100,
    });
    await tm.waitForTerminalExit({ sessionId: "s1", terminalId });
    const out = await tm.terminalOutput({ sessionId: "s1", terminalId });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.output, "utf8")).toBeLessThanOrEqual(100);
    await tm.releaseTerminal({ sessionId: "s1", terminalId });
  });

  test("shell spawn command for pipes", () => {
    const cmd = buildTerminalShellSpawnCommand("echo hi | cat");
    expect(cmd.command).toBe("/bin/sh");
    expect(cmd.args).toEqual(["-c", "echo hi | cat"]);
    expect(cmd.killProcessGroup).toBe(true);
  });

  test("full shell line in command (no args) runs via shell — Grok style", async () => {
    const tm = new TerminalManager({ cwd: process.cwd() });
    // Grok sometimes packs: command="/opt/homebrew/bin/bash -lc '…'", args=[]
    const line = `/bin/bash -lc 'echo shell-line-ok'`;
    const { terminalId } = await tm.createTerminal({
      sessionId: "s1",
      command: line,
      args: [],
      outputByteLimit: 1024,
    });
    await tm.waitForTerminalExit({ sessionId: "s1", terminalId });
    const out = await tm.terminalOutput({ sessionId: "s1", terminalId });
    expect(out.output).toContain("shell-line-ok");
    await tm.releaseTerminal({ sessionId: "s1", terminalId });
  });

  test("kill long-running process", async () => {
    const tm = new TerminalManager({ cwd: process.cwd(), killGraceMs: 200 });
    const { terminalId } = await tm.createTerminal({
      sessionId: "s1",
      command: "sleep",
      args: ["30"],
    });
    await tm.killTerminal({ sessionId: "s1", terminalId });
    const exit = await tm.waitForTerminalExit({ sessionId: "s1", terminalId });
    expect(
      exit.exitCode !== 0 || exit.signal != null || exit.exitCode === null,
    ).toBe(true);
    await tm.releaseTerminal({ sessionId: "s1", terminalId });
  });
});
