/**
 * Elicitation is handled by the thin ACP host (official SDK).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("elicitation on ACP SDK host", () => {
  test("session-host registers elicitation/create + Grok ask_user_question", () => {
    const host = readFileSync(
      join(import.meta.dir, "../src/acp/session-host.ts"),
      "utf8",
    );
    expect(host).toContain("methods.client.elicitation.create");
    expect(host).toContain("_x.ai/ask_user_question");
    expect(host).toContain("elicitation: {");
    expect(host).toContain("form: {}");
  });

  test("host maps accept/decline without timeout wrappers on the await", () => {
    const host = readFileSync(
      join(import.meta.dir, "../src/acp/session-host.ts"),
      "utf8",
    );
    expect(host).toContain("onElicitationRequest");
    expect(host).not.toMatch(/Promise\.race\(\s*\[\s*hooks\.onElicitation/);
  });
});
