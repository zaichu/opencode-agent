export interface FakeMessage {
  id: string;
  type: string;
  time: { created: number; streamed?: number; completed?: number };
  text?: string;
  content?: Array<Record<string, any>>;
  finish?: string;
  outcome?: string;
  error?: unknown;
}

export interface FakeSession {
  id: string;
  directory: string;
  busy: boolean;
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
    content?: Array<Record<string, any>>;
    finish?: string;
    completed?: boolean;
  }): FakeMessage;
  emit(type: string, data: Record<string, unknown>, created?: number): void;
  complete(message: FakeMessage, outcome?: string): void;
}

export interface FakeOpenCodeScenario {
  onPrompt?(context: PromptContext): void | Promise<void>;
  onPermissionReply?(requestId: string): void | Promise<void>;
  activeResponse?(sessions: ReadonlyMap<string, FakeSession>): unknown;
  // messagesResponse / pollMessagesResponse の配列は実 API と同じ降順(desc)で
  // 返すこと。session.messages は昇順で保持しているため、そのまま渡すと逆順になる。
  messagesResponse?(session: FakeSession | undefined): unknown;
  pollMessagesResponse?(session: FakeSession | undefined): unknown;
  pollMessagesStatus?(session: FakeSession | undefined): number | undefined;
  pollMessagesDelayMs?: number;
  childrenStatus?(sessionId: string): number | undefined;
  childrenDelayMs?: number;
}

export interface FakeOpenCode {
  readonly url: string;
  readonly approvals: string[];
  readonly submissions: number;
  readonly pollMessageRequests: number;
  session(id: string, directory?: string, parentID?: string, emitCreated?: boolean): FakeSession;
  emit(type: string, data: Record<string, unknown>, created?: number): void;
  touch(id: string): FakeSession;
  stop(): void;
}

