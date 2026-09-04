#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SKILL_DIR, "../../..");
const RUNS_DIR = join(SKILL_DIR, "runs");
const ARTIFACTS_DIR = join(SKILL_DIR, "artifacts");
const CURRENT = join(RUNS_DIR, "current.json");

const BOT_TOKEN = "999999:verify-acpbot-mock-token-xxxxxxxx";
const OPERATOR_USER = 42;
const OPERATOR_CHAT = 1000;

type ChildSpec = { name: string; pid: number; log: string };
type Meta = {
  runId: string;
  mode: "local" | "docker";
  createdAt: string;
  runDir: string;
  artifactsDir: string;
  mockUrl: string;
  configPath: string;
  stateDir: string;
  storePath: string;
  composeProject?: string;
  children: ChildSpec[];
};

function die(msg: string): never {
  throw new Error(msg);
}

function loadMeta(): Meta {
  if (!existsSync(CURRENT)) die("no current run — launch first");
  return JSON.parse(readFileSync(CURRENT, "utf8")) as Meta;
}

function saveMeta(meta: Meta): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(CURRENT, JSON.stringify(meta, null, 2));
  writeFileSync(join(meta.runDir, "meta.json"), JSON.stringify(meta, null, 2));
}

function assertIsolated(path: string): void {
  const home = process.env.HOME ?? "";
  const banned = [
    join(home, ".config/acpbot"),
    join(home, ".local/share/acpbot"),
  ];
  for (const b of banned) {
    if (path === b || path.startsWith(`${b}/`)) {
      die(`refusing to drive operator install at ${path}`);
    }
  }
}

function repoToml(opts: {
  storePath: string;
  stateDir: string;
  demo: string;
  remote: string;
  extra?: string;
  echo?: boolean;
}): string {
  const echo = join(SCRIPT_DIR, "echo-acp.ts");
  const commandJson = JSON.stringify({
    echo: { command: "bun", args: [echo] },
  });
  return `bot_token = "${BOT_TOKEN}"
store_path = "${opts.storePath}"
state_dir = "${opts.stateDir}"
default_agent = "echo"
log_level = "debug"

[repos]
demo = "${opts.demo}"

[repos.remote]
path = "${opts.remote}"
host = "remote"

[features]
mcp = false
tts_mode = "off"
permission_mode = "bypass"
${opts.echo === false ? "" : `
[agents]
command_json = '''${commandJson}'''
`}
${opts.extra ?? ""}
`;
}

function seedOperator(stateDir: string): void {
  const dir = join(stateDir, "pairing");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "operator.json"),
    JSON.stringify({
      userId: OPERATOR_USER,
      chatId: OPERATOR_CHAT,
      pairedAt: Date.now(),
    }),
  );
}

function seedRepos(runDir: string): void {
  mkdirSync(join(runDir, "repos", "demo"), { recursive: true });
  mkdirSync(join(runDir, "repos", "remote"), { recursive: true });
}

function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(ACPBOT|TACP)_OAUTH_/.test(key)) delete env[key];
  }
  delete env.ACPBOT_ACP_HOST_SOCK;
  delete env.ACPBOT_ACP_HOST_URL;
  delete env.ACPBOT_HOST_LISTEN_PORT;
  delete env.ACPBOT_HOST_TOKEN;
  return env;
}

function spawnLogged(
  name: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  logPath: string,
  cwd = REPO_ROOT,
): ChildProcess {
  const fd = createWriteStream(logPath, { flags: "a" });
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(fd, { end: false });
  child.stderr?.pipe(fd, { end: false });
  child.on("exit", () => {
    fd.end();
  });
  if (!child.pid) die(`failed to start ${name}`);
  console.error(`started ${name} pid=${child.pid} log=${logPath}`);
  return child;
}

async function waitFile(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await Bun.sleep(50);
  }
  die(`timeout waiting for ${path}`);
}

async function waitLog(
  path: string,
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(needle)) return;
    await Bun.sleep(50);
  }
  die(`timeout waiting for ${JSON.stringify(needle)} in ${path}`);
}

async function waitHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(50);
  }
  die(`timeout waiting for ${url}`);
}

async function mockGet(meta: Meta, path: string): Promise<unknown> {
  const res = await fetch(`${meta.mockUrl}${path}`);
  if (!res.ok) die(`mock ${path} -> ${res.status}`);
  return res.json();
}

