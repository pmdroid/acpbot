/**
 * ACP client terminal/* implementation — adapted from openclaw/acpx TerminalManager.
 *
 * Features retained from acpx:
 * - outputByteLimit with UTF-8 boundary trim + truncated flag
 * - process-group kill (detached shells) + descendant PID tracking
 * - SIGTERM → grace → SIGKILL
 * - shell fallback for shell metacharacters / ENOENT paths
 * - wait_for_exit promise, release cleans up
 *
 * tacp always allows create (client surface is open; agent tool permission is separate).
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";

const DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_500;

export type TerminalSpawnCommand = {
  command: string;
  args: string[];
  killProcessGroup: boolean;
};

type ManagedTerminal = {
  process: ChildProcessByStdio<null, Readable, Readable>;
  killProcessGroup: boolean;
  descendantPids: Set<number>;
  processGroupSnapshotPromise?: Promise<void>;
  output: Buffer;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  exitPromise: Promise<WaitForTerminalExitResponse>;
  resolveExit: (response: WaitForTerminalExitResponse) => void;
};

export type TerminalManagerOptions = {
  /** Default cwd when create request omits cwd */
  cwd: string;
  killGraceMs?: number;
  log?: Logger;
};

type TerminalSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  stdio: ["ignore", "pipe", "pipe"];
  detached?: boolean;
  shell?: true;
  windowsHide: true;
};

function toCommandLine(command: string, args: string[] | undefined): string {
  const renderedArgs = (args ?? []).map((arg) => JSON.stringify(arg)).join(" ");
  return renderedArgs.length > 0 ? `${command} ${renderedArgs}` : command;
}

function toEnvObject(
  env: CreateTerminalRequest["env"],
): NodeJS.ProcessEnv | undefined {
  if (!env || env.length === 0) {
    return undefined;
  }
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of env) {
    merged[entry.name] = entry.value;
  }
  return merged;
}

export function buildTerminalSpawnCommand(
  command: string,
  args: string[] | undefined,
): TerminalSpawnCommand {
  return { command, args: args ?? [], killProcessGroup: false };
}

export function buildTerminalShellSpawnCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): TerminalSpawnCommand {
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command],
      killProcessGroup: true,
    };
  }
  return { command: "/bin/sh", args: ["-c", command], killProcessGroup: true };
}

export function buildTerminalSpawnOptions(
  _command: string,
  cwd: string,
  env: CreateTerminalRequest["env"],
): TerminalSpawnOptions {
  return {
    cwd,
    env: toEnvObject(env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  };
}

/** Export for tests — keep last N bytes on a UTF-8 boundary. */
export function trimToUtf8Boundary(buffer: Buffer, limit: number): Buffer {
  if (limit <= 0) {
    return Buffer.alloc(0);
  }
  if (buffer.length <= limit) {
    return buffer;
  }

  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }

  if (start >= buffer.length) {
    start = buffer.length - limit;
  }
  return buffer.subarray(start);
}

