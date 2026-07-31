import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeEnvironment } from "../src/env/fake-env";

describe("Environment port shape (single seam)", () => {
  test("fake environment exposes telegram, agents, clock, store, config", () => {
    const env = createFakeEnvironment();
    expect(env.telegram).toBeDefined();
    expect(env.agents).toBeDefined();
    expect(env.clock).toBeDefined();
    expect(env.store).toBeDefined();
    expect(env.config.operatorUserId).toBeDefined();
    expect(typeof env.telegram.getMe).toBe("function");
    expect(typeof env.telegram.getUpdates).toBe("function");
    expect(typeof env.telegram.sendMessage).toBe("function");
    expect(typeof env.telegram.createForumTopic).toBe("function");
    expect(typeof env.telegram.editForumTopic).toBe("function");
    expect(typeof env.agents.ensureSession).toBe("function");
    expect(typeof env.agents.runPromptTurn).toBe("function");
    expect(typeof env.clock.now).toBe("function");
    expect(typeof env.store.load).toBe("function");
    expect(typeof env.store.save).toBe("function");
  });

  test("types declare Environment composite port", () => {
    const types = readFileSync(
      join(import.meta.dir, "../src/env/types.ts"),
      "utf8",
    );
    expect(types).toContain("export type Environment");
    expect(types).toContain("telegram: TelegramPort");
    expect(types).toContain("agents: AgentsPort");
    expect(types).toContain("clock: Clock");
    expect(types).toContain("store: Store");
  });
});
