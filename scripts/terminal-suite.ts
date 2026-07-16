import assert from "node:assert/strict";
import { createTerminalFixture } from "./terminal-suite-support.ts";

const executable = Bun.which("opencode-agent");
if (!executable) {
  throw new Error("opencode-agent is not installed on PATH. Run `bun link` from this project first.");
}

await test("installed command reports its version", async () => {
  const child = Bun.spawn({
    cmd: [executable, "version"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  assert.equal(exitCode, 0, stderr.trim());
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

await test("a persistent worker completes a turn and remembers a follow-up", async () => {
  await using fixture = await createTerminalFixture(executable);
  const spawned = await fixture.json([
    "spawn",
    "--label",
    "memory-test",
    "Do not run tools. Remember BLUE-4821 and reply exactly READY.",
  ]);
  assert.match(spawned.workerId, /^wrk_/);
  assert.match(spawned.turnId, /^trn_/);
  assert.equal(spawned.status, "running");

  const first = await fixture.json(["wait", spawned.turnId]);
  assert.equal(first.status, "completed");
  assert.equal(first.text, "READY");

  const followup = await fixture.json([
    "followup",
    spawned.workerId,
    "What code did I ask you to remember? Reply with only the code.",
  ]);
  assert.match(followup.turnId, /^trn_/);

  const second = await fixture.json(["wait", followup.turnId]);
  assert.equal(second.status, "completed", JSON.stringify(second));
  assert.equal(second.text, "BLUE-4821");
});

await test("status, list, interrupt, and close manage a long-running worker", async () => {
  await using fixture = await createTerminalFixture(executable);
  const spawned = await fixture.json([
    "spawn",
    "--label",
    "long-runner",
    "WAIT-FOR-INTERRUPT",
  ]);

  const running = await fixture.json(["status", spawned.turnId]);
  assert.equal(running.status, "running");

  const listed = await fixture.json(["list"]);
  assert.equal(listed.workers.length, 1);
  assert.equal(listed.workers[0].workerId, spawned.workerId);
  assert.equal((await fixture.json(["list", "--scope", "global"])).workers.length, 0);

  const interrupted = await fixture.json(["interrupt", spawned.workerId]);
  assert.equal(interrupted.interruptedTurnId, spawned.turnId);
  assert.equal((await fixture.json(["status", spawned.turnId])).status, "interrupted");

  const closed = await fixture.json(["close", spawned.workerId]);
  assert.equal(closed.status, "closed");
  assert.equal((await fixture.json(["status", spawned.workerId])).status, "closed");
});

await test("invalid terminal input returns structured JSON on stderr", async () => {
  await using fixture = await createTerminalFixture(executable);
  const failure = await fixture.failure(["status", "not-an-agent-id"]);
  assert.equal(failure.exitCode, 2);
  assert.equal(failure.body.error.code, "INVALID_ID");
  assert.equal(failure.body.error.retryable, false);
});

async function test(name: string, operation: () => Promise<void>): Promise<void> {
  await operation();
  console.log(`PASS ${name}`);
}
