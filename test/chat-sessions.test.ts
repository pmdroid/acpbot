import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  childSlugOf,
  formatSessionKey,
  formatSessionTree,
  loadFocus,
  mergeSessionLists,
  parseSessionKey,
  resolveSessionRef,
  saveFocus,
  slotsToRefs,
  type ChatSessionRef,
} from "../src/chat/sessions";

describe("parseSessionKey / formatSessionKey", () => {
  test("repo/name", () => {
    expect(parseSessionKey("acpbot/main")).toEqual({
      repo: "acpbot",
      name: "main",
    });
    expect(formatSessionKey("acpbot", "main")).toBe("acpbot/main");
  });

  test("child slug", () => {
    expect(parseSessionKey("acpbot/main--eve-x")).toEqual({
      repo: "acpbot",
      name: "main",
      slug: "eve-x",
    });
    expect(childSlugOf("acpbot/main--eve-x")).toBe("eve-x");
  });

  test("rejects bad keys", () => {
    expect(() => parseSessionKey("noshort")).toThrow();
    expect(() => parseSessionKey("/no")).toThrow();
  });
});

describe("resolveSessionRef", () => {
  const listed: ChatSessionRef[] = [
    {
      sessionKey: "acpbot/main",
      agent: "grok-build",
      cwd: "/r",
      slug: undefined,
    },
    {
      sessionKey: "acpbot/main--impl",
      agent: "grok-build",
      cwd: "/r",
      slug: "impl",
    },
    {
      sessionKey: "demo/chat",
      agent: "grok-build",
      cwd: "/d",
    },
  ];

  test("by index", () => {
    expect(resolveSessionRef("1", listed).sessionKey).toBe("acpbot/main");
    expect(resolveSessionRef("#2", listed).sessionKey).toBe(
      "acpbot/main--impl",
    );
  });

  test("by full key", () => {
    expect(resolveSessionRef("demo/chat", listed).sessionKey).toBe(
      "demo/chat",
    );
  });

  test("by slug", () => {
    expect(resolveSessionRef("impl", listed).sessionKey).toBe(
      "acpbot/main--impl",
    );
  });

  test("by name with defaultRepo", () => {
    expect(
      resolveSessionRef("chat", listed, { defaultRepo: "demo" }).sessionKey,
    ).toBe("demo/chat");
  });

  test("out of range index", () => {
    expect(() => resolveSessionRef("9", listed)).toThrow(/index/);
  });
});

describe("mergeSessionLists + format", () => {
  test("live wins over durable", () => {
    const merged = mergeSessionLists(
      slotsToRefs([
        {
          slotKey: "acpbot/main",
          agent: "grok-build",
          cwd: "/r",
          busy: true,
          agentSessionId: "a",
        },
      ]),
      [{ sessionKey: "acpbot/main", agent: "old", cwd: "/old" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.busy).toBe(true);
    expect(merged[0]!.agent).toBe("grok-build");
  });

  test("formatSessionTree marks focus", () => {
    const tree = formatSessionTree(
      [
        { sessionKey: "a/main", agent: "g", cwd: "/" },
        { sessionKey: "b/x", agent: "g", cwd: "/", busy: true },
      ],
      "b/x",
    );
    expect(tree).toContain("*2. b/x");
    expect(tree).toContain(" busy");
  });
});

describe("focus persistence", () => {
  test("save and load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-focus-"));
    try {
      await saveFocus(dir, "acpbot/main");
      const f = await loadFocus(dir);
      expect(f.focusKey).toBe("acpbot/main");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
