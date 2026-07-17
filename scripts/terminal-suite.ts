import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

await test("a named worktree is created, merged by worker ID, and preserved", async () => {
  await using fixture = await createTerminalFixture(executable);
  const spawned = await fixture.json([
    "spawn",
    "--worktree",
    "parser",
    "--agent",
    "build",
    "Inspect the parser worktree and reply READY.",
  ]);
  assert.equal(spawned.worktree, undefined);
  assert.equal((await fixture.json(["wait", spawned.turnId])).status, "completed");

  const worker = await fixture.json(["status", spawned.workerId]);
  assert.deepEqual({ name: worker.worktree.name, branch: worker.worktree.branch }, {
    name: "parser",
    branch: "opencode-agent/parser",
  });
  assert.equal(worker.directory, worker.worktree.path);
  await stat(worker.worktree.path);
  await writeFile(join(worker.worktree.path, "worker-change.txt"), "merged\n");

  assert.deepEqual(await fixture.json(["merge", spawned.workerId]), {
    workerId: spawned.workerId,
    status: "merged",
  });
  assert.equal((await Bun.file(join(fixture.cwd, "worker-change.txt")).text()).trim(), "merged");

  assert.equal((await fixture.json(["close", spawned.workerId])).status, "closed");
  await stat(worker.worktree.path);
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
  assert.equal((await fixture.json(["list", "--all"])).workers.length, 1);

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
  assert.equal("retryable" in failure.body.error, false);

  const removedDirectoryOption = await fixture.failure([
    "spawn",
    "--dir",
    ".",
    "do work",
  ]);
  assert.equal(removedDirectoryOption.exitCode, 2);
  assert.equal(removedDirectoryOption.body.error.code, "INVALID_USAGE");

  const removedScopeOption = await fixture.failure([
    "spawn",
    "--scope",
    "global",
    "do work",
  ]);
  assert.equal(removedScopeOption.exitCode, 2);
  assert.equal(removedScopeOption.body.error.code, "INVALID_USAGE");
});

async function test(name: string, operation: () => Promise<void>): Promise<void> {
  await operation();
  console.log(`PASS ${name}`);
}
