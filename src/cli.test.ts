import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "./config.ts";

test("the CLI controls a project-scoped worker through the daemon", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-agent-cli-"));
  await mkdir(join(directory, ".git"));
  const openCode = fakeOpenCode();
  const daemonPort = availablePort();
  const entry = join(import.meta.dir, "index.ts");
  const env = {
    ...process.env,
    OPENCODE_AGENT_HOME: join(directory, "adapter-state"),
    OPENCODE_AGENT_PORT: String(daemonPort),
    OPENCODE_URL: `http://127.0.0.1:${openCode.port}`,
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
    expect((await health.json()).protocol).toBe(PROTOCOL_VERSION);

    const unauthorized = await fetch(`http://127.0.0.1:${daemonPort}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);

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

    const first = await cli(entry, env, directory, [
      "wait",
      "--project",
      directory,
      spawned.turnId as string,
    ]);
    expect(first).toMatchObject({ status: "completed", text: "reply: remember 8675309" });

    const followup = await cli(entry, env, directory, [
      "followup",
      "--project",
      directory,
      spawned.workerId as string,
      "what number?",
    ]);
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
    openCode.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

function fakeOpenCode(): ReturnType<typeof Bun.serve> {
  let session = 0;
  let assistant = 0;
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const sessions = new Map<
    string,
    { status: "idle" | "busy"; messages: Array<Record<string, any>> }
  >();

  const emit = (payload: Record<string, unknown>): void => {
    const data = encoder.encode(`data: ${JSON.stringify({ payload })}\n\n`);
    for (const stream of streams) stream.enqueue(data);
  };

  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/global/health") {
        return Response.json({ healthy: true, version: "test" });
      }
      if (request.method === "GET" && url.pathname === "/global/event") {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              streams.add(value);
              value.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`,
                ),
              );
            },
            cancel() {
              streams.delete(controller);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (request.method === "POST" && url.pathname === "/session") {
        const id = `session-${++session}`;
        sessions.set(id, { status: "idle", messages: [] });
        return Response.json({ id, directory: url.searchParams.get("directory") });
      }
      if (request.method === "GET" && url.pathname === "/permission") return Response.json([]);
      if (request.method === "GET" && url.pathname === "/question") return Response.json([]);
      if (request.method === "GET" && url.pathname === "/session/status") {
        return Response.json(
          Object.fromEntries([...sessions].map(([id, value]) => [id, { type: value.status }])),
        );
      }
      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (request.method === "POST" && promptMatch) {
        const sessionId = decodeURIComponent(promptMatch[1]!);
        const current = sessions.get(sessionId);
        if (!current) return new Response("not found", { status: 404 });
        const body = (await request.json()) as {
          messageID?: string;
          parts?: Array<{ type?: string; text?: string }>;
        };
        const prompt = body.parts?.find((part) => part.type === "text")?.text ?? "";
        const userMessageId = body.messageID ?? `msg-user-${assistant}`;
        const assistantMessageId = `msg-assistant-${++assistant}`;
        current.status = "busy";
        current.messages.push({
          info: { id: userMessageId, role: "user", time: { created: Date.now() } },
          parts: body.parts ?? [],
        });
        const reply = {
          info: {
            id: assistantMessageId,
            role: "assistant",
            parentID: userMessageId,
            time: { created: Date.now() } as { created: number; completed?: number },
          },
          parts: [{ type: "text", text: `reply: ${prompt}` }],
        };
        current.messages.push(reply);
        emit({ type: "message.updated", properties: { sessionID: sessionId, info: reply.info } });
        void (async () => {
          await Bun.sleep(10);
          reply.info.time.completed = Date.now();
          current.status = "idle";
          emit({ type: "message.updated", properties: { sessionID: sessionId, info: reply.info } });
          emit({ type: "session.idle", properties: { sessionID: sessionId } });
        })();
        return new Response(null, { status: 204 });
      }
      const singleMessage = url.pathname.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
      if (request.method === "GET" && singleMessage) {
        const current = sessions.get(decodeURIComponent(singleMessage[1]!));
        const message = current?.messages.find(
          (entry) => entry.info.id === decodeURIComponent(singleMessage[2]!),
        );
        return message ? Response.json(message) : new Response("not found", { status: 404 });
      }
      const messages = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (request.method === "GET" && messages) {
        return Response.json(sessions.get(decodeURIComponent(messages[1]!))?.messages ?? []);
      }
      if (request.method === "POST" && /\/session\/[^/]+\/abort$/.test(url.pathname)) {
        return Response.json(true);
      }
      if (request.method === "DELETE" && /\/session\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice("/session/".length));
        sessions.delete(id);
        return Response.json(true);
      }
      return new Response("not found", { status: 404 });
    },
  });
}

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
