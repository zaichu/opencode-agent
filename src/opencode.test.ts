import { expect, test } from "bun:test";
import { ManagedOpenCode } from "./opencode.ts";

test("permission asks are auto-approved only for an active adapter worker", async () => {
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const approvals: string[] = [];
  let sessionId = "";
  let assistant: Record<string, any> | undefined;

  const emit = (payload: Record<string, unknown>): void => {
    const chunk = encoder.encode(`data: ${JSON.stringify({ payload })}\n\n`);
    for (const stream of streams) stream.enqueue(chunk);
  };

  const complete = (): void => {
    if (!assistant) return;
    assistant.info.time.completed = Date.now();
    emit({ type: "session.idle", properties: { sessionID: sessionId } });
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
        sessionId = "session-owned";
        return Response.json({ id: sessionId });
      }
      if (request.method === "GET" && url.pathname === "/permission") return Response.json([]);
      if (request.method === "GET" && url.pathname === "/question") return Response.json([]);
      if (request.method === "GET" && url.pathname === "/session/status") {
        return Response.json({ [sessionId]: { type: assistant?.info.time.completed ? "idle" : "busy" } });
      }
      if (request.method === "POST" && url.pathname === `/session/${sessionId}/prompt_async`) {
        const body = (await request.json()) as { messageID: string };
        assistant = {
          info: {
            id: "assistant-1",
            role: "assistant",
            parentID: body.messageID,
            time: { created: Date.now() },
          },
          parts: [{ type: "text", text: "permission approved" }],
        };
        emit({
          type: "permission.asked",
          properties: { id: "unrelated-permission", sessionID: "some-other-session" },
        });
        emit({
          type: "permission.asked",
          properties: { id: "owned-permission", sessionID: sessionId },
        });
        return new Response(null, { status: 204 });
      }
      const permission = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
      if (request.method === "POST" && permission) {
        approvals.push(decodeURIComponent(permission[1]!));
        complete();
        return Response.json(true);
      }
      if (request.method === "GET" && url.pathname === `/session/${sessionId}/message`) {
        return Response.json(assistant ? [assistant] : []);
      }
      if (request.method === "GET" && url.pathname === `/session/${sessionId}/message/assistant-1`) {
        return assistant ? Response.json(assistant) : new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const client = new ManagedOpenCode(`http://127.0.0.1:${server.port}`);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const result = await client.runTurn(
      session,
      process.cwd(),
      "msg_00000000000000000000000000000000",
      { message: "use a tool" },
      new AbortController().signal,
    );
    expect(result).toBe("permission approved");
    expect(approvals).toEqual(["owned-permission"]);
  } finally {
    await client.stop();
    server.stop(true);
  }
});

test("a completed OpenCode message is recovered by its durable user message ID", async () => {
  const messageId = "msg_11111111111111111111111111111111";
  const assistant = {
    info: {
      id: "assistant-recovered",
      role: "assistant",
      parentID: messageId,
      time: { created: 1, completed: 2 },
    },
    parts: [{ type: "text", text: "recovered result" }],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true });
      if (url.pathname === "/permission" || url.pathname === "/question") return Response.json([]);
      if (url.pathname === "/session/session-recovery/message") return Response.json([assistant]);
      if (url.pathname === "/global/event") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const client = new ManagedOpenCode(`http://127.0.0.1:${server.port}`);
  try {
    expect(
      await client.recoverTurn(
        "session-recovery",
        process.cwd(),
        messageId,
        { message: "recover the durable task" },
        new AbortController().signal,
      ),
    ).toBe("recovered result");
  } finally {
    await client.stop();
    server.stop(true);
  }
});