async function mockPost(meta: Meta, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${meta.mockUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) die(`mock ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function workerEnv(meta: Meta): NodeJS.ProcessEnv {
  return childEnv({
    HOME: meta.runDir,
    ACPBOT_CONFIG: meta.configPath,
    ACPBOT_STATE_DIR: meta.stateDir,
    ACPBOT_STORE_PATH: meta.storePath,
    ACPBOT_TELEGRAM_API_BASE: meta.mockUrl,
    ACPBOT_BOT_TOKEN: BOT_TOKEN,
  });
}

function killChild(child: ChildProcess): void {
  if (child.pid) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

async function cmdLaunch(mode: "local" | "docker"): Promise<Meta> {
  if (existsSync(CURRENT)) {
    die("a run is already current — cleanup first");
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const runDir = join(RUNS_DIR, runId);
  const artifactsDir = join(ARTIFACTS_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(join(runDir, "state"), { recursive: true });
  seedRepos(runDir);
  seedOperator(join(runDir, "state"));
  const configPath = join(runDir, "config.toml");
  const stateDir = join(runDir, "state");
  const storePath = join(runDir, "store.json");
  assertIsolated(stateDir);
  assertIsolated(configPath);

  if (mode === "docker") {
    const composeProject = `acpbot-verify-${process.pid}`;
    writeFileSync(
      configPath,
      repoToml({
        storePath: "/data/store.json",
        stateDir: "/data/state",
        demo: "/data/repos/demo",
        remote: "/data/repos/remote",
        echo: false,
        extra: `
[hosts.remote]
kind = "wss"
url = "ws://host-remote:8790"
token = "verify-host-token"
`,
      }),
    );
    const composeFile = join(SKILL_DIR, "docker-compose.yml");
    const child = spawn(
      "docker",
      [
        "compose",
        "-p",
        composeProject,
        "-f",
        composeFile,
        "up",
        "--build",
        "-d",
      ],
      {
        cwd: SKILL_DIR,
        env: {
          ...process.env,
          ACPBOT_VERIFY_RUN_DIR: runDir,
          ACPBOT_VERIFY_REPO: REPO_ROOT,
          ACPBOT_VERIFY_CONFIG: configPath,
        },
        stdio: "inherit",
      },
    );
    const code: number = await new Promise((resolveExit) => {
      child.on("exit", (c) => resolveExit(c ?? 1));
    });
    if (code !== 0) die(`docker compose up failed (${code})`);
    const mockUrl = "http://127.0.0.1:18080";
    await waitHttp(`${mockUrl}/_mock/health`, 60_000);
    const meta: Meta = {
      runId,
      mode,
      createdAt: new Date().toISOString(),
      runDir,
      artifactsDir,
      mockUrl,
      configPath,
      stateDir,
      storePath,
      composeProject,
      children: [],
    };
    saveMeta(meta);
    console.log(JSON.stringify({ ok: true, runId, mockUrl, mode }, null, 2));
    return meta;
  }

  writeFileSync(
    configPath,
    repoToml({
      storePath,
      stateDir,
      demo: join(runDir, "repos", "demo"),
      remote: join(runDir, "repos", "remote"),
      extra: `
[hosts.remote]
kind = "wss"
url = "ws://127.0.0.1:18790"
token = "verify-host-token"
`,
    }),
  );

  const started: ChildProcess[] = [];
  try {
    const mockLog = join(runDir, "telegram-mock.log");
    const mock = spawnLogged(
      "telegram-mock",
      ["bun", join(SCRIPT_DIR, "telegram-mock.ts"), "--token", BOT_TOKEN, "--port", "0"],
      childEnv({}),
      mockLog,
      SCRIPT_DIR,
    );
    started.push(mock);
    await waitLog(mockLog, "telegram-mock listening", 5_000);
    const mockLine = readFileSync(mockLog, "utf8")
      .split("\n")
      .find((l) => l.startsWith("telegram-mock listening "));
    const mockUrl = mockLine?.slice("telegram-mock listening ".length).trim();
    if (!mockUrl) die("mock did not print listen url");
    await waitHttp(`${mockUrl}/_mock/health`, 5_000);

    const hostLog = join(runDir, "host.log");
    const host = spawnLogged(
      "host",
      ["bun", "--no-env-file", "run", "src/main.ts", "host"],
      childEnv({
        HOME: runDir,
        ACPBOT_CONFIG: configPath,
        ACPBOT_STATE_DIR: stateDir,
        ACPBOT_STORE_PATH: storePath,
      }),
      hostLog,
    );
    started.push(host);
    await waitLog(hostLog, "acpbot host listening", 10_000);
    await waitFile(join(stateDir, "acp-host.sock"), 10_000);
    if (host.exitCode !== null) die(`host exited ${host.exitCode}`);

    const workerLog = join(runDir, "worker.log");
    const worker = spawnLogged(
      "worker",
      ["bun", "--no-env-file", "run", "src/main.ts", "worker"],
      childEnv({
        HOME: runDir,
        ACPBOT_CONFIG: configPath,
        ACPBOT_STATE_DIR: stateDir,
        ACPBOT_STORE_PATH: storePath,
        ACPBOT_TELEGRAM_API_BASE: mockUrl,
        ACPBOT_BOT_TOKEN: BOT_TOKEN,
      }),
      workerLog,
    );
    started.push(worker);
    await waitLog(workerLog, "acp-host: ok", 15_000);
    if (worker.exitCode !== null) die(`worker exited ${worker.exitCode}`);

    const meta: Meta = {
      runId,
      mode,
      createdAt: new Date().toISOString(),
      runDir,
      artifactsDir,
      mockUrl,
      configPath,
      stateDir,
      storePath,
      children: [
        { name: "telegram-mock", pid: mock.pid!, log: mockLog },
        { name: "host", pid: host.pid!, log: hostLog },
        { name: "worker", pid: worker.pid!, log: workerLog },
      ],
    };
    saveMeta(meta);
    console.log(JSON.stringify({ ok: true, runId, mockUrl, mode }, null, 2));
    return meta;
  } catch (err) {
    for (const c of [...started].reverse()) killChild(c);
    await Bun.sleep(200);
    for (const c of started) {
      if (c.pid) {
        try {
          process.kill(c.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
    throw err;
  }
}

async function cmdDoctor(): Promise<void> {
  const meta = loadMeta();
  assertIsolated(meta.stateDir);
  const report: Record<string, unknown> = {
    runId: meta.runId,
    mode: meta.mode,
    mockUrl: meta.mockUrl,
  };
  const health = (await mockGet(meta, "/_mock/health")) as {
    ok?: boolean;
  };
  report.mock = health;
  if (!health.ok) die("mock unhealthy");

  if (meta.mode === "local") {
    const sock = join(meta.stateDir, "acp-host.sock");
    report.hostSock = existsSync(sock);
    if (!existsSync(sock)) die(`missing host sock ${sock}`);
    for (const c of meta.children) {
      let alive = false;
      try {
        process.kill(c.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      report[`${c.name}Alive`] = alive;
      if (!alive) die(`${c.name} pid ${c.pid} is dead`);
    }
    const workerLog = meta.children.find((c) => c.name === "worker")?.log;
    if (workerLog && existsSync(workerLog)) {
      const text = readFileSync(workerLog, "utf8");
      report.workerHostOk = text.includes("acp-host: ok");
      if (!text.includes("acp-host: ok")) die("worker log missing acp-host: ok");
    }
  }

  const pair = spawnSyncPair(meta);
  report.pair = pair;
  writeFileSync(
    join(meta.artifactsDir, "doctor.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
}

function spawnSyncPair(meta: Meta): string {
  const r = Bun.spawnSync({
    cmd: ["bun", "--no-env-file", "run", "src/main.ts", "pair", "status"],
    cwd: REPO_ROOT,
    env: workerEnv(meta),
    stdout: "pipe",
    stderr: "pipe",
  });
  return `${r.stdout.toString()}${r.stderr.toString()}`.trim();
}

async function cmdInject(text: string, extra: Record<string, unknown> = {}): Promise<void> {
  const meta = loadMeta();
  const result = await mockPost(meta, "/_mock/inject", {
    text,
    userId: OPERATOR_USER,
    chatId: OPERATOR_CHAT,
    ...extra,
  });
  writeFileSync(
    join(meta.artifactsDir, "last-inject.json"),
    JSON.stringify({ text, extra, result, at: new Date().toISOString() }, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}

async function cmdOutbound(): Promise<unknown> {
  const meta = loadMeta();
  const data = await mockGet(meta, "/_mock/outbound");
  writeFileSync(
    join(meta.artifactsDir, "outbound.json"),
    JSON.stringify(data, null, 2),
  );
  console.log(JSON.stringify(data, null, 2));
  return data;
}

async function cmdWait(needle: string, timeoutMs: number): Promise<void> {
  const meta = loadMeta();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = (await mockGet(meta, "/_mock/outbound")) as {
      outbound?: Array<{ method: string; body?: { text?: string } }>;
    };
    const texts = (data.outbound ?? [])
      .filter((c) => c.method === "sendMessage")
      .map((c) => String(c.body?.text ?? ""));
    if (texts.some((t) => t.includes(needle))) {
      writeFileSync(
        join(meta.artifactsDir, "outbound.json"),
        JSON.stringify(data, null, 2),
      );
      writeFileSync(
        join(meta.artifactsDir, "wait.json"),
        JSON.stringify(
          { needle, matched: true, at: new Date().toISOString() },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ ok: true, needle }, null, 2));
      return;
    }
    await Bun.sleep(100);
  }
  die(`timeout waiting for sendMessage containing ${JSON.stringify(needle)}`);
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

async function cmdCleanup(): Promise<void> {
  if (!existsSync(CURRENT)) {
    console.log(JSON.stringify({ ok: true, skipped: "no current run" }));
    return;
  }
  const meta = loadMeta();
  if (meta.mode === "docker" && meta.composeProject) {
    Bun.spawnSync({
      cmd: [
        "docker",
        "compose",
        "-p",
        meta.composeProject,
        "-f",
        join(SKILL_DIR, "docker-compose.yml"),
        "down",
        "-v",
      ],
      cwd: SKILL_DIR,
      stdout: "inherit",
      stderr: "inherit",
    });
  }
  for (const c of [...meta.children].reverse()) {
    killPid(c.pid);
  }
  await Bun.sleep(300);
  for (const c of meta.children) {
    try {
      process.kill(c.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (existsSync(meta.runDir)) {
    rmSync(meta.runDir, { recursive: true, force: true });
  }
  rmSync(CURRENT, { force: true });
  console.log(
    JSON.stringify({
      ok: true,
      cleaned: meta.runId,
      artifacts: meta.artifactsDir,
      artifactsExist: existsSync(meta.artifactsDir),
    }),
  );
}

async function cmdProvePing(): Promise<void> {
  let artifactsDir = "";
  let outboundPath = "";
  let pingPath = "";
  try {
    await cmdLaunch("local");
    await cmdDoctor();
    await mockPost(loadMeta(), "/_mock/reset-outbound", {});
    await cmdInject("/ping");
    await cmdWait("pong", 8_000);
    const meta = loadMeta();
    artifactsDir = meta.artifactsDir;
    outboundPath = join(meta.artifactsDir, "outbound.json");
    pingPath = join(meta.artifactsDir, "lobby-ping.json");
    writeFileSync(
      pingPath,
      JSON.stringify(
        {
          feature: "lobby-ping",
          entry: "/ping in lobby",
          action: "inject /ping",
          resultFile: outboundPath,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    await cmdCleanup();
  }
  if (!existsSync(outboundPath) || !existsSync(pingPath)) {
    die("cleanup removed evidence");
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        proved: "lobby-ping",
        artifacts: artifactsDir,
      },
      null,
      2,
    ),
  );
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === "help" || cmd === "-h") {
  console.log(`verify-acpbot

Usage:
  bun .agents/skills/verify-acpbot/scripts/verify.ts launch
  bun .agents/skills/verify-acpbot/scripts/verify.ts launch-docker
  bun .agents/skills/verify-acpbot/scripts/verify.ts doctor
  bun .agents/skills/verify-acpbot/scripts/verify.ts inject --text "/ping"
  bun .agents/skills/verify-acpbot/scripts/verify.ts outbound
  bun .agents/skills/verify-acpbot/scripts/verify.ts wait --contains pong
  bun .agents/skills/verify-acpbot/scripts/verify.ts cleanup
  bun .agents/skills/verify-acpbot/scripts/verify.ts prove-ping
`);
  process.exit(0);
}

function argValue(name: string, fallback?: string): string {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  die(`missing --${name}`);
}

try {
  if (cmd === "launch") await cmdLaunch("local");
  else if (cmd === "launch-docker") await cmdLaunch("docker");
  else if (cmd === "doctor") await cmdDoctor();
  else if (cmd === "inject") await cmdInject(argValue("text"));
  else if (cmd === "outbound") await cmdOutbound();
  else if (cmd === "wait")
    await cmdWait(argValue("contains"), Number(argValue("timeout-ms", "8000")));
  else if (cmd === "cleanup") await cmdCleanup();
  else if (cmd === "prove-ping") await cmdProvePing();
  else die(`unknown command ${cmd}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
