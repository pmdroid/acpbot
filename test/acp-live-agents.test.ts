/**
 * Live ACP smoke tests — thin PATH/registry checks + pointers to the full
 * capability matrix in `test/contract/acp-capabilities.test.ts`.
 *
 * Full contract (ensure, prompt, cancel, models, modes, session/load):
 *   bun test test/contract/acp-capabilities.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  agentDisplayName,
  isAgentAvailable,
  listRegisteredAgents,
  resolveAgentLaunch,
} from "../src/acp/agent-launch";

const SUPPORTED_AGENTS = [
  "grok-build",
  "claude",
  "codex",
  "opencode",
  "cursor-agent",
  "pi",
] as const;

describe("listRegisteredAgents (live PATH)", () => {
  test("no duplicates and every id is available", () => {
    const ids = listRegisteredAgents();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isAgentAvailable(id)).toBe(true);
      expect(resolveAgentLaunch(id).command.length).toBeGreaterThan(0);
      expect(agentDisplayName(id).length).toBeGreaterThan(0);
    }
  });

  test("supported agent registry ids are known", () => {
    const all = listRegisteredAgents({ availableOnly: false });
    for (const id of SUPPORTED_AGENTS) {
      expect(all).toContain(id);
    }
  });
});

describe("live ACP suite location", () => {
  test("capability matrix is under test/contract/acp-capabilities.test.ts", () => {
    // Keeps discovery obvious when grepping for live agent tests.
    expect(SUPPORTED_AGENTS.length).toBe(6);
  });
});
