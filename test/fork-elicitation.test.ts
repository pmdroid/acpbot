import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ticket 04 — fork acpx elicitation seam.
 * Asserts against the built fork source/dist, not a live Claude session
 * (that needs BotFather + a real agent login).
 */
describe("04 — acpx elicitation fork", () => {
  const forkRoot = join(import.meta.dir, "../forks/acpx");

  test("fork builds from source and exports onElicitationRequest", () => {
    const dts = readFileSync(join(forkRoot, "dist/runtime.d.ts"), "utf8");
    expect(dts).toContain("onElicitationRequest");
    expect(dts).toContain("AcpElicitationRequest");
    expect(dts).toContain("AcpElicitationDecision");
  });

  test("clientCapabilities.elicitation.form is advertised in built client", () => {
    // Bundled client chunk name is content-hashed; scan dist for the capability.
    const glob = new Bun.Glob("dist/live-checkpoint-*.js");
    const files = [...glob.scanSync({ cwd: forkRoot })];
    expect(files.length).toBeGreaterThan(0);
    const body = readFileSync(join(forkRoot, files[0]!), "utf8");
    expect(body).toMatch(/elicitation:\s*\{\s*form:\s*\{\s*\}/);
    expect(body).toContain("onElicitationRequest");
    expect(body).toContain("unstable_createElicitation");
  });

  test("host hook is awaited with no Promise.race/timeout wrapper", () => {
    const glob = new Bun.Glob("dist/live-checkpoint-*.js");
    const files = [...glob.scanSync({ cwd: forkRoot })];
    const body = readFileSync(join(forkRoot, files[0]!), "utf8");
    // The decision await should be a bare await, not raced against a timer.
    const idx = body.indexOf("await this.options.onElicitationRequest");
    expect(idx).toBeGreaterThan(-1);
    const window = body.slice(Math.max(0, idx - 200), idx + 200);
    expect(window).not.toMatch(/Promise\.race/);
    expect(window).not.toMatch(/withTimeout/);
  });

  test("no fs/terminal/confirmWrite changes in the elicitation patch commit", () => {
    // Source of the patch: handleElicitationRequest exists; confirmWrite untouched.
    const client = readFileSync(join(forkRoot, "src/acp/client.ts"), "utf8");
    expect(client).toContain("handleElicitationRequest");
    expect(client).toContain("elicitation: {\n      form: {},\n    }");
    // confirmWrite should not appear as a new addition in our seam.
    expect(client).not.toMatch(/confirmWrite/);
  });

  test("tacp resolves acpx from the local fork", async () => {
    const mod = await import("acpx/runtime");
    expect(typeof (mod as { createAcpRuntime?: unknown }).createAcpRuntime).toBe(
      "function",
    );
    const dtsPath = join(
      import.meta.dir,
      "../node_modules/acpx/dist/runtime.d.ts",
    );
    const dts = readFileSync(dtsPath, "utf8");
    expect(dts).toContain("onElicitationRequest");
  });
});