function waitForSpawn(
  proc: ChildProcessByStdio<null, Readable, Readable>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      proc.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      proc.off("spawn", onSpawn);
      reject(error);
    };

    proc.once("spawn", onSpawn);
    proc.once("error", onError);
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export class TerminalManager {
  private readonly cwd: string;
  private readonly killGraceMs: number;
  private readonly log: Logger;
  private readonly terminals = new Map<string, ManagedTerminal>();

  constructor(options: TerminalManagerOptions) {
    this.cwd = options.cwd;
    this.killGraceMs = Math.max(
      0,
      Math.round(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS),
    );
    this.log = (options.log ?? silentLogger()).child("terminal");
  }

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    const commandLine = toCommandLine(params.command, params.args);
    this.log.info("terminal/create", { command: commandLine });

    const outputByteLimit = Math.max(
      0,
      Math.round(params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES),
    );
    const { proc, spawnCommand } = await spawnTerminalProcess(params, this.cwd);

    let resolveExit: (response: WaitForTerminalExitResponse) => void =
      () => {};
    const exitPromise = new Promise<WaitForTerminalExitResponse>((resolve) => {
      resolveExit = resolve;
    });

    const terminal: ManagedTerminal = {
      process: proc,
      killProcessGroup: spawnCommand.killProcessGroup,
      descendantPids: new Set(),
      output: Buffer.alloc(0),
      truncated: false,
      outputByteLimit,
      exitCode: undefined,
      signal: undefined,
      exitPromise,
      resolveExit,
    };

    const appendOutput = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length === 0) {
        return;
      }

      terminal.output = Buffer.concat([terminal.output, bytes]);
      if (terminal.output.length > terminal.outputByteLimit) {
        terminal.output = trimToUtf8Boundary(
          terminal.output,
          terminal.outputByteLimit,
        );
        terminal.truncated = true;
      }
    };

    proc.stdout.on("data", appendOutput);
    proc.stderr.on("data", appendOutput);
    proc.once("exit", (exitCode, signal) => {
      terminal.exitCode = exitCode;
      terminal.signal = signal;
      terminal.processGroupSnapshotPromise = rememberProcessGroupPids(terminal);
      void (async () => {
        await terminal.processGroupSnapshotPromise;
        terminal.resolveExit({
          exitCode: exitCode ?? null,
          signal: signal ?? null,
        });
      })();
    });

    const terminalId = randomUUID();
    this.terminals.set(terminalId, terminal);
    this.log.info("terminal created", {
      terminalId,
      command: commandLine,
      outputByteLimit,
    });
    return { terminalId };
  }

  async terminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    const hasExitStatus =
      terminal.exitCode !== undefined || terminal.signal !== undefined;

    const result: TerminalOutputResponse = {
      output: terminal.output.toString("utf8"),
      truncated: terminal.truncated,
    };
    if (hasExitStatus) {
      result.exitStatus = {
        exitCode: terminal.exitCode ?? null,
        signal: terminal.signal ?? null,
      };
    }
    return result;
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }
    return await terminal.exitPromise;
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }
    await this.killProcess(terminal);
    return {};
  }

  async releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      return {};
    }
    try {
      await this.killProcess(terminal);
      await terminal.exitPromise.catch(() => {});
    } catch {
      /* best effort */
    }
    terminal.output = Buffer.alloc(0);
    this.terminals.delete(params.terminalId);
    return {};
  }

  async shutdown(): Promise<void> {
    const ids = [...this.terminals.keys()];
    await Promise.all(
      ids.map((terminalId) =>
        this.releaseTerminal({ terminalId } as ReleaseTerminalRequest).catch(
          () => {},
        ),
      ),
    );
  }

  private getTerminal(terminalId: string): ManagedTerminal | undefined {
    return this.terminals.get(terminalId);
  }

  private async killProcess(terminal: ManagedTerminal): Promise<void> {
    if (terminal.exitCode !== undefined || terminal.signal !== undefined) {
      await terminal.processGroupSnapshotPromise;
      return;
    }

    const pid = terminal.process.pid;
    if (!pid) {
      return;
    }

    if (process.platform === "win32") {
      await killWindowsProcessTree(pid, "SIGTERM");
      if (!(await this.waitForCleanupAfterSignal(terminal))) {
        await killWindowsProcessTree(pid, "SIGKILL");
        await this.waitForCleanupAfterSignal(terminal);
      }
      return;
    }

    if (terminal.killProcessGroup) {
      sendSignal(-pid, "SIGTERM");
    } else {
      sendSignal(pid, "SIGTERM");
    }
    await rememberDescendants(terminal, pid);

    if (!(await this.waitForCleanupAfterSignal(terminal))) {
      if (terminal.killProcessGroup) {
        sendSignal(-pid, "SIGKILL");
      } else {
        sendSignal(pid, "SIGKILL");
      }
      for (const descendantPid of terminal.descendantPids) {
        sendSignal(descendantPid, "SIGKILL");
      }
      await this.waitForCleanupAfterSignal(terminal);
    }
  }

  private async waitForCleanupAfterSignal(
    terminal: ManagedTerminal,
  ): Promise<boolean> {
    return await Promise.race([
      this.waitForTerminalAndTrackedDescendants(terminal).then(() => true),
      waitMs(this.killGraceMs).then(() => false),
    ]);
  }

  private async waitForTerminalAndTrackedDescendants(
    terminal: ManagedTerminal,
  ): Promise<void> {
    await terminal.exitPromise;
    while (hasLiveTerminalProcessGroup(terminal)) {
      await waitMs(25);
    }
    while (hasLivePid(terminal.descendantPids)) {
      await waitMs(25);
    }
  }
}

async function spawnTerminalProcess(
  params: CreateTerminalRequest,
  defaultCwd: string,
): Promise<{
  proc: ChildProcessByStdio<null, Readable, Readable>;
  spawnCommand: TerminalSpawnCommand;
}> {
  const directCommand = buildTerminalSpawnCommand(params.command, params.args);
  try {
    return {
      proc: await spawnAndWait(directCommand, params, defaultCwd),
      spawnCommand: directCommand,
    };
  } catch (error) {
    const fallbackCommand =
      params.args === undefined && isNotFoundSpawnError(error)
        ? buildTerminalFallbackSpawnCommand(
            params.command,
            params.cwd ?? defaultCwd,
          )
        : undefined;
    if (!fallbackCommand) {
      throw error;
    }
    return {
      proc: await spawnAndWait(fallbackCommand, params, defaultCwd),
      spawnCommand: fallbackCommand,
    };
  }
}

async function spawnAndWait(
  spawnCommand: TerminalSpawnCommand,
  params: CreateTerminalRequest,
  defaultCwd: string,
): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const spawnOptions = buildTerminalSpawnOptions(
    spawnCommand.command,
    params.cwd ?? defaultCwd,
    params.env,
  );
  if (spawnCommand.killProcessGroup) {
    spawnOptions.detached = true;
  }
  // Intentional shell fallback for ACP terminal/create (shell metacharacters).
  const proc = spawn(spawnCommand.command, spawnCommand.args, spawnOptions);
  await waitForSpawn(proc);
  return proc;
}

