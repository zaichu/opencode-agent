import { expect, test } from "bun:test";
import { startFakeOpenCode, type FakeMessage, type PromptContext } from "../test/fake-opencode.ts";
import { ManagedOpenCode } from "./opencode.ts";

test("permission asks are auto-approved only for an active adapter worker", async () => {
  let assistant: FakeMessage | undefined;
  let prompt: PromptContext | undefined;
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      prompt = context;
      context.session.status = "busy";
      context.addUser();
      assistant = context.addAssistant({ text: "permission approved" });
      context.emit("permission.asked", { id: "unrelated-permission", sessionID: "some-other-session" });
      context.emit("permission.asked", { id: "owned-permission", sessionID: context.session.id });
    },
    onPermissionReply(requestId) {
      if (requestId === "owned-permission" && prompt && assistant) prompt.complete(assistant);
    },
  });
  const client = new ManagedOpenCode(openCode.url);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const result = await client.executeTurn(
      session,
      process.cwd(),
      "msg_00000000000000000000000000000000",
      { message: "use a tool" },
      new AbortController().signal,
    );
    expect(result).toBe("permission approved");
    expect(openCode.approvals).toEqual(["owned-permission"]);
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("a completed OpenCode message is recovered by its durable user message ID", async () => {
  const messageId = "msg_11111111111111111111111111111111";
  const openCode = startFakeOpenCode();
  openCode.session("session-recovery").messages.push({
    info: {
      id: "assistant-recovered",
      role: "assistant",
      parentID: messageId,
      time: { created: 1, completed: 2 },
      finish: "stop",
    },
    parts: [{ type: "text", text: "recovered result" }],
  });
  const client = new ManagedOpenCode(openCode.url);
  try {
    expect(
      await client.executeTurn(
        "session-recovery",
        process.cwd(),
        messageId,
        { message: "recover the durable task" },
        new AbortController().signal,
      ),
    ).toBe("recovered result");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("recovery resubmits a turn that OpenCode never persisted", async () => {
  const messageId = "msg_55555555555555555555555555";
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      context.addUser();
      context.addAssistant({ text: "recovered after resubmit", completed: true, finish: "stop" });
    },
  });
  openCode.session("session-lost-prompt");
  const client = new ManagedOpenCode(openCode.url);
  try {
    expect(
      await client.executeTurn(
        "session-lost-prompt",
        process.cwd(),
        messageId,
        { message: "retry the durable task" },
        new AbortController().signal,
      ),
    ).toBe("recovered after resubmit");
    expect(openCode.submissions).toBe(1);
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("a completed message event finishes without relying on session idle", async () => {
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      context.session.status = "busy";
      context.addUser();
      void (async () => {
        await Bun.sleep(10);
        const assistant = context.addAssistant({
          id: "assistant-event-shape",
          text: "event-only result",
          completed: true,
          finish: "stop",
        });
        context.emitMessage(assistant);
      })();
    },
  });
  const client = new ManagedOpenCode(openCode.url);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    expect(
      await client.executeTurn(
        session,
        process.cwd(),
        "msg_22222222222222222222222222222222",
        { message: "complete from the event" },
        new AbortController().signal,
      ),
    ).toBe("event-only result");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("an idle status immediately after prompt acceptance does not fail the turn", async () => {
  const openCode = startFakeOpenCode({
    async onPrompt(context) {
      context.addUser();
      await Bun.sleep(10);
      void (async () => {
        await Bun.sleep(20);
        const assistant = context.addAssistant({
          id: "assistant-after-acceptance-race",
          text: "accepted result",
          completed: true,
          finish: "stop",
        });
        context.emitMessage(assistant);
        context.emit("session.idle", { sessionID: context.session.id });
      })();
    },
  });
  const client = new ManagedOpenCode(openCode.url);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    expect(
      await client.executeTurn(
        session,
        process.cwd(),
        "msg_33333333333333333333333333",
        { message: "complete after async acceptance" },
        new AbortController().signal,
      ),
    ).toBe("accepted result");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("an intermediate tool-call step does not replace the final assistant report", async () => {
  const openCode = startFakeOpenCode({
    async onPrompt(context) {
      context.session.status = "busy";
      context.addUser();
      const toolCall = context.addAssistant({
        id: "assistant-tool-call",
        parts: [{ type: "tool", tool: "task", state: { status: "completed" } }],
        completed: true,
        finish: "tool-calls",
      });
      context.emitMessage(toolCall);
      await Bun.sleep(10);
      void (async () => {
        await Bun.sleep(20);
        const final = context.addAssistant({
          id: "assistant-final-report",
          text: "final delegated report",
          completed: true,
          finish: "stop",
        });
        context.emitMessage(final);
        context.emit("session.idle", { sessionID: context.session.id });
      })();
    },
  });
  const client = new ManagedOpenCode(openCode.url);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    expect(
      await client.executeTurn(
        session,
        process.cwd(),
        "msg_44444444444444444444444444",
        { message: "delegate to a subagent" },
        new AbortController().signal,
      ),
    ).toBe("final delegated report");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("malformed OpenCode responses fail at the adapter seam", async () => {
  const openCode = startFakeOpenCode({ messagesResponse: () => ({ not: "an array" }) });
  openCode.session("session-malformed");
  const client = new ManagedOpenCode(openCode.url);
  try {
    expect(
      client.executeTurn(
        "session-malformed",
        process.cwd(),
        "msg_66666666666666666666666666",
        { message: "fail predictably" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_OPENCODE_RESPONSE", retryable: false });
  } finally {
    await client.stop();
    openCode.stop();
  }
});
