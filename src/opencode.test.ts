import { expect, test } from "bun:test";
import { startFakeOpenCode, type FakeMessage, type FakeOpenCode, type FakeSession, type PromptContext } from "../test/fake-opencode.ts";
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

test("a turn that reports no progress for turnTimeoutMs is failed as a timeout", async () => {
  // 上流(OpenCode本体)がレート制限等のリトライ失敗後、SSE で何のイベントも送出
  // せず無応答のまま固まるケースを再現する。onPrompt が何もしないことで、
  // busy/idle/error のいずれのイベントも来ない状況を作る。
  const openCode = startFakeOpenCode({
    onPrompt() {
      // 意図的に何もしない: セッションは busy にも idle にもならない。
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 50, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    await expect(
      client.executeTurn(
        session,
        process.cwd(),
        "msg_77777777777777777777777777777777",
        { message: "this will never receive a progress event" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "OPENCODE_TURN_TIMEOUT", retryable: true });
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("child-only SSE activity postpones the timeout", async () => {
  let parentId = "";
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      parentId = context.session.id;
      context.session.status = "idle";
      context.addUser();
      void (async () => {
        for (let i = 0; i < 6; i++) {
          await Bun.sleep(20);
          const child = openCode.session(`child-active-${i}`, process.cwd(), parentId);
          emitStep(openCode, child, i, "bash");
        }
        await Bun.sleep(10);
        const assistant = context.addAssistant({ text: "parent done after children" });
        context.complete(assistant);
      })();
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 80, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const result = await client.executeTurn(
      session,
      process.cwd(),
      "msg_99999999999999999999999999999991",
      { message: "delegate to subagents" },
      new AbortController().signal,
      "turn-child-sse",
    );
    expect(result).toBe("parent done after children");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("events from a completed turn do not mark the next turn", async () => {
  let secondContext: PromptContext | undefined;
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      context.session.status = "idle";
      context.addUser();
      if (context.prompt === "first turn") {
        const oldChild = openCode.session("old-child", process.cwd(), context.session.id);
        emitStep(openCode, oldChild, 1, "old-tool");
        void (async () => {
          await Bun.sleep(10);
          const assistant = context.addAssistant({ text: "first complete" });
          context.complete(assistant);
        })();
      } else {
        secondContext = context;
      }
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 500, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    await client.executeTurn(
      session,
      process.cwd(),
      "msg_11111111111111111111111111111111",
      { message: "first turn" },
      new AbortController().signal,
      "turn-one",
    );
    const second = client.executeTurn(
      session,
      process.cwd(),
      "msg_22222222222222222222222222222222",
      { message: "second turn" },
      new AbortController().signal,
      "turn-two",
    );
    await Bun.sleep(30);
    openCode.emit("session.status", { sessionID: "old-child", status: { type: "busy" } });
    openCode.emit("message.part.updated", {
      sessionID: "old-child",
      time: Date.now(),
      part: { id: "old-late", messageID: "old-late-message", sessionID: "old-child", type: "tool", tool: "old-tool" },
    });
    await Bun.sleep(10);
    const progress = await client.turnProgress("turn-two", session, process.cwd());
    expect(progress?.activeSubagents).toBe(0);
    expect(progress?.lastTool).toBeUndefined();
    if (!secondContext) throw new Error("second prompt did not start");
    const assistant = secondContext.addAssistant({ text: "second complete" });
    secondContext.complete(assistant);
    await expect(second).resolves.toBe("second complete");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("grandchild SSE activity is included in progress", async () => {
  let parentId = "";
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      parentId = context.session.id;
      context.session.status = "idle";
      context.addUser();
      const child = openCode.session("child-progress-parent", process.cwd(), parentId);
      const grandchild = openCode.session("grandchild-progress", process.cwd(), child.id);
      emitStep(openCode, child, 1, "read");
      emitStep(openCode, grandchild, 1, "bash");
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const pending = client.executeTurn(
      session,
      process.cwd(),
      "msg_99999999999999999999999999999993",
      { message: "delegate to a grandchild" },
      new AbortController().signal,
      "turn-grandchild-sse",
    );
    pending.catch(() => {});
    await Bun.sleep(40);
    const progress = await client.turnProgress("turn-grandchild-sse", session, process.cwd());
    expect(progress).toMatchObject({ steps: 2, activeSubagents: 2, lastTool: "bash" });
    await client.stop();
    await expect(pending).rejects.toMatchObject({ code: "OPENCODE_STOPPED" });
  } finally {
    openCode.stop();
  }
});

test("stalled child SSE activity still times out", async () => {
  let parentId = "";
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      parentId = context.session.id;
      context.session.status = "idle";
      context.addUser();
      const child = openCode.session("child-stalled", process.cwd(), parentId);
      emitStep(openCode, child, 1, "read");
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 60, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    await expect(
      client.executeTurn(
        session,
        process.cwd(),
        "msg_99999999999999999999999999999992",
        { message: "children stall" },
        new AbortController().signal,
        "turn-stalled-sse",
      ),
    ).rejects.toMatchObject({ code: "OPENCODE_TURN_TIMEOUT", retryable: true });
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("turn progress summarizes subagent activity", async () => {
  let parentId = "";
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      parentId = context.session.id;
      context.session.status = "idle";
      context.addUser();
      const child = openCode.session("child-progress", process.cwd(), parentId);
      emitStep(openCode, child, 1, "bash");
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const pending = client.executeTurn(
      session,
      process.cwd(),
      "msg_99999999999999999999999999999993",
      { message: "check progress" },
      new AbortController().signal,
      "turn-progress",
    );
    pending.catch(() => {});
    await Bun.sleep(80);
    const progress = await client.turnProgress("turn-progress", session, process.cwd());
    expect(progress).toMatchObject({ activeSubagents: 1, lastTool: "bash" });
    expect(progress?.steps).toBeGreaterThanOrEqual(1);
    expect(progress?.lastActivityAt).toBeGreaterThan(0);
    await client.stop();
    await expect(pending).rejects.toMatchObject({ code: "OPENCODE_STOPPED" });
  } finally {
    openCode.stop();
  }
});

test("progress events (busy) postpone the timeout", async () => {
  // busy イベントで lastActivityAt が更新される限りタイムアウトしないことを
  // 確認する。turnTimeoutMs(60ms) の合計より長い期間 busy を送り続けても
  // タイムアウトせず、最後に完了すれば正常に resolve することを検証する。
  const openCode = startFakeOpenCode({
    async onPrompt(context) {
      context.session.status = "busy";
      context.addUser();
      for (let i = 0; i < 5; i++) {
        await Bun.sleep(20);
        context.emit("session.status", { sessionID: context.session.id, status: { type: "busy" } });
      }
      const assistant = context.addAssistant({ text: "finished after being kept alive" });
      context.complete(assistant);
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 60, 15);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const result = await client.executeTurn(
      session,
      process.cwd(),
      "msg_88888888888888888888888888888888",
      { message: "keep alive via busy events" },
      new AbortController().signal,
    );
    expect(result).toBe("finished after being kept alive");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

function emitStep(openCode: FakeOpenCode, session: FakeSession, step: number, tool?: string): void {
  const messageID = `${session.id}-message-${step}`;
  openCode.emit("session.status", { sessionID: session.id, status: { type: "busy" } });
  openCode.emit("message.part.updated", {
    sessionID: session.id,
    time: Date.now(),
    part: { id: `${messageID}-start`, messageID, sessionID: session.id, type: "step-start" },
  });
  if (tool) {
    openCode.emit("message.part.updated", {
      sessionID: session.id,
      time: Date.now(),
      part: { id: `${messageID}-tool`, messageID, sessionID: session.id, type: "tool", tool },
    });
  }
}
