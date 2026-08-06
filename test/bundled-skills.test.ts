import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bundledSkillsRoot,
  installBundledSkills,
} from "../src/core/bundled-skills";
import { listSkills } from "../src/core/skills";
import { loadConfig } from "../src/config";

describe("bundled skills", () => {
  test("package skills/ contains telegram, schedules, multi-agent, linear, eve", async () => {
    const root = bundledSkillsRoot();
    const skills = await listSkills([root]);
    const ids = skills.map((s) => s.id).sort();
    expect(ids).toContain("telegram");
    expect(ids).toContain("schedules");
    expect(ids).toContain("multi-agent");
    expect(ids).toContain("linear");
    expect(ids).toContain("eve");
  });

  test("installBundledSkills links into global parents", async () => {
    const home = await mkdtemp(join(tmpdir(), "acpbot-skills-home-"));
    const source = await mkdtemp(join(tmpdir(), "acpbot-skills-src-"));
    await mkdir(join(source, "telegram"), { recursive: true });
    await writeFile(
      join(source, "telegram", "SKILL.md"),
      `---\nname: telegram\ndescription: test\n---\n`,
    );
    await mkdir(join(source, "schedules"), { recursive: true });
    await writeFile(
      join(source, "schedules", "SKILL.md"),
      `---\nname: schedules\ndescription: test\n---\n`,
    );

    const g1 = join(home, ".agents", "skills");
    const g2 = join(home, ".grok", "skills");
    const result = await installBundledSkills({
      sourceRoot: source,
      globalParents: [g1, g2],
    });
    expect(result.errors).toEqual([]);
    expect(result.installed.length).toBe(4); // 2 skills × 2 parents
    // Symlink targets should resolve
    const link = await readlink(join(g1, "telegram"));
    expect(link).toContain("telegram");
    await rm(home, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });

  test("installBundledSkills does not delete a real skill directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "acpbot-skills-safe-"));
    const source = await mkdtemp(join(tmpdir(), "acpbot-skills-src-"));
    await mkdir(join(source, "telegram"), { recursive: true });
    await writeFile(
      join(source, "telegram", "SKILL.md"),
      `---\nname: telegram\ndescription: bundled\n---\n`,
    );

    const parent = join(home, ".agents", "skills");
    const userSkill = join(parent, "telegram");
    await mkdir(userSkill, { recursive: true });
    await writeFile(join(userSkill, "SKILL.md"), "user owned skill\n");
    await writeFile(join(userSkill, "keep-me.txt"), "do not delete\n");

    const result = await installBundledSkills({
      sourceRoot: source,
      globalParents: [parent],
    });

    expect(result.installed.some((i) => i.mode === "conflict")).toBe(true);
    expect(result.errors.some((e) => e.includes("will not overwrite"))).toBe(
      true,
    );
    // User files still present
    const keep = await Bun.file(join(userSkill, "keep-me.txt")).text();
    expect(keep).toBe("do not delete\n");

    await rm(home, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });

  test("main.ts does not auto-install skills on boot", async () => {
    const src = await Bun.file(
      join(import.meta.dir, "../src/main.ts"),
    ).text();
    expect(src).not.toContain("installBundledSkills");
    expect(src).not.toContain("ACPBOT_SKIP_SKILL_INSTALL");
  });

  test("loadConfig includes package skills root", () => {
    const cfg = loadConfig({
      env: {
        ACPBOT_BOT_TOKEN: "t",
        ACPBOT_OPERATOR_USER_ID: "1",
        ACPBOT_STORE_PATH: "/tmp/acpbot-store.json",
        ACPBOT_STATE_DIR: "/tmp/acpbot-state",
        ACPBOT_REPOS_JSON: "{}",
        HOME: "/tmp/home-no-skills",
      },
    });
    const roots = cfg.skillRoots ?? [];
    expect(
      roots.some((r) => r.endsWith("/skills") || r.endsWith("\\skills")),
    ).toBe(true);
  });

  test("ensureBundledSkillsRoot materialises embedded skills when package missing", async () => {
    const {
      ensureBundledSkillsRoot,
      materializeEmbeddedSkillsSync,
      defaultBundledSkillsDir,
    } = await import("../src/core/bundled-skills");
    const home = await mkdtemp(join(tmpdir(), "acpbot-embed-skills-"));
    const env = { HOME: home, XDG_DATA_HOME: join(home, "share") };
    const dest = defaultBundledSkillsDir(env);
    // Point fromDir at empty tree so package skills/ is not used
    const fakeCore = await mkdtemp(join(tmpdir(), "acpbot-fake-core-"));
    materializeEmbeddedSkillsSync(dest);
    const root = ensureBundledSkillsRoot(env, fakeCore);
    expect(root).toBe(dest);
    const tg = await Bun.file(join(dest, "telegram", "SKILL.md")).text();
    expect(tg).toContain("name: telegram");
    await rm(home, { recursive: true, force: true });
    await rm(fakeCore, { recursive: true, force: true });
  });
});
