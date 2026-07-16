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
      await client.recoverTurn("session-recovery", messageId, new AbortController().signal),
    ).toBe("recovered result");
  } finally {
    await client.stop();
    server.stop(true);
  }
});
