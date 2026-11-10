import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExternalBridge } from "../src/core/external-bridge";
import { createFakeEnvironment } from "../src/env/fake-env";
import { createDaemon } from "../src/core/daemon";

test("external sessions: isolation, blocking reply, retries, restart and owner gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-external-"));
  try {
    const env = createFakeEnvironment();
    const options = { store: env.store, telegram: env.telegram, operator: () => ({ userId: 42, chatId: 1000 }) };
    let bridge = createExternalBridge(options);
    const connect = (session_id: string, agent = "mimo") => bridge.request("connect", { agent, session_id, name: session_id, repo_root: root });
    const a = await connect("one"); const b = await connect("two", "codex");
    expect((await connect("one")).binding_id).toBe(a.binding_id);
    expect(a.topic_id).not.toBe(b.topic_id);
    expect(env.telegram.outbound.filter(x => x.method === "createForumTopic")).toHaveLength(2);
    function message(id: number, thread = a.topic_id, from = 42, text = "answer") {
      return { update_id: id, message: { message_id: id, date: 0, text, from: { id: from }, chat: { id: 1000, type: "private" as const }, message_thread_id: thread as number } };
    }
    await bridge.handleUpdate(message(1, a.topic_id, 99, "intruder"));
    expect((await bridge.request("receive", { binding_id: a.binding_id })).messages).toEqual([]);
    await bridge.handleUpdate(message(2, a.topic_id, 42, "old command"));
    const q = await bridge.request("ask", { binding_id: a.binding_id, request_id: "question-1", question: "Which option?", wait_seconds: 0 });
    expect(q.timed_out).toBe(true);
    const sent = env.telegram.sentMessages().length;
    const retry = await bridge.request("ask", { binding_id: a.binding_id, request_id: "question-1", question: "Which option?", wait_seconds: 0 });
    expect(retry.question_id).toBe(q.question_id);
    expect(env.telegram.sentMessages()).toHaveLength(sent);
    await expect(bridge.request("ask", { binding_id: a.binding_id, request_id: "another", question: "Second?", wait_seconds: 0 })).rejects.toThrow("already awaiting");
    const waiting = bridge.request("wait-reply", { binding_id: a.binding_id, question_id: q.question_id, wait_seconds: 2 });
    await bridge.handleUpdate(message(3, b.topic_id, 42, "other session"));
    const topicAnswer = message(4);
    // Telegram sets reply_to_message to the topic-root even for plain text.
    (topicAnswer.message as any).reply_to_message = { message_id: a.topic_id };
    await bridge.handleUpdate(topicAnswer);
    await bridge.handleUpdate(message(4));
    const answered = await waiting;
    expect(answered.timed_out).toBe(false);
    expect((answered.messages as any[]).map(x => x.text)).toEqual(["answer"]);
    // Reloading the service preserves queued instructions and completed answers.
    bridge = createExternalBridge(options);
    expect((await bridge.request("wait-reply", { binding_id: a.binding_id, question_id: q.question_id, wait_seconds: 0 })).messages).toEqual(answered.messages);
    const inbox = await bridge.request("receive", { binding_id: a.binding_id });
    expect((inbox.messages as any[]).map(x => x.text)).toEqual(["old command", "answer"]);
    expect((await bridge.request("receive", { binding_id: a.binding_id, after_id: inbox.next_after_id })).messages).toEqual([]);
    const next = await bridge.request("ask", { binding_id: a.binding_id, request_id: "question-2", question: "More?", wait_seconds: 0 });
    await bridge.request("cancel-question", { binding_id: a.binding_id, question_id: next.question_id });
    expect((await bridge.request("wait-reply", { binding_id: a.binding_id, question_id: next.question_id })).cancelled).toBe(true);
    await expect(bridge.request("ask", { binding_id: a.binding_id, request_id: "question-1", question: "Changed question" })).rejects.toThrow("different question");
    const otherOwner = createExternalBridge({ ...options, operator: () => ({ userId: 99, chatId: 1000 }) });
    await expect(otherOwner.request("notify", { binding_id: a.binding_id, text: "bad" })).rejects.toThrow("Unknown binding");
    expect(await bridge.handleUpdate(message(5, 99999))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uploads are confined to the registered workspace including symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-uploads-"));
  const outside = await mkdtemp(join(tmpdir(), "tg-outside-"));
  try {
    const env = createFakeEnvironment();
    const bridge = createExternalBridge({ store: env.store, telegram: env.telegram, operator: () => ({ userId: 42, chatId: 1000 }) });
    const b = await bridge.request("connect", { agent: "mimo", session_id: "files", name: "files", repo_root: root });
    await writeFile(join(root,"report.txt"), "hello");
    await writeFile(join(outside,"secret.txt"), "outside");
    await symlink(join(outside,"secret.txt"), join(root,"escape.txt"));
    await expect(bridge.request("file", { binding_id: b.binding_id, path: join(outside,"secret.txt") })).rejects.toThrow("escapes");
    await expect(bridge.request("file", { binding_id: b.binding_id, path: "escape.txt" })).rejects.toThrow("escapes");
    expect((await bridge.request("file", { binding_id: b.binding_id, path: "report.txt" })).bytes).toBe(5);
  } finally { await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
});

test("daemon queues an external topic message without launching an agent or forwarding text", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-routing-"));
  try {
    const env = createFakeEnvironment({ config: { operatorUserId: 42, operatorChatId: 1000 } });
    const bridge = createExternalBridge({ store: env.store, telegram: env.telegram, operator: () => ({userId:42,chatId:1000}) });
    const b = await bridge.request("connect", {agent:"mimo",session_id:"native",name:"existing session",repo_root:root});
    env.telegram.clearOutbound();
    const daemon = createDaemon(env, { stateDir: root });
    await daemon.handleUpdate({update_id:99,message:{message_id:99,date:0,text:"Change the plan",from:{id:42},chat:{id:1000,type:"private"},message_thread_id:b.topic_id as number}});
    expect(env.agents.ensureCalls).toHaveLength(0);
    expect(env.agents.turns).toHaveLength(0);
    expect(env.telegram.sentMessages()).toHaveLength(0);
    expect(((await bridge.request("receive", {binding_id:b.binding_id})).messages as any[])[0].text).toBe("Change the plan");
  } finally { await rm(root,{recursive:true,force:true}); }
});
