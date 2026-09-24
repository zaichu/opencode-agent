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

test("child-only activity postpones the timeout", async () => {
  // 親の SSE には何も流れないが、子セッションだけが動き続けるケース。
  // 30秒検査(ここでは短縮)が子孫の Session.time.updated を見て
  // lastActivityAt を更新し続ける限りタイムアウトしないことを検証する。
  let parentId = "";
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      parentId = context.session.id;
      context.session.status = "idle";
      context.addUser();
      // 親は SSE で何も送らない: busy にも idle にも complete にもしない。
      void (async () => {
        for (let i = 0; i < 6; i++) {
          await Bun.sleep(20);
          const child = openCode.session(`child-active-${i}`, process.cwd(), parentId);
          child.messages.push({
            info: {
              id: `child-assistant-${i}`,
              sessionID: child.id,
              role: "assistant",
              time: { created: Date.now() },
            },
            parts: [{ type: "tool", tool: "bash" }],
          });
          openCode.touch(child.id);
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
    );
    expect(result).toBe("parent done after children");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("stalled children still time out", async () => {
  // 子が一度だけ動いて止まり、親も何も送らなければタイムアウトすることを検証する。
  let parentId = "";
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      parentId = context.session.id;
      context.session.status = "idle";
      context.addUser();
      const child = openCode.session("child-stalled", process.cwd(), parentId);
      child.messages.push({
        info: {
          id: "child-assistant-once",
          sessionID: child.id,
          role: "assistant",
          time: { created: Date.now() },
        },
        parts: [{ type: "text", text: "one step" }],
      });
      openCode.touch(child.id);
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
      child.messages.push({
        info: {
          id: "child-assistant-progress",
          sessionID: child.id,
          role: "assistant",
          time: { created: Date.now() },
        },
        parts: [{ type: "tool", tool: "bash" }],
      });
      openCode.touch(child.id);
      // turn は終わらせない。progress だけを検査する。
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
    );
    pending.catch(() => {});
    await Bun.sleep(80);
    const progress = await client.turnProgress(session, process.cwd());
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
