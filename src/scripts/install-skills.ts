#!/usr/bin/env bun
/**
 * Install acpbot bundled skills into global agent skill dirs.
 *   bun run skills:install
 */
import { createLogger } from "../env/logger";
import {
  bundledSkillsRoot,
  defaultGlobalSkillParents,
  installBundledSkills,
} from "../core/bundled-skills";

const log = createLogger({ level: "info", name: "acpbot-skills" });

const result = await installBundledSkills({ log });
console.log("source:", result.source || bundledSkillsRoot());
console.log("global parents:", defaultGlobalSkillParents().join(", "));
for (const row of result.installed) {
  console.log(`  ${row.mode.padEnd(7)} ${row.target}`);
}
if (result.errors.length) {
  console.error("errors:");
  for (const e of result.errors) console.error(" ", e);
  process.exitCode = 1;
} else {
  console.log("done.");
}
