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
  test("package skills/ contains telegram and schedules", async () => {
    const root = bundledSkillsRoot();
    const skills = await listSkills([root]);
    const ids = skills.map((s) => s.id).sort();
    expect(ids).toContain("telegram");
    expect(ids).toContain("schedules");
  });

  test("installBundledSkills links into global parents", async () => {
    const home = await mkdtemp(join(tmpdir(), "tacp-skills-home-"));
    const source = await mkdtemp(join(tmpdir(), "tacp-skills-src-"));
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

  test("loadConfig includes package skills root", () => {
    const cfg = loadConfig({
      env: {
        TACP_BOT_TOKEN: "t",
        TACP_OPERATOR_USER_ID: "1",
        TACP_STORE_PATH: "/tmp/tacp-store.json",
        TACP_ACPX_STATE_DIR: "/tmp/tacp-state",
        TACP_REPOS_JSON: "{}",
        HOME: "/tmp/home-no-skills",
      },
    });
    const roots = cfg.skillRoots ?? [];
    expect(
      roots.some((r) => r.endsWith("/skills") || r.endsWith("\\skills")),
    ).toBe(true);
  });
});
