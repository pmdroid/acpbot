import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandTilde,
  isDirectory,
  listSubdirectories,
} from "../src/setup/folder-browser";
import {
  findReposSectionRange,
  isValidRepoKey,
  parseReposFromToml,
  replaceReposSection,
  renderReposTomlSection,
  writeReposToConfig,
} from "../src/setup/repos-toml";
import {
  isRepoCliCommand,
  repoCliHelp,
  runRepoCli,
} from "../src/setup/repo-cli";
import { projectsFolderHint } from "../src/core/repo-required";

describe("repos-toml", () => {
  test("isValidRepoKey", () => {
    expect(isValidRepoKey("demo")).toBe(true);
    expect(isValidRepoKey("my-repo")).toBe(true);
    expect(isValidRepoKey("a_b.1")).toBe(true);
    expect(isValidRepoKey("")).toBe(false);
    expect(isValidRepoKey("-bad")).toBe(false);
    expect(isValidRepoKey("has space")).toBe(false);
  });

  test("renderReposTomlSection empty is commented stub", () => {
    const s = renderReposTomlSection({});
    expect(s).toContain("# [repos]");
    expect(s).not.toMatch(/^\[repos\]/m);
  });

  test("renderReposTomlSection sorts keys", () => {
    const s = renderReposTomlSection({
      zebra: "/z",
      alpha: "/a",
    });
    expect(s.indexOf("alpha")).toBeLessThan(s.indexOf("zebra"));
    expect(s).toContain('alpha = "/a"');
  });

  test("replaceReposSection inserts before [features]", () => {
    const body = `bot_token = "x"\n\n[features]\nmcp = true\n`;
    const next = replaceReposSection(body, { demo: "/tmp/demo" });
    expect(next).toContain("[repos]");
    expect(next).toContain('demo = "/tmp/demo"');
    expect(next.indexOf("[repos]")).toBeLessThan(next.indexOf("[features]"));
    expect(next).toContain("bot_token");
    expect(next).toContain("mcp = true");
  });

  test("replaceReposSection updates existing [repos]", () => {
    const body = `# header
bot_token = "x"

[repos]
old = "/old"
keep = "/keep"

[features]
mcp = true
`;
    const next = replaceReposSection(body, {
      keep: "/keep",
      neu: "/new",
    });
    expect(next).toContain('keep = "/keep"');
    expect(next).toContain('neu = "/new"');
    expect(next).not.toContain("old =");
    expect(next).toContain("[features]");
    expect(parseReposFromToml(next)).toEqual({
      keep: "/keep",
      neu: "/new",
    });
  });

  test("replaceReposSection replaces commented stub", () => {
    const body = `bot_token = "x"\n\n# [repos]\n# demo = "/absolute/path/to/repo"\n\n[features]\nmcp = true\n`;
    const next = replaceReposSection(body, { acpbot: "/code/acpbot" });
    expect(next).toMatch(/\[repos\]/);
    expect(next).not.toMatch(/# \[repos\]/);
    expect(parseReposFromToml(next).acpbot).toBe("/code/acpbot");
  });

  test("findReposSectionRange", () => {
    const lines = [
      "bot_token = \"x\"",
      "",
      "[repos]",
      'a = "/a"',
      "",
      "[features]",
      "mcp = true",
    ];
    const r = findReposSectionRange(lines);
    expect(r).toEqual({ start: 2, end: 4 });
  });

  test("writeReposToConfig round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpbot-repos-"));
    const path = join(dir, "config.toml");
    writeFileSync(
      path,
      `bot_token = "t"\n\n# [repos]\n# demo = "/x"\n\n[features]\nmcp = true\n`,
      "utf8",
    );
    writeReposToConfig(path, { demo: "/abs/demo", other: "/abs/other" });
    const body = readFileSync(path, "utf8");
    expect(parseReposFromToml(body)).toEqual({
      demo: "/abs/demo",
      other: "/abs/other",
    });
    expect(body).toContain("[features]");
    writeReposToConfig(path, {});
    const empty = readFileSync(path, "utf8");
    expect(empty).toContain("# [repos]");
    expect(parseReposFromToml(empty)).toEqual({});
  });
});

describe("folder-browser helpers", () => {
  test("listSubdirectories", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpbot-fb-"));
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, "beta"));
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, "file.txt"), "x");
    const kids = listSubdirectories(dir);
    expect(kids.map((k) => k.name).sort()).toEqual(["alpha", "beta"]);
    expect(listSubdirectories(dir, { includeHidden: true }).map((k) => k.name)).toContain(
      ".hidden",
    );
  });

  test("expandTilde and isDirectory", () => {
    expect(expandTilde("~/code", "/Users/me")).toBe(join("/Users/me", "code"));
    expect(expandTilde("~", "/Users/me")).toBe("/Users/me");
    const dir = mkdtempSync(join(tmpdir(), "acpbot-d-"));
    expect(isDirectory(dir)).toBe(true);
    expect(isDirectory(join(dir, "nope"))).toBe(false);
  });
});

describe("repo-cli", () => {
  test("isRepoCliCommand", () => {
    expect(isRepoCliCommand(["bun", "acpbot", "repo"])).toBe(true);
    expect(isRepoCliCommand(["bun", "acpbot", "repos", "list"])).toBe(true);
    expect(isRepoCliCommand(["bun", "acpbot", "setup"])).toBe(false);
  });

  test("repoCliHelp mentions browse", () => {
    expect(repoCliHelp()).toContain("browse");
    expect(repoCliHelp()).toContain("list");
    expect(repoCliHelp()).toContain("cannot start a Telegram session");
    expect(repoCliHelp()).toContain("one project folder");
  });

  test("projectsFolderHint says parent is not a workspace", () => {
    const h = projectsFolderHint();
    expect(h).toMatch(/parent directory/i);
    expect(h).toContain("acpbot repo add");
    expect(h).toContain("Use this folder");
  });

  test("runRepoCli list and add non-interactive", async () => {
    const home = mkdtempSync(join(tmpdir(), "acpbot-repo-cli-"));
    const cfgDir = join(home, ".config", "acpbot");
    const dataDir = join(home, ".local", "share", "acpbot");
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(cfgDir, "config.toml");
    writeFileSync(
      configPath,
      `bot_token = "123456:TESTTOKEN_ABCDEFGHIJKLMNOP"\n\n[features]\nmcp = true\n`,
      "utf8",
    );
    const repoDir = join(home, "code", "demo");
    mkdirSync(repoDir, { recursive: true });

    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    };

    const addCode = await runRepoCli(
      ["bun", "acpbot", "repo", "add", "demo", repoDir],
      { configPath, env },
    );
    expect(addCode).toBe(0);
    const body = readFileSync(configPath, "utf8");
    expect(parseReposFromToml(body).demo).toBe(repoDir);

    const listCode = await runRepoCli(["bun", "acpbot", "repo", "list"], {
      configPath,
      env,
    });
    expect(listCode).toBe(0);

    const pathCode = await runRepoCli(
      ["bun", "acpbot", "repo", "path", "demo"],
      { configPath, env },
    );
    expect(pathCode).toBe(0);

    const rmCode = await runRepoCli(
      ["bun", "acpbot", "repo", "remove", "demo"],
      { configPath, env },
    );
    expect(rmCode).toBe(0);
    expect(parseReposFromToml(readFileSync(configPath, "utf8"))).toEqual({});
  });
});
