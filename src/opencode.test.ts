import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeOpenCode, type FakeMessage, type FakeOpenCode, type FakeSession, type PromptContext } from "../test/fake-opencode.ts";
import { ManagedOpenCode } from "./opencode.ts";

test("permission asks are auto-approved only for an active adapter worker", async () => {
  let assistant: FakeMessage | undefined;
  let prompt: PromptContext | undefined;
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      prompt = context;
      context.session.busy = true;
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

test("a completed OpenCode turn is recovered from its durable user message ID", async () => {
  const messageId = "msg_11111111111111111111111111111111";
  const openCode = startFakeOpenCode();
  const session = openCode.session("session-recovery");
  session.messages.push(
    { id: messageId, type: "user", time: { created: 1 }, text: "recover the durable task" },
    {
      id: "assistant-recovered",
      type: "assistant",
      time: { created: 2, completed: 3 },
      content: [{ type: "text", text: "recovered result" }],
      finish: "stop",
    },
    { id: "idle-recovered", type: "idle", time: { created: 4 }, outcome: "succeeded" },
  );
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
    expect(openCode.submissions).toBe(0);
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("recovery resubmits a turn OpenCode never persisted", async () => {
  const messageId = "msg_55555555555555555555555555";
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      context.addUser();
      context.addAssistant({ text: "recovered after resubmit", completed: true, finish: "stop" });
      context.complete(context.session.messages[context.session.messages.length - 1]!);
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

test("a succeeded execution event finishes without polling differences", async () => {
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      context.session.busy = true;
      context.addUser();
      void (async () => {
        await Bun.sleep(10);
        const assistant = context.addAssistant({
          id: "assistant-event-shape",
          text: "event-only result",
          completed: true,
          finish: "stop",
        });
        context.complete(assistant);
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

test("an execution event immediately after prompt admission does not fail the turn", async () => {
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
        context.complete(assistant);
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
        "msg_33333333333333333333333333333333",
        { message: "complete after async admission" },
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
      context.session.busy = true;
      context.addUser();
      context.addAssistant({
        id: "assistant-tool-call",
        content: [{ type: "tool", name: "task" }],
        completed: true,
        finish: "tool-calls",
      });
      await Bun.sleep(10);
      void (async () => {
        await Bun.sleep(20);
        const final = context.addAssistant({
          id: "assistant-final-report",
          text: "final delegated report",
          completed: true,
          finish: "stop",
        });
        context.complete(final);
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
        "msg_44444444444444444444444444444444",
        { message: "delegate to a subagent" },
        new AbortController().signal,
      ),
    ).toBe("final delegated report");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("a finished mid-turn step does not complete a follow-up turn before the idle marker", async () => {
  // Issue #4 の再現形。途中 step の assistant メッセージが finish・completed 時刻を
  // 持って確定してもループは続く。v1 はこの形を turn 終端と誤認し、実行中に
  // 空 text の completed を返した。v2 は idle マーカーのみを完了とみなす。
  let second: PromptContext | undefined;
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      context.session.busy = true;
      context.addUser();
      if (context.prompt === "first turn") {
        const assistant = context.addAssistant({ text: "first done", completed: true, finish: "stop" });
        context.complete(assistant);
        return;
      }
      second = context;
      context.addAssistant({ id: "assistant-mid-step", completed: true, finish: "stop" });
      // step 境界でセッションが一時的に active 一覧から外れ、idle 相当の
      // シグナルが届いても turn は解決しないこと。
      context.session.busy = false;
      context.emit("session.status", { sessionID: context.session.id, status: { type: "idle" } });
      context.emit("session.execution.succeeded", { sessionID: context.session.id });
      void (async () => {
        await Bun.sleep(30);
        const assistant = context.addAssistant({
          id: "assistant-final",
          text: "second real result",
          completed: true,
          finish: "stop",
        });
        context.complete(assistant);
      })();
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    await client.executeTurn(
      session,
      process.cwd(),
      "msg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11",
      { message: "first turn" },
      new AbortController().signal,
      "turn-first",
    );
    // 途中で完了すれば "" か前turnの "first done" が返る。最終 step の text が
    // 返ることで idle マーカーまで待ったことを確認する。
    const result = await client.executeTurn(
      session,
      process.cwd(),
      "msg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa22",
      { message: "second turn" },
      new AbortController().signal,
      "turn-second",
    );
    expect(result).toBe("second real result");
    expect(second).toBeDefined();
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
        "msg_66666666666666666666666666666666",
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
      context.session.busy = false;
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
      context.session.busy = false;
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
    openCode.emit("session.step.started", {
      sessionID: "old-child",
      started: Date.now(),
      assistantMessageID: "old-late-message",
    });
    openCode.emit("session.tool.input.started", { sessionID: "old-child", name: "old-tool" });
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
      context.session.busy = false;
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
      context.session.busy = false;
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

test("a slow polling request does not delay the turn timeout", async () => {
  const openCode = startFakeOpenCode({
    pollMessagesDelayMs: 200,
    onPrompt() {},
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 80, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const started = Date.now();
    await expect(
      client.executeTurn(
        session,
        process.cwd(),
        "msg_33333333333333333333333333333333",
        { message: "poll timeout" },
        new AbortController().signal,
        "turn-poll-timeout",
      ),
    ).rejects.toMatchObject({ code: "OPENCODE_TURN_TIMEOUT", retryable: true });
    expect(openCode.pollMessageRequests).toBe(1);
    expect(Date.now() - started).toBeLessThan(160);
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("failed or empty polling responses do not count as progress", async () => {
  let mode: "failed" | "empty" = "empty";
  const openCode = startFakeOpenCode({
    pollMessagesStatus: () => (mode === "failed" ? 500 : 200),
    pollMessagesResponse: (session) => (mode === "empty" ? [] : session?.messages ?? []),
    onPrompt(context) {
      context.session.busy = false;
      context.addUser();
      mode = "failed";
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 180, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const pending = client.executeTurn(
      session,
      process.cwd(),
      "msg_44444444444444444444444444444444",
      { message: "failed polling" },
      new AbortController().signal,
      "turn-failed-polling",
    );
    pending.catch(() => {});
    await Bun.sleep(50);
    const first = await client.turnProgress("turn-failed-polling", session, process.cwd());
    mode = "empty";
    await Bun.sleep(50);
    const second = await client.turnProgress("turn-failed-polling", session, process.cwd());
    expect(openCode.pollMessageRequests).toBeGreaterThan(0);
    expect(second?.lastActivityAt).toBe(first?.lastActivityAt);
    await expect(pending).rejects.toMatchObject({ code: "OPENCODE_TURN_TIMEOUT", retryable: true });
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("polling catches child activity missed by SSE", async () => {
  let child!: FakeSession;
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      context.session.busy = false;
      context.addUser();
      child = openCode.session("polled-child", process.cwd(), context.session.id, false);
      void (async () => {
        for (let index = 0; index < 6; index++) {
          await Bun.sleep(25);
          addPolledMessage(child, index, "bash");
        }
        await Bun.sleep(10);
        const assistant = context.addAssistant({ text: "parent done after polling" });
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
      "msg_55555555555555555555555555555555",
      { message: "polled child" },
      new AbortController().signal,
      "turn-polled-child",
    );
    expect(result).toBe("parent done after polling");
    expect(openCode.pollMessageRequests).toBeGreaterThan(0);
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("polling caps descendant discovery and message requests per round", async () => {
  let openCode!: FakeOpenCode;
  let rootId = "";
  let descendantsRequests = 0;
  let firstRoundResolve!: () => void;
  let secondRoundResolve!: () => void;
  const firstRound = new Promise<void>((resolve) => {
    firstRoundResolve = resolve;
  });
  const secondRound = new Promise<void>((resolve) => {
    secondRoundResolve = resolve;
  });
  let rootPolls = 0;
  openCode = startFakeOpenCode({
    onPrompt(context) {
      rootId = context.session.id;
      context.session.busy = true;
      context.addUser();
      for (let index = 0; index < 6; index++) {
        const child = openCode.session(`capped-child-${index}`, process.cwd(), rootId, false);
        if (index === 5) addPolledMessage(child, 1, "bash");
      }
    },
    childrenStatus() {
      descendantsRequests++;
      return 200;
    },
    pollMessagesResponse(session) {
      if (session?.id === rootId) {
        rootPolls++;
        if (rootPolls === 1) firstRoundResolve();
        if (rootPolls === 2) secondRoundResolve();
      }
      return session?.messages ?? [];
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 30, 2_000, 2, 2, 1_000);
  const pending = client.executeTurn(
    await client.createSession({ directory: process.cwd() }),
    process.cwd(),
    "msg_00000000000000000000000000000010",
    { message: "cap polling" },
    new AbortController().signal,
    "turn-cap-polling",
  );
  pending.catch(() => {});
  try {
    await firstRound;
    expect(descendantsRequests).toBeLessThanOrEqual(2);
    expect(openCode.pollMessageRequests).toBeLessThanOrEqual(2);
    await secondRound;
    expect(descendantsRequests).toBeGreaterThan(2);
    expect(openCode.pollMessageRequests).toBeGreaterThan(2);
    await Bun.sleep(100);
    const progress = await client.turnProgress("turn-cap-polling", rootId, process.cwd());
    expect(progress?.lastTool).toBe("bash");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("recently active descendants are polled before older descendants", async () => {
  let openCode!: FakeOpenCode;
  let rootId = "";
  let targetId = "";
  const firstBatch: string[] = [];
  let firstBatchResolve!: () => void;
  const firstBatchReady = new Promise<void>((resolve) => {
    firstBatchResolve = resolve;
  });
  openCode = startFakeOpenCode({
    onPrompt(context) {
      rootId = context.session.id;
      context.session.busy = true;
      context.addUser();
      for (let index = 0; index < 5; index++) {
        openCode.session(`older-child-${index}`, process.cwd(), rootId, false);
      }
      const target = openCode.session("recent-child", process.cwd(), rootId, false);
      targetId = target.id;
      openCode.emit("session.created", {
        sessionID: target.id,
        parentID: rootId,
      });
      openCode.emit("session.step.started", {
        sessionID: target.id,
        started: Date.now(),
        assistantMessageID: "recent-message",
      });
    },
    pollMessagesResponse(session) {
      if (session && firstBatch.length < 2) {
        firstBatch.push(session.id);
        if (firstBatch.length === 2) firstBatchResolve();
      }
      return [];
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 30, 2_000, 2, 2, 1_000);
  const session = await client.createSession({ directory: process.cwd() });
  const pending = client.executeTurn(
    session,
    process.cwd(),
    "msg_00000000000000000000000000000011",
    { message: "prioritize recent descendants" },
    new AbortController().signal,
    "turn-prioritize-polling",
  );
  pending.catch(() => {});
  try {
    await firstBatchReady;
    expect(firstBatch).toContain(targetId);
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("the same message is counted once when polling and SSE overlap", async () => {
  let openCode!: FakeOpenCode;
  let context!: PromptContext;
  let child!: FakeSession;
  let firstPolledResolve!: () => void;
  const firstPolled = new Promise<void>((resolve) => {
    firstPolledResolve = resolve;
  });
  openCode = startFakeOpenCode({
    onPrompt(current) {
      context = current;
      current.session.busy = true;
      current.addUser();
      child = openCode.session("overlap-child", process.cwd(), current.session.id, false);
      addPolledMessage(child, 1, "bash");
    },
    pollMessagesResponse(session) {
      if (session?.id === child?.id) firstPolledResolve();
      return session?.messages ?? [];
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 30, 2_000, 2, 2, 1_000);
  const session = await client.createSession({ directory: process.cwd() });
  const pending = client.executeTurn(
    session,
    process.cwd(),
    "msg_00000000000000000000000000000012",
    { message: "deduplicate steps" },
    new AbortController().signal,
    "turn-deduplicate-steps",
  );
  pending.catch(() => {});
  try {
    await firstPolled;
    await Bun.sleep(10);
    openCode.emit("session.step.started", {
      sessionID: child.id,
      started: Date.now(),
      assistantMessageID: child.messages[child.messages.length - 1]!.id,
    });
    await Bun.sleep(20);
    const progress = await client.turnProgress("turn-deduplicate-steps", session, process.cwd());
    expect(progress?.steps).toBe(1);
    const assistant = context.addAssistant({ text: "deduplicated" });
    context.complete(assistant);
    await expect(pending).resolves.toBe("deduplicated");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("completed turn descendants do not attach to a follow-up turn", async () => {
  let openCode!: FakeOpenCode;
  let secondContext: PromptContext | undefined;
  let sessionId = "";
  openCode = startFakeOpenCode({
    onPrompt(context) {
      sessionId = context.session.id;
      context.session.busy = true;
      context.addUser();
      if (context.prompt === "first turn") {
        openCode.session("retired-child", process.cwd(), sessionId);
        void (async () => {
          await Bun.sleep(20);
          const assistant = context.addAssistant({ text: "first complete" });
          context.complete(assistant);
        })();
      } else {
        secondContext = context;
      }
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 30, 2_000, 2, 2, 1_000);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    await client.executeTurn(
      session,
      process.cwd(),
      "msg_00000000000000000000000000000013",
      { message: "first turn" },
      new AbortController().signal,
      "turn-first",
    );
    const second = client.executeTurn(
      session,
      process.cwd(),
      "msg_00000000000000000000000000000014",
      { message: "second turn" },
      new AbortController().signal,
      "turn-second",
    );
    second.catch(() => {});
    await Bun.sleep(20);
    openCode.emit("session.created", { sessionID: "retired-child", parentID: sessionId }, 1);
    await Bun.sleep(20);
    const progress = await client.turnProgress("turn-second", session, process.cwd());
    expect(progress?.activeSubagents).toBe(0);
    if (!secondContext) throw new Error("second prompt did not start");
    const assistant = secondContext.addAssistant({ text: "second complete" });
    secondContext.complete(assistant);
    await expect(second).resolves.toBe("second complete");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("completed turn mappings and late SSE stay out of the next turn", async () => {
  let openCode!: FakeOpenCode;
  let secondContext: PromptContext | undefined;
  let childId = "late-child";
  openCode = startFakeOpenCode({
    async onPrompt(context) {
      context.session.busy = true;
      context.addUser();
      if (context.prompt === "turn A") {
        openCode.session(childId, process.cwd(), context.session.id);
        await Bun.sleep(20);
        const assistant = context.addAssistant({ text: "turn A complete" });
        context.complete(assistant);
      } else {
        secondContext = context;
      }
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 30, 2_000, 2, 2, 1_000);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    await client.executeTurn(
      session,
      process.cwd(),
      "msg_00000000000000000000000000000013",
      { message: "turn A" },
      new AbortController().signal,
      "turn-A",
    );
    // 完了した turn の対応付けは公開 API からも消えていること。
    expect(await client.turnProgress("turn-A", session, process.cwd())).toBeUndefined();

    const second = client.executeTurn(
      session,
      process.cwd(),
      "msg_00000000000000000000000000000014",
      { message: "turn B" },
      new AbortController().signal,
      "turn-B",
    );
    second.catch(() => {});
    await Bun.sleep(30);
    if (!secondContext) throw new Error("turn B did not start");
    const before = await client.turnProgress("turn-B", session, process.cwd());
    if (!before) throw new Error("turn B progress was unavailable");

    // 前 turn の子セッションについて、生成時刻が turn B 開始前の再送
    // session.created と遅延した活動イベントを流しても turn B に混入しないこと。
    openCode.emit("session.created", { sessionID: childId, parentID: session }, 1);
    openCode.emit("session.step.started", {
      sessionID: childId,
      started: Date.now(),
      assistantMessageID: "late-message",
    });
    openCode.emit("session.status", { sessionID: childId, status: { type: "busy" } });
    await Bun.sleep(20);

    const after = await client.turnProgress("turn-B", session, process.cwd());
    expect(after?.lastActivityAt).toBe(before.lastActivityAt);
    expect(after?.steps).toBe(before.steps);
    expect(after?.activeSubagents).toBe(before.activeSubagents);
    expect(after?.steps).toBe(0);
    expect(after?.activeSubagents).toBe(0);

    const assistant = secondContext.addAssistant({ text: "turn B complete" });
    secondContext.complete(assistant);
    await expect(second).resolves.toBe("turn B complete");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("inactive descendants leave activeSubagents after the idle grace period", async () => {
  let openCode!: FakeOpenCode;
  openCode = startFakeOpenCode({
    onPrompt(context) {
      context.session.busy = true;
      context.addUser();
      const child = openCode.session("stale-child", process.cwd(), context.session.id);
      emitStep(openCode, child, 1, "bash");
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 10, 2_000, 2, 2, 30);
  const session = await client.createSession({ directory: process.cwd() });
  const pending = client.executeTurn(
    session,
    process.cwd(),
    "msg_00000000000000000000000000000015",
    { message: "stale child" },
    new AbortController().signal,
    "turn-stale-child",
  );
  pending.catch(() => {});
  try {
    await Bun.sleep(80);
    const progress = await client.turnProgress("turn-stale-child", session, process.cwd());
    expect(progress?.activeSubagents).toBe(0);
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("polling finds descendants beyond the first hundred sessions", async () => {
  let secondContext: PromptContext | undefined;
  let openCode!: FakeOpenCode;
  openCode = startFakeOpenCode({
    onPrompt(context) {
      context.session.busy = false;
      context.addUser();
      const children: FakeSession[] = [];
      for (let index = 0; index <= 100; index++) {
        children.push(openCode.session(`many-child-${index}`, process.cwd(), context.session.id, false));
      }
      addPolledMessage(children[100]!, 1, "bash");
      secondContext = context;
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 1_000, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const pending = client.executeTurn(
      session,
      process.cwd(),
      "msg_66666666666666666666666666666666",
      { message: "many descendants" },
      new AbortController().signal,
      "turn-many-descendants",
    );
    pending.catch(() => {});
    await Bun.sleep(200);
    const progress = await client.turnProgress("turn-many-descendants", session, process.cwd());
    expect(progress?.lastTool).toBe("bash");
    if (!secondContext) throw new Error("prompt did not create descendants");
    const assistant = secondContext.addAssistant({ text: "many descendants complete" });
    secondContext.complete(assistant);
    await expect(pending).resolves.toBe("many descendants complete");
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
      context.session.busy = false;
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
      context.session.busy = true;
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

test("a persisted serve password reconnects to the server that used it", async () => {
  // daemon が落ちて serve だけが残った想定。状態ディレクトリに退避した
  // パスワードを次の起動で読み、401 の serve へそのまま接続できる。
  await withoutEnvPassword(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-agent-auth-"));
    const passwordFile = join(directory, "serve.password");
    await writeFile(passwordFile, "pw-persisted", { mode: 0o600 });
    const openCode = startFakeOpenCode({ password: "pw-persisted" });
    const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 10, 2_000, 2, 2, 1_000, passwordFile);
    try {
      const session = await client.createSession({ directory: process.cwd() });
      const result = await client.executeTurn(
        session,
        process.cwd(),
        "msg_77777777777777777777777777777777",
        { message: "auth check" },
        new AbortController().signal,
      );
      expect(result).toBe("reply: auth check");
    } finally {
      await client.stop();
      openCode.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("a password from OPENCODE_PASSWORD authenticates against the server", async () => {
  await withoutEnvPassword(async () => {
    Bun.env.OPENCODE_PASSWORD = "pw-env";
    const openCode = startFakeOpenCode({ password: "pw-env" });
    const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 10, 2_000, 2, 2, 1_000);
    try {
      const session = await client.createSession({ directory: process.cwd() });
      const result = await client.executeTurn(
        session,
        process.cwd(),
        "msg_88888888888888888888888888888888",
        { message: "env auth" },
        new AbortController().signal,
      );
      expect(result).toBe("reply: env auth");
    } finally {
      await client.stop();
      openCode.stop();
    }
  });
});

test("polling picks up a tool change on an already seen message", async () => {
  // Issue #3 の fingerprint 残件が再発しないことの固定。snapshot の fingerprint が
  // tool/type/text を含むため、id・時刻が変わらないメッセージの tool 書き換えも
  // lastTool の更新として拾える。
  const message: FakeMessage = {
    id: "tool-rewritten",
    type: "assistant",
    time: { created: 0 },
    content: [{ type: "tool", name: "read" }],
  };
  const openCode = startFakeOpenCode({
    onPrompt(context) {
      context.session.busy = true;
      context.addUser();
      message.time.created = Date.now();
      context.session.messages.push(message);
    },
  });
  const client = new ManagedOpenCode(openCode.url, "opencode", 5_000, 10);
  try {
    const session = await client.createSession({ directory: process.cwd() });
    const pending = client.executeTurn(
      session,
      process.cwd(),
      "msg_55555555555555555555555555555555",
      { message: "rewrite a polled tool" },
      new AbortController().signal,
      "turn-tool-rewrite",
    );
    pending.catch(() => {});
    await Bun.sleep(40);
    const first = await client.turnProgress("turn-tool-rewrite", session, process.cwd());
    expect(first?.lastTool).toBe("read");
    message.content = [{ type: "tool", name: "bash" }];
    await Bun.sleep(40);
    const second = await client.turnProgress("turn-tool-rewrite", session, process.cwd());
    expect(second?.lastTool).toBe("bash");
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("a hung message lookup fails the turn instead of waiting before watch", async () => {
  // Issue #3 の timeout 残件の再現形。watch 前の findMessage が応答しないと
  // pending が未登録のため turn タイムアウトも効かず、executeTurn が戻らない。
  const openCode = startFakeOpenCode({ messageDelayMs: 60_000 });
  openCode.session("session-hung-message");
  const client = new ManagedOpenCode(
    openCode.url,
    "opencode",
    5_000,
    10,
    2_000,
    2,
    2,
    1_000,
    undefined,
    50,
  );
  try {
    const outcome = await Promise.race([
      client
        .executeTurn(
          "session-hung-message",
          process.cwd(),
          "msg_66666666666666666666666666666666",
          { message: "hung lookup" },
          new AbortController().signal,
        )
        .then(
          () => "resolved" as const,
          (error: unknown) => error,
        ),
      Bun.sleep(1_000).then(() => "hung" as const),
    ]);
    expect(outcome).toMatchObject({ code: "OPENCODE_UNAVAILABLE", retryable: true });
  } finally {
    await client.stop();
    openCode.stop();
  }
});

test("a server that rejects credentials reports OPENCODE_UNAUTHORIZED", async () => {
  await withoutEnvPassword(async () => {
    const openCode = startFakeOpenCode({ password: "pw-secret" });
    const client = new ManagedOpenCode(openCode.url);
    try {
      // 401 は稼働扱いなので serve の起動は試みず、リクエストの 401 が
      // OPENCODE_UNAUTHORIZED として返る。
      await expect(client.createSession({ directory: process.cwd() })).rejects.toMatchObject({
        code: "OPENCODE_UNAUTHORIZED",
      });
    } finally {
      await client.stop();
      openCode.stop();
    }
  });
});

async function withoutEnvPassword<T>(run: () => Promise<T>): Promise<T> {
  const password = Bun.env.OPENCODE_PASSWORD;
  const serverPassword = Bun.env.OPENCODE_SERVER_PASSWORD;
  delete Bun.env.OPENCODE_PASSWORD;
  delete Bun.env.OPENCODE_SERVER_PASSWORD;
  try {
    return await run();
  } finally {
    if (password === undefined) delete Bun.env.OPENCODE_PASSWORD;
    else Bun.env.OPENCODE_PASSWORD = password;
    if (serverPassword === undefined) delete Bun.env.OPENCODE_SERVER_PASSWORD;
    else Bun.env.OPENCODE_SERVER_PASSWORD = serverPassword;
  }
}

function addPolledMessage(session: FakeSession, index: number, tool: string): void {
  session.messages.push({
    id: `${session.id}-polled-message-${index}`,
    type: "assistant",
    time: { created: Date.now() },
    content: [{ type: "tool", name: tool }],
  });
}

function emitStep(openCode: FakeOpenCode, session: FakeSession, step: number, tool?: string): void {
  const messageID = `${session.id}-message-${step}`;
  openCode.emit("session.status", { sessionID: session.id, status: { type: "busy" } });
  openCode.emit("session.step.started", {
    sessionID: session.id,
    started: Date.now(),
    assistantMessageID: messageID,
  });
  if (tool) {
    openCode.emit("session.tool.input.started", { sessionID: session.id, name: tool });
  }
}
