export interface FakeMessage {
  info: Record<string, any>;
  parts: Array<Record<string, any>>;
}

export interface FakeSession {
  id: string;
  directory: string;
  status: "idle" | "busy" | "retry";
  messages: FakeMessage[];
  parentID?: string;
  updatedAt: number;
}

export interface PromptContext {
  readonly session: FakeSession;
  readonly messageId: string;
  readonly prompt: string;
  addUser(): FakeMessage;
  addAssistant(input: {
    id?: string;
    text?: string;
    parts?: Array<Record<string, any>>;
    finish?: string;
    completed?: boolean;
  }): FakeMessage;
  emit(type: string, properties: Record<string, unknown>): void;
  emitMessage(message: FakeMessage): void;
  complete(message: FakeMessage, emitIdle?: boolean): void;
}

export interface FakeOpenCodeScenario {
  onPrompt?(context: PromptContext): void | Promise<void>;
  onPermissionReply?(requestId: string): void | Promise<void>;
  statusResponse?(sessions: ReadonlyMap<string, FakeSession>): unknown;
  messagesResponse?(session: FakeSession | undefined): unknown;
}

export interface FakeOpenCode {
  readonly url: string;
  readonly approvals: string[];
  readonly submissions: number;
  session(id: string, directory?: string, parentID?: string): FakeSession;
  touch(id: string): FakeSession;
  stop(): void;
}

