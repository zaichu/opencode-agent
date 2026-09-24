import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenCodePort, TurnProgress } from "./opencode.ts";
import { createWorkerRuntime, type HostedWorkerRuntime } from "./runtime.ts";
import type { WorktreePort } from "./worktree.ts";

const temporaryDirectories: string[] = [];
const runtimes: HostedWorkerRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime[Symbol.asyncDispose]()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

test("the worker interface manages persistent workers and turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-agent-"));
  temporaryDirectories.push(directory);
  const client = new FakeOpenCode();
  const stateFile = join(directory, "state.sqlite");
  const runtime = createWorkerRuntime({ client, stateFile });
  runtimes.push(runtime);

  const first = await runtime.spawn({
    task: "remember 8675309",
    projectRoot: directory,
    label: "worker",
  });
  expect(first.workerId).toStartWith("wrk_");
  expect(first.turnId).toStartWith("trn_");
  expect(first.status).toBe("running");

  const firstResult = await runtime.wait(first.turnId);
  expect(firstResult).toMatchObject({ status: "completed", text: "done: remember 8675309" });
  expect((await runtime.status(first.workerId)).status).toBe("idle");

  const second = await runtime.followup({
    workerId: first.workerId,
    message: "what did I ask you to remember?",
  });
  expect((await runtime.wait(second.turnId)).text).toBe("done: what did I ask you to remember?");

  const duplicate = await runtime.spawn({ task: "another task", projectRoot: directory, label: "worker" });
  expect((await runtime.list()).workers).toHaveLength(2);

  const otherProject = await mkdtemp(join(tmpdir(), "opencode-agent-other-project-"));
  temporaryDirectories.push(otherProject);
  const other = await runtime.spawn({ task: "other project", projectRoot: otherProject });
  expect((await runtime.list(directory)).workers).toHaveLength(2);
  expect((await runtime.list(otherProject)).workers).toHaveLength(1);
  expect((await runtime.list()).workers).toHaveLength(3);

  const slow = await runtime.followup({ workerId: first.workerId, message: "slow task" });
  await runtime.interrupt(first.workerId);
  expect(await runtime.status(slow.turnId)).toMatchObject({ status: "interrupted" });

  expect((await runtime.close(first.workerId)).status).toBe("closed");
  expect((await runtime.wait(duplicate.turnId)).status).toBe("completed");
  expect((await runtime.wait(other.turnId)).status).toBe("completed");

  const reloaded = createWorkerRuntime({ client, stateFile });
  runtimes.push(reloaded);
  expect((await reloaded.status(first.workerId)).status).toBe("closed");
});

test("merge accepts only idle managed-worktree workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-agent-merge-runtime-"));
  temporaryDirectories.push(directory);
  const client = new FakeOpenCode();
  let mergeCalls = 0;
  const worktrees: WorktreePort = {
    async create(_projectRoot, name) {
      return { name, path: directory, branch: `opencode-agent/${name}` };
    },
    async merge() {
      mergeCalls++;
    },
    async rollback() {},
  };
  const runtime = createWorkerRuntime({
    client,
    stateFile: join(directory, "state.sqlite"),
    worktrees,
  });
  runtimes.push(runtime);

  const managed = await runtime.spawn({ task: "slow task", projectRoot: directory, worktree: "parser" });
  await expect(runtime.merge(managed.workerId)).rejects.toMatchObject({ code: "WORKER_BUSY" });
  await runtime.interrupt(managed.workerId);
  expect(await runtime.merge(managed.workerId)).toEqual({ workerId: managed.workerId, status: "merged" });
  expect(mergeCalls).toBe(1);

  const ordinary = await runtime.spawn({ task: "ordinary", projectRoot: directory });
  await runtime.wait(ordinary.turnId);
  await expect(runtime.merge(ordinary.workerId)).rejects.toMatchObject({ code: "WORKTREE_REQUIRED" });
});

test("active turns reconcile after the runtime is replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-agent-recovery-"));
  temporaryDirectories.push(directory);
  const stateFile = join(directory, "state.sqlite");
  const client = new FakeOpenCode(500);
  const firstRuntime = createWorkerRuntime({ client, stateFile });
  runtimes.push(firstRuntime);

  const spawned = await firstRuntime.spawn({ task: "survive restart", projectRoot: directory });
  await firstRuntime[Symbol.asyncDispose]();

  const replacement = createWorkerRuntime({ client, stateFile });
  runtimes.push(replacement);
  expect(await replacement.wait(spawned.turnId)).toMatchObject({
    status: "completed",
    text: "recovered",
  });
});

