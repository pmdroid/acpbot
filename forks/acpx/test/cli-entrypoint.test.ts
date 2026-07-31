import assert from "node:assert/strict";
import test from "node:test";

test("importing the CLI module does not install entrypoint-only process state", async () => {
  const stdoutErrorListeners = process.stdout.listeners("error");
  const stderrErrorListeners = process.stderr.listeners("error");
  const previousQueueOwnerArgs = process.env.ACPX_QUEUE_OWNER_ARGS;
  const previousExecArgv = [...process.execArgv];

  process.execArgv.splice(0, process.execArgv.length, "--import", "acpx-test-loader");
  delete process.env.ACPX_QUEUE_OWNER_ARGS;

  try {
    await import(`../src/cli.js?entrypoint-side-effects=${Date.now()}`);

    assert.deepEqual(process.stdout.listeners("error"), stdoutErrorListeners);
    assert.deepEqual(process.stderr.listeners("error"), stderrErrorListeners);
    assert.equal(process.env.ACPX_QUEUE_OWNER_ARGS, undefined);
  } finally {
    process.execArgv.splice(0, process.execArgv.length, ...previousExecArgv);
    if (previousQueueOwnerArgs == null) {
      delete process.env.ACPX_QUEUE_OWNER_ARGS;
    } else {
      process.env.ACPX_QUEUE_OWNER_ARGS = previousQueueOwnerArgs;
    }
  }
});
