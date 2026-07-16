import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "./config.ts";
import { startFakeOpenCode } from "../test/fake-opencode.ts";

test("the CLI controls a project-scoped worker through the daemon", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-agent-cli-"));
  await mkdir(join(directory, ".git"));
  const openCode = startFakeOpenCode();
  const daemonPort = availablePort();
  const entry = join(import.meta.dir, "index.ts");
  const env = {
    ...process.env,
    OPENCODE_AGENT_HOME: join(directory, "adapter-state"),
    OPENCODE_AGENT_PORT: String(daemonPort),
    OPENCODE_AGENT_MAX_REQUEST_BYTES: "1024",
    OPENCODE_URL: openCode.url,
  };
  const daemon = Bun.spawn({
    cmd: [process.execPath, entry, "__daemon"],
    cwd: directory,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    await waitForHealth(daemonPort);
    const health = await fetch(`http://127.0.0.1:${daemonPort}/health`);
    expect(health.headers.get(PROTOCOL_HEADER)).toBe(String(PROTOCOL_VERSION));
    expect(((await health.json()) as { protocol?: unknown }).protocol).toBe(PROTOCOL_VERSION);

    const unauthorized = await fetch(`http://127.0.0.1:${daemonPort}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);

    const token = (await readFile(join(directory, "adapter-state", "daemon.token"), "utf8")).trim();
    const oversizedBody = JSON.stringify({
      scope: { scope: "project", projectRoot: directory },
      operation: "spawn",
      input: { task: "é".repeat(600), directory },
    });
    const oversized = await fetch(`http://127.0.0.1:${daemonPort}/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversizedBody));
          controller.close();
        },
      }),
      duplex: "half",
    });
    expect(oversized.status).toBe(413);

    const duplicateDaemon = Bun.spawn({
      cmd: [process.execPath, entry, "__daemon"],
      cwd: directory,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await duplicateDaemon.exited).toBe(1);

    const spawned = await cli(entry, env, directory, [
      "spawn",
      "--project",
      directory,
      "--dir",
      directory,
      "--label",
      "reviewer",
      "remember 8675309",
    ]);
    expect(spawned.workerId).toStartWith("wrk_");
    expect(spawned.turnId).toStartWith("trn_");
    expect(spawned.label).toBe("reviewer");

    const firstWait = cli(entry, env, directory, [
      "wait",
      "--project",
      directory,
      spawned.turnId as string,
    ]);
    await Bun.sleep(20);
    const followup = await cli(entry, env, directory, [
      "followup",
      "--project",
      directory,
      spawned.workerId as string,
      "what number?",
    ]);
    expect(followup.status).toBe("queued");
    const first = await firstWait;
    expect(first).toMatchObject({ status: "completed", text: "reply: remember 8675309" });

    const second = await cli(entry, env, directory, [
      "wait",
      "--project",
      directory,
      followup.turnId as string,
    ]);
    expect(second.text).toBe("reply: what number?");

    const projectWorkers = await cli(entry, env, directory, ["list", "--project", directory]);
    expect(projectWorkers.workers).toHaveLength(1);
    const globalWorkers = await cli(entry, env, directory, ["list", "--scope", "global"]);
    expect(globalWorkers.workers).toHaveLength(0);

    const closed = await cli(entry, env, directory, [
      "close",
      "--project",
      directory,
      spawned.workerId as string,
    ]);
    expect(closed.status).toBe("closed");
  } finally {
    daemon.kill();
    await daemon.exited;
    openCode.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("configuration failures preserve the executable JSON contract", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "index.ts"), "version"],
    env: { ...process.env, OPENCODE_AGENT_PORT: "invalid" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toMatchObject({ error: { code: "INVALID_CONFIG", retryable: false } });
});

function availablePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (!port) throw new Error("Bun did not allocate a port.");
  return port;
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The daemon is still starting.
    }
    await Bun.sleep(20);
  }
  throw new Error("daemon did not start");
}

async function cli(
  entry: string,
  env: Record<string, string | undefined>,
  cwd: string,
  args: string[],
): Promise<Record<string, any>> {
  const child = Bun.spawn({
    cmd: [process.execPath, entry, ...args],
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout) as Record<string, any>;
}