test("recovery resubmits a turn that OpenCode never persisted", async () => {
  const messageId = "msg_55555555555555555555555555";
  let assistant: Record<string, any> | undefined;
  let submissions = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true });
      if (url.pathname === "/permission" || url.pathname === "/question") return Response.json([]);
      if (url.pathname === "/global/event") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.pathname === "/session/status") return Response.json({});
      if (url.pathname === "/session/session-lost-prompt/message") {
        return Response.json(assistant ? [assistant] : []);
      }
      if (request.method === "POST" && url.pathname === "/session/session-lost-prompt/prompt_async") {
        const body = (await request.json()) as { messageID: string };
        submissions++;
        assistant = {
          info: {
            id: "assistant-after-resubmit",
            role: "assistant",
            parentID: body.messageID,
            time: { created: 1, completed: 2 },
            finish: "stop",
          },
          parts: [{ type: "text", text: "recovered after resubmit" }],
        };
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const client = new ManagedOpenCode(`http://127.0.0.1:${server.port}`);
  try {
    const result = await client.recoverTurn(
      "session-lost-prompt",
      process.cwd(),
      messageId,
      { message: "retry the durable task" },
      new AbortController().signal,
    );
    expect(result).toBe("recovered after resubmit");
    expect(submissions).toBe(1);
  } finally {
    await client.stop();
    server.stop(true);
  }
});

test("a real-shaped completed message event finishes without relying on session.idle", async () => {
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const sessionId = "session-event-shape";
  let assistant: Record<string, any> | undefined;

  const emit = (payload: Record<string, unknown>): void => {
    const chunk = encoder.encode(`data: ${JSON.stringify({ directory: process.cwd(), payload })}\n\n`);
    for (const stream of streams) stream.enqueue(chunk);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true });
      if (url.pathname === "/permission" || url.pathname === "/question") return Response.json([]);
      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({ id: sessionId });
      }
      if (url.pathname === "/global/event") {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              streams.add(value);
              value.enqueue(
                encoder.encode(
                  'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
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
      if (request.method === "POST" && url.pathname === `/session/${sessionId}/prompt_async`) {
        const body = (await request.json()) as { messageID: string };
        void (async () => {
          await Bun.sleep(10);
          assistant = {
            info: {
              id: "assistant-event-shape",
              sessionID: sessionId,
              role: "assistant",
              parentID: body.messageID,
              time: { created: 1, completed: 2 },
              finish: "stop",
            },
            parts: [{ type: "text", text: "event-only result" }],
          };
          emit({ type: "message.updated", properties: { info: assistant.info } });
        })();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/session/status") {
        return Response.json({ [sessionId]: { type: "busy" } });
      }
      if (url.pathname === `/session/${sessionId}/message`) {
        return Response.json(assistant ? [assistant] : []);
      }
      if (url.pathname === `/session/${sessionId}/message/assistant-event-shape`) {
        return assistant ? Response.json(assistant) : new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const client = new ManagedOpenCode(`http://127.0.0.1:${server.port}`);
  const controller = new AbortController();
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const turn = client.runTurn(
      session,
      process.cwd(),
      "msg_22222222222222222222222222222222",
      { message: "complete from the event" },
      controller.signal,
    );
    const result = await Promise.race([
      turn,
      Bun.sleep(250).then(() => "__timed_out__"),
    ]);
    if (result === "__timed_out__") {
      controller.abort();
      await turn.catch(() => undefined);
    }
    expect(result).toBe("event-only result");
  } finally {
    await client.stop();
    server.stop(true);
  }
});

test("an idle status immediately after prompt acceptance does not fail the turn", async () => {
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const sessionId = "session-async-acceptance-race";
  let assistant: Record<string, any> | undefined;

  const emit = (payload: Record<string, unknown>): void => {
    const chunk = encoder.encode(`data: ${JSON.stringify({ payload })}\n\n`);
    for (const stream of streams) stream.enqueue(chunk);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true });
      if (url.pathname === "/permission" || url.pathname === "/question") return Response.json([]);
      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({ id: sessionId });
      }
      if (url.pathname === "/global/event") {
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
      if (request.method === "POST" && url.pathname === `/session/${sessionId}/prompt_async`) {
        const body = (await request.json()) as { messageID: string };
        emit({
          type: "message.updated",
          properties: {
            info: {
              id: body.messageID,
              sessionID: sessionId,
              role: "user",
              time: { created: 1 },
            },
          },
        });
        await Bun.sleep(10);
        void (async () => {
          await Bun.sleep(20);
          assistant = {
            info: {
              id: "assistant-after-acceptance-race",
              sessionID: sessionId,
              role: "assistant",
              parentID: body.messageID,
              time: { created: 1, completed: 2 },
              finish: "stop",
            },
            parts: [{ type: "text", text: "accepted result" }],
          };
          emit({ type: "message.updated", properties: { info: assistant.info } });
          emit({ type: "session.idle", properties: { sessionID: sessionId } });
        })();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/session/status") {
        return Response.json({ [sessionId]: { type: "idle" } });
      }
      if (url.pathname === `/session/${sessionId}/message`) {
        return Response.json(assistant ? [assistant] : []);
      }
      if (url.pathname === `/session/${sessionId}/message/assistant-after-acceptance-race`) {
        return assistant ? Response.json(assistant) : new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const client = new ManagedOpenCode(`http://127.0.0.1:${server.port}`);
  const controller = new AbortController();
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const turn = client.runTurn(
      session,
      process.cwd(),
      "msg_33333333333333333333333333",
      { message: "complete after async acceptance" },
      controller.signal,
    );
    const result = await Promise.race([turn, Bun.sleep(250).then(() => "__timed_out__")]);
    if (result === "__timed_out__") {
      controller.abort();
      await turn.catch(() => undefined);
    }
    expect(result).toBe("accepted result");
  } finally {
    await client.stop();
    server.stop(true);
  }
});