export function startFakeOpenCode(scenario: FakeOpenCodeScenario = {}): FakeOpenCode {
  let nextSession = 0;
  let nextMessage = 0;
  let submissions = 0;
  let pollMessageRequests = 0;
  const approvals: string[] = [];
  const sessions = new Map<string, FakeSession>();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

  const emit = (type: string, data: Record<string, unknown>, created = Date.now()): void => {
    const frame = encoder.encode(`data: ${JSON.stringify({ created, type, data })}\n\n`);
    for (const stream of streams) stream.enqueue(frame);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/info") {
        return Response.json({ version: "test" });
      }
      if (request.method === "GET" && url.pathname === "/api/event") {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              streams.add(value);
              value.enqueue(encoder.encode('data: {"type":"server.connected","data":{}}\n\n'));
            },
            cancel() {
              streams.delete(controller);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (request.method === "POST" && url.pathname === "/api/session") {
        const body = (await request.json()) as { location?: { directory?: string }; title?: string; model?: Record<string, unknown> };
        const id = `ses-${++nextSession}`;
        const directory = body.location?.directory ?? "";
        sessions.set(id, { id, directory, busy: false, messages: [], updatedAt: Date.now() });
        return Response.json({
          data: { id, directory, title: body.title, model: body.model, time: { created: Date.now(), updated: Date.now() } },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        const parentID = url.searchParams.get("parentID") ?? undefined;
        const directory = url.searchParams.get("directory") ?? "";
        if (parentID) {
          if (scenario.childrenDelayMs) await Bun.sleep(scenario.childrenDelayMs);
          const status = scenario.childrenStatus?.(parentID);
          if (status && status !== 200) return new Response("children failed", { status });
        }
        const listed = [...sessions.values()].filter(
          (session) =>
            (!parentID || session.parentID === parentID) && (!directory || session.directory === directory),
        );
        return Response.json({ data: listed.map(sessionPayload), cursor: { previous: null, next: null } });
      }
      if (request.method === "GET" && url.pathname === "/api/session/active") {
        const value =
          scenario.activeResponse?.(sessions) ??
          Object.fromEntries(
            [...sessions.values()].filter((session) => session.busy).map((session) => [session.id, { type: "running" }]),
          );
        return Response.json({ data: value });
      }
      const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]!);
        const session = sessions.get(id);
        if (session && request.method === "DELETE") {
          sessions.delete(id);
          return new Response(null, { status: 204 });
        }
        if (session && request.method === "POST" && !url.pathname.match(/\/(prompt|agent|model|interrupt|permission)/)) {
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
      }
      const activeMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/(agent|model)$/);
      if (request.method === "POST" && activeMatch) {
        if (!sessions.has(decodeURIComponent(activeMatch[1]!))) return new Response("not found", { status: 404 });
        return new Response(null, { status: 204 });
      }
      const interruptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/interrupt$/);
      if (request.method === "POST" && interruptMatch) {
        const id = decodeURIComponent(interruptMatch[1]!);
        const session = sessions.get(id);
        if (session) {
          session.busy = false;
          session.updatedAt = Date.now();
          emit("session.execution.interrupted", { sessionID: id });
        }
        return Response.json({ interrupted: Boolean(session) });
      }
      const promptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
      if (request.method === "POST" && promptMatch) {
        const session = sessions.get(decodeURIComponent(promptMatch[1]!));
        if (!session) return new Response("not found", { status: 404 });
        if (session.busy) return Response.json({ _tag: "ConflictError", message: "Session is busy." }, { status: 409 });
        const body = (await request.json()) as { id: string; text: string; delivery?: string };
        submissions++;
        session.updatedAt = Date.now();
        emit("session.inbox.enqueued", {
          sessionID: session.id,
          inboxID: body.id,
          item: { type: "user", payload: { text: body.text }, delivery: body.delivery ?? "queue" },
        });
        emit("session.execution.started", { sessionID: session.id });
        emit("session.inbox.delivered", { sessionID: session.id, inboxID: body.id });
        const context = promptContext(session, body.id, body.text);
        if (scenario.onPrompt) await scenario.onPrompt(context);
        else void defaultPrompt(context);
        return Response.json({
          data: {
            id: body.id,
            sessionID: session.id,
            time: { created: Date.now() },
            type: "user",
            payload: { text: body.text },
            delivery: body.delivery ?? "steer",
          },
        });
      }
      const messageMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/message\/([^/]+)$/);
      if (request.method === "GET" && messageMatch) {
        const session = sessions.get(decodeURIComponent(messageMatch[1]!));
        const messageId = decodeURIComponent(messageMatch[2]!);
        const entry = session?.messages.find((message) => message.id === messageId);
        if (!entry) {
          return Response.json({ _tag: "MessageNotFoundError", messageID: messageId }, { status: 404 });
        }
        return Response.json({ data: entry });
      }
      const messagesMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/);
      if (request.method === "GET" && messagesMatch) {
        const session = sessions.get(decodeURIComponent(messagesMatch[1]!));
        if (url.searchParams.has("limit")) {
          pollMessageRequests++;
          if (scenario.pollMessagesDelayMs) await Bun.sleep(scenario.pollMessagesDelayMs);
          const status = scenario.pollMessagesStatus?.(session);
          if (status && status !== 200) return new Response("poll failed", { status });
          const configured = scenario.pollMessagesResponse?.(session);
          const value = configured ?? [...(session?.messages ?? [])].reverse();
          const limit = Math.max(1, Number(url.searchParams.get("limit")) || 1);
          const list = Array.isArray(value) ? value.slice(0, limit) : value;
          return Response.json({ data: list, cursor: { previous: null, next: null } });
        }
        const configured = scenario.messagesResponse?.(session);
        return Response.json({
          data: configured ?? [...(session?.messages ?? [])].reverse(),
          cursor: { previous: null, next: null },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/permission/request") {
        return Response.json({ location: { directory: "" }, data: [] });
      }
      const permissionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/);
      if (request.method === "POST" && permissionMatch) {
        const requestId = decodeURIComponent(permissionMatch[2]!);
        approvals.push(requestId);
        await scenario.onPermissionReply?.(requestId);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  function session(id: string, directory = process.cwd(), parentID?: string, emitCreated = true): FakeSession {
    let value = sessions.get(id);
    const created = !value;
    if (!value) {
      value = { id, directory, busy: false, messages: [], parentID, updatedAt: Date.now() };
      sessions.set(id, value);
    } else if (parentID !== undefined) {
      value.parentID = parentID;
    }
    if (created && emitCreated) {
      emit("session.created", {
        sessionID: value.id,
        parentID: value.parentID,
        location: { directory: value.directory },
      });
    }
    return value;
  }

  function touch(id: string): FakeSession {
    const value = sessions.get(id);
    if (!value) throw new Error(`Unknown fake session ${id}.`);
    value.updatedAt = Date.now();
    return value;
  }

  function sessionPayload(session: FakeSession): Record<string, unknown> {
    return {
      id: session.id,
      parentID: session.parentID,
      directory: session.directory,
      time: { created: session.updatedAt, updated: session.updatedAt },
    };
  }

  function promptContext(current: FakeSession, messageId: string, text: string): PromptContext {
    return {
      session: current,
      messageId,
      prompt: text,
      addUser() {
        const message: FakeMessage = {
          id: messageId,
          type: "user",
          time: { created: Date.now() },
          text,
        };
        current.messages.push(message);
        current.updatedAt = Date.now();
        return message;
      },
      addAssistant(input) {
        const message: FakeMessage = {
          id: input.id ?? `msg-fake-${++nextMessage}`,
          type: "assistant",
          time: { created: Date.now(), ...(input.completed ? { completed: Date.now() } : {}) },
          content:
            input.content ??
            (input.text === undefined ? [] : [{ type: "text", text: input.text }]),
          finish: input.finish,
        };
        if (input.finish === undefined) delete message.finish;
        current.messages.push(message);
        current.updatedAt = Date.now();
        return message;
      },
      emit,
      complete(message: FakeMessage, outcome = "succeeded") {
        message.finish ??= "stop";
        message.time.completed = Date.now();
        current.busy = false;
        current.updatedAt = Date.now();
        emit("session.step.ended", { sessionID: current.id, assistantMessageID: message.id, finish: message.finish });
        current.messages.push({
          id: `msg-fake-idle-${++nextMessage}`,
          type: "idle",
          time: { created: Date.now() },
          outcome,
        });
        emit(`session.execution.${outcome}`, { sessionID: current.id });
      },
    };
  }

  async function defaultPrompt(context: PromptContext): Promise<void> {
    await Bun.sleep(15);
    context.session.busy = true;
    context.addUser();
    const remembered = context.session.messages
      .map((message) => message.text ?? "")
      .join("\n")
      .match(/BLUE-\d+/)?.[0];
    const text = context.prompt.includes("What code did I ask you to remember")
      ? (remembered ?? "NOT-FOUND")
      : context.prompt.includes("Remember BLUE-4821")
        ? "READY"
        : `reply: ${context.prompt}`;
    const assistant = context.addAssistant({ text });
    await Bun.sleep(context.prompt.includes("8675309") ? 1_000 : 15);
    context.complete(assistant);
  }

  const port = server.port;
  if (!port) throw new Error("Bun did not allocate a fake OpenCode port.");
  return {
    url: `http://127.0.0.1:${port}`,
    approvals,
    get submissions() { return submissions; },
    get pollMessageRequests() { return pollMessageRequests; },
    session,
    emit,
    touch,
    stop() { server.stop(true); },
  };
}
