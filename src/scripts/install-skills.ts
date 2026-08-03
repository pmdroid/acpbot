#!/usr/bin/env bun
/**
 * Dev convenience wrapper — prefer the binary:
 *   acpbot skills install
 *
 * This script forwards to the same CLI implementation.
 */
import { runSkillsCli } from "../setup/skills-cli";

const code = await runSkillsCli([
  process.argv[0] ?? "bun",
  process.argv[1] ?? "skills",
  "skills",
  "install",
  ...process.argv.slice(2),
]);
process.exitCode = code;