test("an intermediate tool-call step does not replace the final assistant report", async () => {
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const sessionId = "session-subagent-report";
  const messages: Record<string, any>[] = [];
  let finalReady = false;

  const emit = (payload: Record<string, unknown>): void => {
    const chunk = encoder.encode(`data: ${JSON.stringify({ payload })}\n\n`);
    for (const stream of streams) stream.enqueue(chunk);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true });
      if (url.pathname === "/permission" || url.pathname === "/question") return Response.json([]);
      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({ id: sessionId });
      }
      if (url.pathname === "/global/event") {
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
      if (request.method === "POST" && url.pathname === `/session/${sessionId}/prompt_async`) {
        const body = (await request.json()) as { messageID: string };
        const toolCall = {
          info: {
            id: "assistant-tool-call",
            sessionID: sessionId,
            role: "assistant",
            parentID: body.messageID,
            time: { created: 1, completed: 2 },
            finish: "tool-calls",
          },
          parts: [{ type: "tool", tool: "task", state: { status: "completed" } }],
        };
        messages.push(toolCall);
        emit({ type: "message.updated", properties: { info: toolCall.info } });
        await Bun.sleep(10);
        void (async () => {
          await Bun.sleep(20);
          const final = {
            info: {
              id: "assistant-final-report",
              sessionID: sessionId,
              role: "assistant",
              parentID: body.messageID,
              time: { created: 3, completed: 4 },
              finish: "stop",
            },
            parts: [{ type: "text", text: "final delegated report" }],
          };
          messages.push(final);
          finalReady = true;
          emit({ type: "message.updated", properties: { info: final.info } });
          emit({ type: "session.idle", properties: { sessionID: sessionId } });
        })();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/session/status") {
        return Response.json({ [sessionId]: { type: finalReady ? "idle" : "busy" } });
      }
      if (url.pathname === `/session/${sessionId}/message`) return Response.json(messages);
      const message = messages.find((item) => url.pathname.endsWith(`/${item.info.id}`));
      if (message) return Response.json(message);
      return new Response("not found", { status: 404 });
    },
  });

  const client = new ManagedOpenCode(`http://127.0.0.1:${server.port}`);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const result = await client.runTurn(
      session,
      process.cwd(),
      "msg_44444444444444444444444444",
      { message: "delegate to a subagent" },
      new AbortController().signal,
    );
    expect(result).toBe("final delegated report");
  } finally {
    await client.stop();
    server.stop(true);
  }
});
