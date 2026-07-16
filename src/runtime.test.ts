import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenCodePort } from "./opencode.ts";
import { createWorkerRuntime, disposeRuntime, type HostedWorkerRuntime } from "./runtime.ts";

const temporaryDirectories: string[] = [];
const runtimes: HostedWorkerRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime[disposeRuntime]()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

test("the seven-operation interface manages persistent workers and turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-agent-"));
  temporaryDirectories.push(directory);
  const client = new FakeOpenCode();
  const stateFile = join(directory, "state.sqlite");
  const runtime = createWorkerRuntime({ client, stateFile });
  runtimes.push(runtime);

  const first = await runtime.spawn({
    task: "remember 8675309",
    directory,
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

  const duplicate = await runtime.spawn({ task: "another task", directory, label: "worker" });
  expect((await runtime.list()).workers).toHaveLength(2);

  const slow = await runtime.followup({ workerId: first.workerId, message: "slow task" });
  await runtime.interrupt(first.workerId);
  expect(await runtime.status(slow.turnId)).toMatchObject({ status: "interrupted" });

  expect((await runtime.close(first.workerId)).status).toBe("closed");
  expect((await runtime.wait(duplicate.turnId)).status).toBe("completed");

  const reloaded = createWorkerRuntime({ client, stateFile });
  runtimes.push(reloaded);
  expect((await reloaded.status(first.workerId)).status).toBe("closed");
});

test("active turns reconcile after the runtime is replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-agent-recovery-"));
  temporaryDirectories.push(directory);
  const stateFile = join(directory, "state.sqlite");
  const client = new FakeOpenCode(500);
  const firstRuntime = createWorkerRuntime({ client, stateFile });
  runtimes.push(firstRuntime);

  const spawned = await firstRuntime.spawn({ task: "survive restart", directory });
  await firstRuntime[disposeRuntime]();

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
      runtime.spawn({ task: `parallel-${index}`, directory }),
    ),
  );
  await Promise.all(workers.map((worker) => runtime.wait(worker.turnId)));
  expect(client.maxActive).toBeGreaterThan(1);

  const serial = await runtime.spawn({ task: "serial-1", directory });
  const second = await runtime.followup({ workerId: serial.workerId, message: "serial-2" });
  const third = await runtime.followup({ workerId: serial.workerId, message: "serial-3" });
  await Promise.all([runtime.wait(serial.turnId), runtime.wait(second.turnId), runtime.wait(third.turnId)]);
  expect(client.started.filter((message) => message.startsWith("serial-"))).toEqual([
    "serial-1",
    "serial-2",
    "serial-3",
  ]);
});

class FakeOpenCode implements OpenCodePort {
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
