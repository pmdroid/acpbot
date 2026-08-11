import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  createTurnRenderer,
  renderTurnStream,
} from "../src/chat/render-turn";
import type { ChatTurnChunk } from "../src/chat/turn";

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function* asStream(
  chunks: ChatTurnChunk[],
): AsyncGenerator<ChatTurnChunk> {
  for (const c of chunks) yield c;
}

describe("createTurnRenderer full mode", () => {
  test("writes assistant text to stdout; tools/status to stderr", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outP = collect(stdout);
    const errP = collect(stderr);

    const r = createTurnRenderer({
      mode: "full",
      color: false,
      stdout,
      stderr,
    });
    r.write({ type: "thought", text: "thinking…" });
    r.write({ type: "text", text: "Hello" });
    r.write({
      type: "tool",
      title: "grep",
      status: "in_progress",
      rawInput: { pattern: "foo" },
    });
    r.write({ type: "text", text: " world" });
    r.write({ type: "done", status: "completed", stopReason: "end_turn" });
    r.finish();
    stdout.end();
    stderr.end();

    const out = await outP;
    const err = await errP;
    expect(out).toContain("Hello");
    expect(out).toContain("world");
    expect(err).toContain("thinking");
    expect(err).toContain("grep");
    expect(err).toContain("pattern");
    expect(err).toMatch(/done · completed/);
  });

  test("quiet mode is text + errors only", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outP = collect(stdout);
    const errP = collect(stderr);

    const r = createTurnRenderer({
      mode: "quiet",
      color: false,
      stdout,
      stderr,
    });
    r.write({ type: "thought", text: "nope" });
    r.write({ type: "tool", title: "grep", status: "pending" });
    r.write({ type: "text", text: "only" });
    r.write({ type: "done", status: "completed" });
    r.finish();
    stdout.end();
    stderr.end();

    expect(await outP).toBe("only\n");
    expect(await errP).toBe("");
  });

  test("dedupes identical tool updates", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const errP = collect(stderr);
    const r = createTurnRenderer({
      mode: "full",
      color: false,
      stdout,
      stderr,
    });
    r.write({ type: "tool", title: "read", status: "pending", toolCallId: "1" });
    r.write({ type: "tool", title: "read", status: "pending", toolCallId: "1" });
    r.write({ type: "tool", title: "read", status: "completed", toolCallId: "1" });
    r.finish();
    stdout.end();
    stderr.end();
    const err = await errP;
    const pendingCount = (err.match(/read/g) ?? []).length;
    expect(pendingCount).toBe(2); // one pending + one completed
  });
});

describe("renderTurnStream", () => {
  test("returns final status", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const result = await renderTurnStream(
      asStream([
        { type: "text", text: "hi" },
        { type: "done", status: "completed", stopReason: "end_turn" },
      ]),
      { mode: "full", color: false, stdout, stderr },
    );
    stdout.end();
    stderr.end();
    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("end_turn");
  });
});
