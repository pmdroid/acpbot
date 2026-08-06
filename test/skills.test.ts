import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSkillsKeyboard,
  clampSkillPage,
  composeSkillAgentPrompt,
  formatSkillsList,
  listSkills,
  parseSkillMarkdown,
  skillPageCount,
  skillRootsForSession,
  SKILL_CB,
  SKILL_PAGE_SIZE,
  workspaceSkillRoots,
  type SkillInfo,
} from "../src/core/skills";
import {
  encodeSkillCallback,
  parseSkillCallback,
} from "../src/core/callbacks";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { TelegramUpdate } from "../src/env/types";

describe("parseSkillMarkdown", () => {
  test("reads yaml frontmatter", () => {
    const md = `---
name: Help
description: Grok documentation and configuration help
---
# Body
`;
    const s = parseSkillMarkdown(md, "help");
    expect(s.name).toBe("Help");
    expect(s.description).toContain("Grok documentation");
  });

  test("falls back to heading and paragraph", () => {
    const md = `# My Skill\n\nDoes cool things for agents.\n`;
    const s = parseSkillMarkdown(md, "my-skill");
    expect(s.name).toBe("My Skill");
    expect(s.description).toContain("cool things");
  });
});

describe("listSkills", () => {
  test("discovers SKILL.md under a root", async () => {
    const root = join(import.meta.dir, "../.scratch-skills-test");
    const skillDir = join(root, "demo-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: Demo Skill
description: For unit tests only
---
`,
    );
    const skills = await listSkills([root]);
    expect(skills.some((s) => s.id === "demo-skill")).toBe(true);
    const demo = skills.find((s) => s.id === "demo-skill")!;
    expect(demo.description).toContain("unit tests");
  });
});

describe("skillRootsForSession", () => {
  test("includes workspace subdirs and global roots", () => {
    const roots = skillRootsForSession("/proj", ["/global/skills"]);
    expect(roots).toContain("/global/skills");
    expect(workspaceSkillRoots("/proj").every((r) => roots.includes(r))).toBe(
      true,
    );
  });
});

describe("formatSkillsList", () => {
  test("empty list is helpful", () => {
    expect(formatSkillsList([])).toContain("No SKILL.md");
  });
});

describe("/skills command", () => {
  const OPERATOR = 42;
  const CHAT = 1000;

  function root(text: string, id: number): TelegramUpdate {
    return {
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        text,
        from: { id: OPERATOR, first_name: "op" },
        chat: { id: CHAT, type: "private" },
      },
    };
  }

  function topic(
    threadId: number,
    text: string,
    id: number,
  ): TelegramUpdate {
    return {
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        text,
        from: { id: OPERATOR, first_name: "op" },
        chat: { id: CHAT, type: "private" },
        message_thread_id: threadId,
        is_topic_message: true,
      },
    };
  }

  test("topic /skills picker → text → agent prompt with skill", async () => {
    const skillRoot = join(import.meta.dir, "../.scratch-skills-topic");
    const skillDir = join(skillRoot, "topic-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: Topic Skill
description: Visible in topic /skills
---
`,
    );

    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
        skillRoots: [skillRoot],
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo skills-test", 1));
    const session = (await daemon.listSessions())[0]!;
    env.telegram.clearOutbound();

    await daemon.handleUpdate(topic(session.messageThreadId, "/skills", 2));
    expect(env.agents.turns).toHaveLength(0);
    const pickMsg = env.telegram
      .sentMessages()
      .find((m) => m.replyMarkup !== undefined);
    expect(pickMsg).toBeDefined();
    const kb = pickMsg!.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const skillBtn = kb.inline_keyboard
      .flat()
      .find((b) => b.text.includes("topic-skill"))!;
    expect(skillBtn).toBeDefined();
    const parsed = parseSkillCallback(skillBtn.callback_data);
    expect(parsed?.skillIndex).toBeGreaterThanOrEqual(0);

    await daemon.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cq-skill",
        from: { id: OPERATOR, first_name: "op" },
        data: skillBtn.callback_data,
        message: {
          message_id: pickMsg!.message_id,
          date: 0,
          chat: { id: CHAT, type: "private" },
          message_thread_id: session.messageThreadId,
          is_topic_message: true,
        },
      },
    });

    env.agents.queueTurn("demo/skills-test", {
      events: [
        { type: "turn_started" },
        { type: "agent_message_chunk", text: "ok" },
        { type: "turn_ended" },
      ],
    });

    await daemon.handleUpdate(
      topic(session.messageThreadId, "explain the README", 4),
    );
    expect(env.agents.turns).toHaveLength(1);
    const sent = env.agents.turns[0]!.input.text;
    expect(sent).toContain("topic-skill");
    expect(sent).toContain("explain the README");
  });

  test("composeSkillAgentPrompt includes skill and user text", () => {
    const p = composeSkillAgentPrompt({
      skillId: "help",
      skillName: "Help",
      userText: "how do I configure?",
    });
    expect(p).toContain("help");
    expect(p).toContain("how do I configure?");
  });

  test("skill callback encoding under 64 bytes", () => {
    const d = encodeSkillCallback("aabbccdd", 3);
    expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(64);
    expect(parseSkillCallback(d)).toEqual({ token: "aabbccdd", skillIndex: 3 });
  });

  test("pagination helpers and keyboard nav", () => {
    expect(skillPageCount(0)).toBe(1);
    expect(skillPageCount(8)).toBe(1);
    expect(skillPageCount(9)).toBe(2);
    expect(skillPageCount(24)).toBe(3);
    expect(clampSkillPage(-1, 20)).toBe(0);
    expect(clampSkillPage(99, 20)).toBe(2);

    const skills: SkillInfo[] = Array.from({ length: 20 }, (_, i) => ({
      id: `skill-${i}`,
      name: `Skill ${i}`,
      description: `desc ${i}`,
      path: `/s/${i}`,
      root: "/s",
    }));
    const page0 = buildSkillsKeyboard("tok", skills, 0);
    const flat0 = page0.inline_keyboard.flat();
    expect(flat0.some((b) => b.text === "Next ▶")).toBe(true);
    expect(flat0.some((b) => b.text === "◀ Prev")).toBe(false);
    expect(flat0.some((b) => b.text === "1/3")).toBe(true);
    expect(
      flat0.filter((b) => parseSkillCallback(b.callback_data)!.skillIndex >= 0),
    ).toHaveLength(SKILL_PAGE_SIZE);

    const page1 = buildSkillsKeyboard("tok", skills, 1);
    const flat1 = page1.inline_keyboard.flat();
    expect(flat1.some((b) => b.text === "◀ Prev")).toBe(true);
    expect(flat1.some((b) => b.text === "Next ▶")).toBe(true);
    const nextCb = flat1.find((b) => b.text === "Next ▶")!;
    expect(parseSkillCallback(nextCb.callback_data)?.skillIndex).toBe(
      SKILL_CB.next,
    );

    const list = formatSkillsList(skills, {
      page: 1,
      pageSize: SKILL_PAGE_SIZE,
      withButtons: true,
    });
    // Buttons carry skill ids — body is header + short prompt only.
    expect(list).toContain("2/3");
    expect(list).toMatch(/Tap a skill/i);
    expect(list).not.toContain("skill-0");
    // Skill ids live on the keyboard, not the message body.
    const page1Labels = flat1
      .map((b) => b.text)
      .filter((t) => t.startsWith("skill-"));
    expect(page1Labels.some((t) => t.includes("skill-8"))).toBe(true);
  });
});