function isNotFoundSpawnError(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function buildTerminalFallbackSpawnCommand(
  command: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): TerminalSpawnCommand | undefined {
  if (commandPathExists(command, cwd)) {
    return undefined;
  }

  if (platform === "win32") {
    return hasWindowsShellSyntax(command) || /\s/u.test(command)
      ? buildTerminalShellSpawnCommand(command, platform)
      : undefined;
  }

  if (hasShellSyntax(command) || /\s/u.test(command)) {
    return buildTerminalShellSpawnCommand(command, platform);
  }

  return undefined;
}

function hasShellSyntax(command: string): boolean {
  return /[|&;<>()>$`*?[\]{}'"\\\r\n]/u.test(command);
}

function hasWindowsShellSyntax(command: string): boolean {
  return /[|&;<>()>$`*?[\]{}'"\r\n]/u.test(command);
}

function commandPathExists(command: string, cwd: string): boolean {
  if (!/[\\/]/u.test(command)) {
    return false;
  }
  const resolvedPath = path.isAbsolute(command)
    ? command
    : path.resolve(cwd, command);
  return fs.existsSync(resolvedPath);
}

async function listDescendantPids(rootPid: number): Promise<number[]> {
  let output: string;
  try {
    output = await runProcessListCommand();
  } catch {
    return [];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    addProcessListLine(childrenByParent, line);
  }

  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index]!;
    descendants.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function addProcessListLine(
  childrenByParent: Map<number, number[]>,
  line: string,
): void {
  const parsed = parseProcessListLine(line);
  if (!parsed) {
    return;
  }

  const children = childrenByParent.get(parsed.parentPid);
  if (children) {
    children.push(parsed.pid);
  } else {
    childrenByParent.set(parsed.parentPid, [parsed.pid]);
  }
}

function parseProcessListLine(
  line: string,
): { pid: number; parentPid: number } | undefined {
  const match = line.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) {
    return undefined;
  }

  const pid = Number(match[1]);
  const parentPid = Number(match[2]);
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(parentPid) ||
    pid <= 0 ||
    parentPid <= 0
  ) {
    return undefined;
  }
  return { pid, parentPid };
}

async function runProcessListCommand(): Promise<string> {
  if (process.platform === "win32") {
    return await runWindowsProcessListCommand();
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn("ps", ["-eo", "pid=,ppid="], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `ps exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr}`,
        ),
      );
    });
  });
}

async function rememberProcessGroupPids(
  terminal: ManagedTerminal,
): Promise<void> {
  const processGroupId = terminal.process.pid;
  if (!terminal.killProcessGroup || !processGroupId) {
    return;
  }

  if (process.platform === "win32") {
    for (const pid of await listDescendantPids(processGroupId)) {
      terminal.descendantPids.add(pid);
    }
    return;
  }

  for (const pid of await listProcessGroupPids(processGroupId)) {
    if (pid !== processGroupId) {
      terminal.descendantPids.add(pid);
    }
  }
}

async function rememberDescendants(
  terminal: ManagedTerminal,
  pid: number,
): Promise<void> {
  if (terminal.killProcessGroup) {
    await rememberProcessGroupPids(terminal);
    return;
  }
  for (const descendantPid of await listDescendantPids(pid)) {
    terminal.descendantPids.add(descendantPid);
  }
}

async function listProcessGroupPids(processGroupId: number): Promise<number[]> {
  let output: string;
  try {
    output = await runProcessGroupListCommand();
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (
      Number.isInteger(pid) &&
      Number.isInteger(pgid) &&
      pid > 0 &&
      pgid === processGroupId
    ) {
      pids.push(pid);
    }
  }
  return pids;
}

async function runProcessGroupListCommand(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("ps", ["-eo", "pid=,pgid="], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `ps exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr}`,
        ),
      );
    });
  });
}

async function runWindowsProcessListCommand(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const command = [
      "Get-CimInstance Win32_Process |",
      'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ].join(" ");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `powershell process list exited with code ${code ?? "null"} signal ${
            signal ?? "null"
          }: ${stderr}`,
        ),
      );
    });
  });
}

async function killWindowsProcessTree(
  pid: number,
  signal: NodeJS.Signals,
): Promise<void> {
  const args = ["/pid", String(pid), "/t"];
  if (signal === "SIGKILL") {
    args.push("/f");
  }
  await new Promise<void>((resolve) => {
    const child = spawn("taskkill", args, {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Best-effort: descendants can exit between discovery and kill.
  }
}

function hasLiveProcessGroup(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function hasLiveTerminalProcessGroup(terminal: ManagedTerminal): boolean {
  const pid = terminal.process.pid;
  return Boolean(
    terminal.killProcessGroup &&
      pid &&
      process.platform !== "win32" &&
      hasLiveProcessGroup(pid),
  );
}

function hasLivePid(pids: Set<number>): boolean {
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      pids.delete(pid);
    }
  }
  return false;
}
