import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TerminalFixture extends AsyncDisposable {
  json(args: string[]): Promise<Record<string, any>>;
  failure(args: string[]): Promise<{ exitCode: number; body: Record<string, any> }>;
}

export async function createTerminalFixture(executable: string): Promise<TerminalFixture> {
  const root = await mkdtemp(join(tmpdir(), "opencode-agent-terminal-"));
  await mkdir(join(root, ".git"));
  const dataRoot = join(root, "adapter-state");
  const openCode = fakeOpenCode();
  return createHostedTerminalFixture({
    executable,
    cwd: root,
    dataRoot,
    openCodeUrl: `http://127.0.0.1:${openCode.port}`,
    async dispose() {
      openCode.stop(true);
      await removeTree(root);
    },
  });
}

export async function createLiveTerminalFixture(
  executable: string,
  cwd: string,
  openCodeUrl: string,
): Promise<TerminalFixture> {
  const dataRoot = await mkdtemp(join(tmpdir(), "opencode-agent-live-"));
  return createHostedTerminalFixture({
    executable,
    cwd,
    dataRoot,
    openCodeUrl,
    async dispose() {
      await removeTree(dataRoot);
    },
  });
}

async function createHostedTerminalFixture(input: {
  executable: string;
  cwd: string;
  dataRoot: string;
  openCodeUrl: string;
  dispose(): Promise<void>;
}): Promise<TerminalFixture> {
  const daemonPort = availablePort();
  const env = {
    ...process.env,
    OPENCODE_AGENT_HOME: input.dataRoot,
    OPENCODE_AGENT_PORT: String(daemonPort),
    OPENCODE_URL: input.openCodeUrl,
  };
  const daemon = Bun.spawn({
    cmd: [input.executable, "__daemon"],
    cwd: input.cwd,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForHealth(daemonPort, daemon);
  } catch (error) {
    daemon.kill();
    await daemon.exited;
    await input.dispose();
    throw error;
  }

  const run = async (args: string[]): Promise<CommandResult> => {
    const child = Bun.spawn({
      cmd: [input.executable, ...args],
      cwd: input.cwd,
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
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  };

  return {
    async json(args: string[]): Promise<Record<string, any>> {
      const result = await run(args);
      if (result.exitCode !== 0) {
        throw new Error(`opencode-agent ${args[0] ?? ""} exited ${result.exitCode}: ${result.stderr}`);
      }
      return JSON.parse(result.stdout) as Record<string, any>;
    },

    async failure(args: string[]): Promise<{ exitCode: number; body: Record<string, any> }> {
      const result = await run(args);
      if (result.exitCode === 0) throw new Error(`opencode-agent ${args[0] ?? ""} unexpectedly succeeded.`);
      return { exitCode: result.exitCode, body: JSON.parse(result.stderr) as Record<string, any> };
    },

    async [Symbol.asyncDispose](): Promise<void> {
      await stopDaemon(input.dataRoot);
      if (daemon.exitCode === null) daemon.kill();
      await daemon.exited;
      await input.dispose();
    },
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function fakeOpenCode(): ReturnType<typeof Bun.serve> {
  let nextSession = 0;
  let nextAssistant = 0;
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const sessions = new Map<string, FakeSession>();

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
        return Response.json({ healthy: true, version: "terminal-test" });
      }
      if (request.method === "GET" && url.pathname === "/global/event") {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              streams.add(value);
              value.enqueue(
                encoder.encode('data: {"payload":{"type":"server.connected","properties":{}}}\n\n'),
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
        const id = `session-terminal-${++nextSession}`;
        const directory = url.searchParams.get("directory") ?? "";
        sessions.set(id, { directory, status: "idle", messages: [] });
        return Response.json({ id, directory });
      }
      if (request.method === "GET" && (url.pathname === "/permission" || url.pathname === "/question")) {
        return Response.json([]);
      }
      if (request.method === "GET" && url.pathname === "/session/status") {
        return Response.json(
          Object.fromEntries([...sessions].map(([id, session]) => [id, { type: session.status }])),
        );
      }

      const prompt = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (request.method === "POST" && prompt) {
        const sessionId = decodeURIComponent(prompt[1]!);
        const session = sessions.get(sessionId);
        if (!session) return new Response("not found", { status: 404 });
        if (url.searchParams.get("directory") !== session.directory) {
          return new Response("wrong directory", { status: 400 });
        }
        const body = (await request.json()) as {
          messageID: string;
          parts?: Array<{ type?: string; text?: string }>;
        };
        const text = body.parts?.find((part) => part.type === "text")?.text ?? "";
        void completePrompt(sessionId, session, body.messageID, text);
        return new Response(null, { status: 204 });
      }

      const message = url.pathname.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
      if (request.method === "GET" && message) {
        const session = sessions.get(decodeURIComponent(message[1]!));
        const found = session?.messages.find((entry) => entry.info.id === decodeURIComponent(message[2]!));
        return found ? Response.json(found) : new Response("not found", { status: 404 });
      }
      const messages = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (request.method === "GET" && messages) {
        return Response.json(sessions.get(decodeURIComponent(messages[1]!))?.messages ?? []);
      }
      if (request.method === "POST" && /\/session\/[^/]+\/abort$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[2]!);
        const session = sessions.get(id);
        if (session) session.status = "idle";
        emit({ type: "session.idle", properties: { sessionID: id } });
        return Response.json(true);
      }
      if (request.method === "DELETE" && /\/session\/[^/]+$/.test(url.pathname)) {
        sessions.delete(decodeURIComponent(url.pathname.slice("/session/".length)));
        return Response.json(true);
      }
      return new Response("not found", { status: 404 });
    },
  });

  async function completePrompt(
    sessionId: string,
    session: FakeSession,
    userMessageId: string,
    prompt: string,
  ): Promise<void> {
    // OpenCode accepts prompt_async before the prompt becomes observable.
    await Bun.sleep(15);
    session.status = "busy";
    const user = {
      info: { id: userMessageId, sessionID: sessionId, role: "user", time: { created: Date.now() } },
      parts: [{ type: "text", text: prompt }],
    };
    session.messages.push(user);
    emit({ type: "message.updated", properties: { info: user.info } });
    if (prompt === "WAIT-FOR-INTERRUPT") return;

    const remembered = session.messages
      .flatMap((entry) => entry.parts)
      .map((part) => part.text ?? "")
      .join("\n")
      .match(/BLUE-\d+/)?.[0];
    const reply = prompt.includes("What code did I ask you to remember")
      ? (remembered ?? "NOT-FOUND")
      : prompt.includes("Remember BLUE-4821")
        ? "READY"
        : `reply: ${prompt}`;
    const assistant = {
      info: {
        id: `assistant-terminal-${++nextAssistant}`,
        sessionID: sessionId,
        role: "assistant",
        parentID: userMessageId,
        time: { created: Date.now() } as { created: number; completed?: number },
      },
      parts: [{ type: "text", text: reply }],
    };
    session.messages.push(assistant);
    emit({ type: "message.updated", properties: { info: assistant.info } });
    await Bun.sleep(15);
    assistant.info.time.completed = Date.now();
    session.status = "idle";
    emit({ type: "message.updated", properties: { info: assistant.info } });
    emit({ type: "session.idle", properties: { sessionID: sessionId } });
  }
}

interface FakeSession {
  directory: string;
  status: "idle" | "busy";
  messages: Array<{
    info: Record<string, any>;
    parts: Array<{ type?: string; text?: string }>;
  }>;
}

function availablePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (!port) throw new Error("Bun did not allocate a terminal-test port.");
  return port;
}

async function waitForHealth(port: number, daemon: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) {
      const stderr = daemon.stderr
        ? await new Response(daemon.stderr as ReadableStream<Uint8Array>).text()
        : "";
      throw new Error(`opencode-agent daemon exited ${daemon.exitCode}: ${stderr.trim()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error("opencode-agent daemon did not become healthy.");
}

async function stopDaemon(dataRoot: string): Promise<void> {
  const lockPath = join(dataRoot, "daemon.lock");
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    if (typeof lock.pid === "number") process.kill(lock.pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") throw error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await readFile(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    }
    await Bun.sleep(20);
  }
}

async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 19) throw error;
      await Bun.sleep(25);
    }
  }
}
