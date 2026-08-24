/**
 * CLI: acpbot skills install | list | help
 *
 * Installs embedded (or package) skills into global agent skill dirs.
 * No Bun / source checkout required — works from the release binary.
 */
import { createLogger } from "../env/logger";
import {
  defaultGlobalSkillParents,
  ensureBundledSkillsRoot,
  installBundledSkills,
  listBundledSkillIds,
} from "../core/bundled-skills";

export function isSkillsCliCommand(argv: string[] = process.argv): boolean {
  const args = argv.slice(2);
  return args[0] === "skills" || args[0] === "skill";
}

export function skillsCliHelp(): string {
  return `Skills (operator skills for coding agents)
  acpbot skills install         Install bundled skills into global agent dirs
  acpbot skills list            Show bundled skill ids and source path
  acpbot skills help            This help

Install targets (symlink preferred, copy fallback):
  ~/.agents/skills/{telegram,schedules,multi-agent,eve,autoreview,…}
  ~/.grok/skills/…
  ~/.claude/skills/…

Source: package skills/ when present, else embedded skills materialised under
  ~/.local/share/acpbot/bundled-skills/

The worker does not install skills on boot — run install once after setup
(or after skill upgrades).`;
}

export async function runSkillsCli(
  argv: string[] = process.argv,
): Promise<number> {
  const args = argv.slice(2);
  const sub = (args[1] ?? "help").toLowerCase();

  if (
    !args[1] ||
    sub === "help" ||
    sub === "-h" ||
    sub === "--help"
  ) {
    console.log(skillsCliHelp());
    return 0;
  }

  if (sub === "list" || sub === "ls") {
    const source = ensureBundledSkillsRoot();
    const ids = listBundledSkillIds(source);
    console.log(`source: ${source}`);
    if (ids.length === 0) {
      console.log("No bundled skills found.");
      return 1;
    }
    for (const id of ids) console.log(`  ${id}`);
    return 0;
  }

  if (sub === "install" || sub === "i") {
    const log = createLogger({ level: "info", name: "acpbot-skills" });
    const source = ensureBundledSkillsRoot();
    const result = await installBundledSkills({ sourceRoot: source, log });
    console.log(`source: ${result.source}`);
    console.log(`global parents: ${defaultGlobalSkillParents().join(", ")}`);
    for (const row of result.installed) {
      console.log(`  ${row.mode.padEnd(7)} ${row.target}`);
    }
    if (result.errors.length) {
      console.error("errors:");
      for (const e of result.errors) console.error(`  ${e}`);
      return 1;
    }
    console.log("done.");
    return 0;
  }

  console.error(`Unknown skills subcommand: ${args[1]}`);
  console.error("");
  console.log(skillsCliHelp());
  return 2;
}