export function startFakeOpenCode(scenario: FakeOpenCodeScenario = {}): FakeOpenCode {
  let nextSession = 0;
  let nextAssistant = 0;
  let submissions = 0;
  const approvals: string[] = [];
  const sessions = new Map<string, FakeSession>();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

  const emit = (type: string, properties: Record<string, unknown>): void => {
    const data = encoder.encode(`data: ${JSON.stringify({ payload: { type, properties } })}\n\n`);
    for (const stream of streams) stream.enqueue(data);
  };

  const server = Bun.serve({
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
        const id = `session-${++nextSession}`;
        const directory = url.searchParams.get("directory") ?? "";
        sessions.set(id, { id, directory, status: "idle", messages: [], updatedAt: Date.now() });
        return Response.json({ id, directory });
      }
      if (request.method === "GET" && (url.pathname === "/permission" || url.pathname === "/question")) {
        return Response.json([]);
      }
      const childrenMatch = url.pathname.match(/^\/session\/([^/]+)\/children$/);
      if (request.method === "GET" && childrenMatch) {
        const parentId = decodeURIComponent(childrenMatch[1]!);
        const directory = url.searchParams.get("directory") ?? "";
        const children = [...sessions.values()].filter(
          (session) => session.parentID === parentId && (!directory || session.directory === directory),
        );
        return Response.json(children.map(toSessionPayload));
      }
      if (request.method === "GET" && url.pathname === "/session") {
        const directory = url.searchParams.get("directory") ?? "";
        const listed = [...sessions.values()].filter(
          (session) => !directory || session.directory === directory,
        );
        return Response.json(listed.map(toSessionPayload));
      }
      if (request.method === "GET" && url.pathname === "/session/status") {
        return Response.json(
          scenario.statusResponse?.(sessions) ??
            Object.fromEntries([...sessions].map(([id, session]) => [id, { type: session.status }])),
        );
      }

      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (request.method === "POST" && promptMatch) {
        const session = sessions.get(decodeURIComponent(promptMatch[1]!));
        if (!session) return new Response("not found", { status: 404 });
        if (url.searchParams.get("directory") !== session.directory) {
          return new Response("wrong directory", { status: 400 });
        }
        const body = (await request.json()) as {
          messageID: string;
          parts?: Array<{ type?: string; text?: string }>;
        };
        submissions++;
        const context = promptContext(session, body.messageID, body.parts?.find((part) => part.type === "text")?.text ?? "");
        if (scenario.onPrompt) await scenario.onPrompt(context);
        else void defaultPrompt(context);
        return new Response(null, { status: 204 });
      }

      const messages = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (request.method === "GET" && messages) {
        const session = sessions.get(decodeURIComponent(messages[1]!));
        if (session && url.searchParams.get("directory") !== session.directory) {
          return new Response("wrong directory", { status: 400 });
        }
        return Response.json(scenario.messagesResponse?.(session) ?? session?.messages ?? []);
      }
      const permission = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
      if (request.method === "POST" && permission) {
        const requestId = decodeURIComponent(permission[1]!);
        approvals.push(requestId);
        await scenario.onPermissionReply?.(requestId);
        return Response.json(true);
      }
      if (request.method === "POST" && /^\/question\/[^/]+\/reject$/.test(url.pathname)) {
        return Response.json(true);
      }
      if (request.method === "POST" && /\/session\/[^/]+\/abort$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[2]!);
        const session = sessions.get(id);
        if (session) session.status = "idle";
        emit("session.idle", { sessionID: id });
        return Response.json(true);
      }
      if (request.method === "DELETE" && /\/session\/[^/]+$/.test(url.pathname)) {
        sessions.delete(decodeURIComponent(url.pathname.slice("/session/".length)));
        return Response.json(true);
      }
      return new Response("not found", { status: 404 });
    },
  });

  function session(id: string, directory = process.cwd(), parentID?: string): FakeSession {
    let value = sessions.get(id);
    if (!value) {
      value = { id, directory, status: "idle", messages: [], parentID, updatedAt: Date.now() };
      sessions.set(id, value);
    } else if (parentID !== undefined) {
      value.parentID = parentID;
    }
    return value;
  }

  function touch(id: string): FakeSession {
    const value = sessions.get(id);
    if (!value) throw new Error(`Unknown fake session ${id}.`);
    value.updatedAt = Date.now();
    return value;
  }

  function toSessionPayload(session: FakeSession): Record<string, unknown> {
    return {
      id: session.id,
      parentID: session.parentID,
      directory: session.directory,
      time: { created: session.updatedAt, updated: session.updatedAt },
    };
  }

  function promptContext(current: FakeSession, messageId: string, prompt: string): PromptContext {
    return {
      session: current,
      messageId,
      prompt,
      addUser() {
        const message: FakeMessage = {
          info: { id: messageId, sessionID: current.id, role: "user", time: { created: Date.now() } },
          parts: [{ type: "text", text: prompt }],
        };
        current.messages.push(message);
        current.updatedAt = Date.now();
        emit("message.updated", { info: message.info });
        return message;
      },
      addAssistant(input) {
        const info: Record<string, any> = {
          id: input.id ?? `assistant-${++nextAssistant}`,
          sessionID: current.id,
          role: "assistant",
          parentID: messageId,
          time: { created: Date.now() },
        };
        if (input.finish) info.finish = input.finish;
        if (input.completed) info.time.completed = Date.now();
        const message: FakeMessage = {
          info,
          parts: input.parts ?? (input.text === undefined ? [] : [{ type: "text", text: input.text }]),
        };
        current.messages.push(message);
        current.updatedAt = Date.now();
        return message;
      },
      emit,
      emitMessage(message) {
        emit("message.updated", { info: message.info });
      },
      complete(message, emitIdle = true) {
        message.info.time.completed = Date.now();
        message.info.finish ??= "stop";
        current.status = "idle";
        current.updatedAt = Date.now();
        emit("message.updated", { info: message.info });
        if (emitIdle) emit("session.idle", { sessionID: current.id });
      },
    };
  }

  async function defaultPrompt(context: PromptContext): Promise<void> {
    await Bun.sleep(15);
    context.session.status = "busy";
    context.addUser();
    if (context.prompt === "WAIT-FOR-INTERRUPT") return;
    const remembered = context.session.messages
      .flatMap((message) => message.parts)
      .map((part) => String(part.text ?? ""))
      .join("\n")
      .match(/BLUE-\d+/)?.[0];
    const text = context.prompt.includes("What code did I ask you to remember")
      ? (remembered ?? "NOT-FOUND")
      : context.prompt.includes("Remember BLUE-4821")
        ? "READY"
        : `reply: ${context.prompt}`;
    const assistant = context.addAssistant({ text });
    context.emitMessage(assistant);
    await Bun.sleep(context.prompt.includes("8675309") ? 1_000 : 15);
    context.complete(assistant);
  }

  const port = server.port;
  if (!port) throw new Error("Bun did not allocate a fake OpenCode port.");
  return {
    url: `http://127.0.0.1:${port}`,
    approvals,
    get submissions() { return submissions; },
    session,
    touch,
    stop() { server.stop(true); },
  };
}