test("workers run concurrently without an adapter limit while each worker stays FIFO", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-agent-concurrency-"));
  temporaryDirectories.push(directory);
  const client = new FakeOpenCode(40);
  const runtime = createWorkerRuntime({ client, stateFile: join(directory, "state.sqlite") });
  runtimes.push(runtime);

  const workers = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      runtime.spawn({ task: `parallel-${index}`, projectRoot: directory }),
    ),
  );
  await Promise.all(workers.map((worker) => runtime.wait(worker.turnId)));
  expect(client.maxActive).toBeGreaterThan(1);

  const serial = await runtime.spawn({ task: "serial-1", projectRoot: directory });
  const second = await runtime.followup({ workerId: serial.workerId, message: "serial-2" });
  const third = await runtime.followup({ workerId: serial.workerId, message: "serial-3" });
  await Promise.all([runtime.wait(serial.turnId), runtime.wait(second.turnId), runtime.wait(third.turnId)]);
  expect(client.started.filter((message) => message.startsWith("serial-"))).toEqual([
    "serial-1",
    "serial-2",
    "serial-3",
  ]);
});

test("turn status exposes subagent progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-agent-progress-"));
  temporaryDirectories.push(directory);
  const client = new FakeOpenCode();
  client.progress = {
    steps: 3,
    activeSubagents: 2,
    lastActivityAt: Date.now(),
    lastTool: "bash",
  };
  const runtime = createWorkerRuntime({ client, stateFile: join(directory, "state.sqlite") });
  runtimes.push(runtime);

  const spawned = await runtime.spawn({ task: "slow task", projectRoot: directory });
  const snapshot = await runtime.status(spawned.turnId);
  expect(snapshot).toMatchObject({
    type: "turn",
    status: "running",
    progress: { steps: 3, activeSubagents: 2, lastTool: "bash" },
  });
  await runtime.interrupt(spawned.workerId);
});

test("turn status does not mix another turn's progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-agent-turn-progress-"));
  temporaryDirectories.push(directory);
  const client = new FakeOpenCode(1_000);
  const runtime = createWorkerRuntime({ client, stateFile: join(directory, "state.sqlite") });
  runtimes.push(runtime);

  const first = await runtime.spawn({ task: "slow task", projectRoot: directory });
  const firstProgress: TurnProgress = {
    steps: 3,
    activeSubagents: 1,
    lastActivityAt: Date.now(),
    lastTool: "bash",
  };
  client.progress = firstProgress;
  client.setTurnProgress(first.turnId, firstProgress);
  const firstStatus = await runtime.status(first.turnId);
  expect(firstStatus.type).toBe("turn");
  if (firstStatus.type === "turn") {
    expect(firstStatus.progress).toMatchObject({ steps: 3, lastTool: "bash" });
  }

  const second = await runtime.followup({ workerId: first.workerId, message: "queued task" });
  client.setTurnProgress(second.turnId, {
    steps: 99,
    activeSubagents: 9,
    lastActivityAt: Date.now(),
    lastTool: "wrong-turn",
  });
  const secondStatus = await runtime.status(second.turnId);
  expect(secondStatus.type).toBe("turn");
  if (secondStatus.type === "turn") expect(secondStatus.progress).toBeUndefined();
  await runtime.interrupt(first.workerId);
});

class FakeOpenCode implements OpenCodePort {
  progress?: TurnProgress;
  private readonly progressByTurn = new Map<string, TurnProgress>();
  private nextSession = 0;
  private active = 0;
  readonly started: string[] = [];
  private readonly attempts = new Map<string, number>();
  maxActive = 0;

  constructor(private readonly delay = 5) {}

  async createSession(): Promise<string> {
    return `session-${++this.nextSession}`;
  }

  async executeTurn(
    _sessionId: string,
    _directory: string,
    _messageId: string,
    input: { message: string },
    signal: AbortSignal,
  ): Promise<string> {
    expect(_messageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    const attempt = (this.attempts.get(_messageId) ?? 0) + 1;
    this.attempts.set(_messageId, attempt);
    this.started.push(input.message);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await sleep(input.message === "slow task" ? 1_000 : this.delay, signal);
      return attempt > 1 ? "recovered" : `done: ${input.message}`;
    } finally {
      this.active--;
    }
  }

  async abort(): Promise<void> {}

  async close(): Promise<void> {}

  setTurnProgress(turnId: string, progress: TurnProgress): void {
    this.progressByTurn.set(turnId, progress);
  }

  async turnProgress(turnId?: string): Promise<TurnProgress | undefined> {
    return (turnId ? this.progressByTurn.get(turnId) : undefined) ?? this.progress;
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
