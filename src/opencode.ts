export interface TurnProgress {
  steps: number;
  activeSubagents: number;
  lastActivityAt: number;
  lastTool?: string;
}

interface SessionInfo {
  id: string;
  parentID?: string;
  updatedAt: number;
}

export interface OpenCodePort {
  createSession(input: { directory: string; label?: string }): Promise<string>;
  executeTurn(
    sessionId: string,
    directory: string,
    messageId: string,
    input: { message: string; agent?: string; model?: string },
    signal: AbortSignal,
  ): Promise<string>;
  abort(sessionId: string, directory: string): Promise<void>;
  close(sessionId: string, directory: string): Promise<void>;
  turnProgress?(sessionId: string, directory: string): Promise<TurnProgress | undefined>;
}

interface MessageEnvelope {
  info: {
    id: string;
    role: "user" | "assistant";
    parentID?: string;
    time?: { created?: number; completed?: number };
    finish?: string;
    error?: unknown;
  };
  parts: Array<{ type?: string; text?: string; tool?: string }>;
}

interface PendingTurn {
  readonly sessionId: string;
  readonly directory: string;
  readonly userMessageId: string;
  readonly promise: Promise<string>;
  readonly signal: AbortSignal;
  resolve(value: string): void;
  reject(error: unknown): void;
  observed: boolean;
  readonly failIfIdleWithoutResult: boolean;
  finishing: boolean;
  abortListener(): void;
  // 最後に何らかの進捗(SSEイベント受信)があった時刻。上流(OpenCode本体)が
  // リトライ上限に達した後どのイベントも送出せず無応答のまま固まることがあり
  // (例: レート制限。stream error はサーバー内部ログにのみ残り SSE には来ない)、
  // その場合でも一定時間で確実に failed へ倒すためのタイムアウト判定に使う。
  lastActivityAt: number;
  // 子孫セッションの Session.time.updated の最大値(前回ポーリング時)。
  // 変化が無ければ messages API を叩かず何もしないための比較基準。
  childUpdatedAt: number;
  // 子孫活動から集約した最新の進捗要約。turnProgress() で公開する。
  progress?: TurnProgress;
}

class OpenCodeFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

class OpenCodeClient {
  constructor(private readonly baseUrl = "http://127.0.0.1:4096") {}

  async health(): Promise<boolean> {
    try {
      // listen していないポートへの接続が RST を返さずハングする環境があるため timeout 必須。
      // ここが固まると ensureServer がサーバ起動の判断へ進めなくなる。
      const response = await fetch(new URL("/global/health", this.baseUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return false;
      return ((await response.json()) as { healthy?: unknown }).healthy === true;
    } catch {
      return false;
    }
  }

  async createSession(input: { directory: string; label?: string }): Promise<string> {
    const url = new URL("/session", this.baseUrl);
    url.searchParams.set("directory", input.directory);
    const response = await this.request(url, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input.label ? { title: input.label } : {}),
    });
    const session = (await response.json()) as { id?: unknown };
    if (typeof session.id !== "string") {
      throw new OpenCodeFailure("INVALID_OPENCODE_RESPONSE", "OpenCode returned a session without an ID.", false);
    }
    return session.id;
  }

  async promptAsync(
    sessionId: string,
    directory: string,
    messageId: string,
    input: { message: string; agent?: string; model?: string },
  ): Promise<void> {
    const body: Record<string, unknown> = {
      messageID: messageId,
      parts: [{ type: "text", text: input.message }],
    };
    if (input.agent) body.agent = input.agent;
    if (input.model) body.model = parseModel(input.model);
    await this.request(this.directoryUrl(`/session/${encodeURIComponent(sessionId)}/prompt_async`, directory), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  }

  async sessionStatus(sessionId: string, directory: string): Promise<"busy" | "idle" | "retry"> {
    const response = await this.request(this.directoryUrl("/session/status", directory));
    const statuses = await jsonObject(response, "session status");
    const entry = statuses[sessionId];
    if (entry === undefined) return "idle";
    if (!entry || typeof entry !== "object") invalidResponse("OpenCode returned an invalid session status.");
    const status = (entry as { type?: unknown }).type;
    if (status !== "busy" && status !== "idle" && status !== "retry") {
      invalidResponse("OpenCode returned an invalid session status.");
    }
    return status;
  }

  async listSessions(directory: string): Promise<SessionInfo[]> {
    const response = await this.request(this.directoryUrl("/session", directory));
    return sessionList(await response.json());
  }

  async sessionChildren(sessionId: string, directory: string): Promise<SessionInfo[]> {
    const response = await this.request(
      this.directoryUrl(`/session/${encodeURIComponent(sessionId)}/children`, directory),
    );
    return sessionList(await response.json());
  }

  async findAssistant(sessionId: string, directory: string, userMessageId: string): Promise<MessageEnvelope | null> {    const messages = await this.messages(sessionId, directory);
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.info.role === "assistant" && message.info.parentID === userMessageId) return message;
    }
    return null;
  }

  async hasUserMessage(sessionId: string, directory: string, messageId: string): Promise<boolean> {
    return (await this.messages(sessionId, directory)).some(
      (message) => message.info.role === "user" && message.info.id === messageId,
    );
  }

  async openGlobalEvents(signal: AbortSignal): Promise<Response> {
    const response = await this.request(new URL("/global/event", this.baseUrl), {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.body) {
      throw new OpenCodeFailure("INVALID_OPENCODE_RESPONSE", "OpenCode returned an empty event stream.", true);
    }
    return response;
  }

  async pendingPermissions(directory: string): Promise<Array<{ id?: string; sessionID?: string }>> {
    const response = await this.request(this.directoryUrl("/permission", directory));
    return requestList(await response.json(), "permission");
  }

  async approvePermission(requestId: string, directory: string): Promise<void> {
    await this.request(this.directoryUrl(`/permission/${encodeURIComponent(requestId)}/reply`, directory), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ reply: "once" }),
    });
  }

  async pendingQuestions(directory: string): Promise<Array<{ id?: string; sessionID?: string }>> {
    const response = await this.request(this.directoryUrl("/question", directory));
    return requestList(await response.json(), "question");
  }

  async rejectQuestion(requestId: string, directory: string): Promise<void> {
    await this.request(this.directoryUrl(`/question/${encodeURIComponent(requestId)}/reject`, directory), {
      method: "POST",
    });
  }

  async abort(sessionId: string, directory: string): Promise<void> {
    await this.request(this.directoryUrl(`/session/${encodeURIComponent(sessionId)}/abort`, directory), {
      method: "POST",
    });
  }

  async close(sessionId: string, directory: string): Promise<void> {
    await this.request(this.directoryUrl(`/session/${encodeURIComponent(sessionId)}`, directory), {
      method: "DELETE",
    });
  }

  private async request(url: URL, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (init.signal?.aborted) {
        throw new OpenCodeFailure("TURN_INTERRUPTED", "The OpenCode turn was interrupted.", false);
      }
      throw new OpenCodeFailure(
        "OPENCODE_UNAVAILABLE",
        `Cannot reach OpenCode at ${this.baseUrl}: ${messageOf(error)}`,
        true,
      );
    }

    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 4096);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new OpenCodeFailure(
        response.status === 404 ? "OPENCODE_NOT_FOUND" : `OPENCODE_HTTP_${response.status}`,
        `OpenCode ${init.method ?? "GET"} ${url.pathname} failed (${response.status})${
          detail ? `: ${detail}` : ""
        }`,
        retryable,
      );
    }
    return response;
  }

  private directoryUrl(path: string, directory: string): URL {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("directory", directory);
    return url;
  }

  async messages(sessionId: string, directory: string): Promise<MessageEnvelope[]> {
    const response = await this.request(
      this.directoryUrl(`/session/${encodeURIComponent(sessionId)}/message`, directory),
    );
    return messageList(await response.json());
  }
}

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const TIMEOUT_CHECK_INTERVAL_MS = 30 * 1000;

export class ManagedOpenCode implements OpenCodePort {
  private readonly client: OpenCodeClient;
  private readonly eventAbort = new AbortController();
  private readonly pending = new Map<string, PendingTurn>();
  private child?: ReturnType<typeof Bun.spawn>;
  private starting?: Promise<void>;
  private eventsReady?: Promise<void>;
  private reconnecting?: Promise<void>;
  private stopped = false;
  private readonly timeoutTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly baseUrl = "http://127.0.0.1:4096",
    private readonly executable = "opencode",
    private readonly turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    // 本番では変更不要。短い turnTimeoutMs でのテストのためだけに存在する。
    timeoutCheckIntervalMs = TIMEOUT_CHECK_INTERVAL_MS,
  ) {
    this.client = new OpenCodeClient(baseUrl);
    this.timeoutTimer = setInterval(() => {
      void this.checkTimeouts().catch(() => {});
    }, timeoutCheckIntervalMs);
    this.timeoutTimer.unref?.();
  }

  // 進捗があったことを記録する。observed フラグを立てる全箇所はここを通すこと
  // (lastActivityAt を更新し忘れるとタイムアウト検出が効かなくなる)。
  private markObserved(pending: PendingTurn): void {
    pending.observed = true;
    pending.lastActivityAt = Date.now();
  }

  // 進捗イベントが turnTimeoutMs より前から無い pending turn を強制的に失敗させる。
  // 上流(OpenCode本体)がリトライ失敗後に何も通知してこない場合の最後の砦。
  // 子セッション(サブエージェント)の活動も進捗とみなすため、先に子孫を
  // ポーリングして変化があれば lastActivityAt を更新してから判定する。
  private async checkTimeouts(): Promise<void> {
    for (const pending of [...this.pending.values()]) {
      try {
        await this.pollSubagentActivity(pending);
      } catch {
        // 子孫の取得失敗はタイムアウト判定に影響させない(親の判定を優先)。
      }
      if (this.pending.get(pending.sessionId) !== pending) continue;
      const now = Date.now();
      if (now - pending.lastActivityAt < this.turnTimeoutMs) continue;
      this.rejectPending(
        pending,
        new OpenCodeFailure(
          "OPENCODE_TURN_TIMEOUT",
          `OpenCode session ${pending.sessionId} produced no progress for ${Math.round(this.turnTimeoutMs / 1000)}s ` +
            "(possible provider rate limit or upstream failure that OpenCode did not report over SSE).",
          true,
        ),
      );
    }
  }

  async createSession(input: { directory: string; label?: string }): Promise<string> {
    await this.ensureRunning();
    return this.client.createSession(input);
  }

  // turn の進捗要約(steps / active_subagents / last_activity_at / last_tool)を返す。
  // runtime の status から参照される。pending が無ければ undefined。
  async turnProgress(sessionId: string, directory: string): Promise<TurnProgress | undefined> {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.directory !== directory) return undefined;
    try {
      const progress = await this.pollSubagentActivity(pending);
      return progress ?? pending.progress;
    } catch {
      return pending.progress;
    }
  }

  // 子孫セッションの活動を集約する。Session.time.updated の最大値が前回と
  // 変わらなければ messages API を叩かずキャッシュを返す(API節約)。
  // 変化があったときだけ messages を取得して steps/last_tool を集計し、
  // markObserved で lastActivityAt を更新する。
  private async pollSubagentActivity(pending: PendingTurn): Promise<TurnProgress | undefined> {
    const descendants = await this.descendantSessions(pending.sessionId, pending.directory);
    if (descendants.length === 0) return pending.progress;
    const maxUpdated = descendants.reduce((max, session) => Math.max(max, session.updatedAt), 0);
    if (maxUpdated <= pending.childUpdatedAt) return pending.progress;
    const now = Date.now();
    const activeSubagents = descendants.filter(
      (session) => now - session.updatedAt < this.turnTimeoutMs,
    ).length;
    const { steps, lastTool, latestAt } = await this.summarizeMessages(
      [pending.sessionId, ...descendants.map((session) => session.id)],
      pending.directory,
    );
    const progress: TurnProgress = {
      steps,
      activeSubagents,
      lastActivityAt: Math.max(maxUpdated, latestAt, pending.progress?.lastActivityAt ?? 0),
      ...(lastTool === undefined ? {} : { lastTool }),
    };
    pending.childUpdatedAt = maxUpdated;
    pending.progress = progress;
    this.markObserved(pending);
    return progress;
  }

  // GET /session 一覧から親子マップを作って子孫をたどる(呼び出し1回)。
  // 一覧が使えなければ children API の再帰にフォールバックする。
  private async descendantSessions(sessionId: string, directory: string): Promise<SessionInfo[]> {
    try {
      const sessions = await this.client.listSessions(directory);
      const byParent = new Map<string, SessionInfo[]>();
      for (const session of sessions) {
        if (!session.parentID) continue;
        const siblings = byParent.get(session.parentID) ?? [];
        siblings.push(session);
        byParent.set(session.parentID, siblings);
      }
      const descendants: SessionInfo[] = [];
      const queue = [...(byParent.get(sessionId) ?? [])];
      const seen = new Set<string>([sessionId]);
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (seen.has(next.id)) continue;
        seen.add(next.id);
        descendants.push(next);
        queue.push(...(byParent.get(next.id) ?? []));
      }
      return descendants;
    } catch {
      return this.descendantSessionsViaChildren(sessionId, directory, 0);
    }
  }

  private async descendantSessionsViaChildren(
    sessionId: string,
    directory: string,
    depth: number,
  ): Promise<SessionInfo[]> {
    if (depth > 10) return [];
    let children: SessionInfo[];
    try {
      children = await this.client.sessionChildren(sessionId, directory);
    } catch {
      return [];
    }
    const descendants = [...children];
    for (const child of children) {
      descendants.push(...(await this.descendantSessionsViaChildren(child.id, directory, depth + 1)));
    }
    return descendants;
  }

  private async summarizeMessages(
    sessionIds: string[],
    directory: string,
  ): Promise<{ steps: number; lastTool?: string; latestAt: number }> {
    let steps = 0;
    let lastTool: string | undefined;
    let latestAt = 0;
    await Promise.all(
      sessionIds.map(async (id) => {
        let messages: MessageEnvelope[];
        try {
          messages = await this.client.messages(id, directory);
        } catch {
          return;
        }
        for (const message of messages) {
          if (message.info.role !== "assistant") continue;
          steps++;
          const at = message.info.time?.completed ?? message.info.time?.created ?? 0;
          if (typeof at === "number") latestAt = Math.max(latestAt, at);
          for (const part of message.parts) {
            if (typeof part.tool === "string" && part.tool) lastTool = part.tool;
          }
        }
      }),
    );
    return { steps, ...(lastTool === undefined ? {} : { lastTool }), latestAt };
  }

  async executeTurn(
    sessionId: string,
    directory: string,
    messageId: string,
    input: { message: string; agent?: string; model?: string },
    signal: AbortSignal,
  ): Promise<string> {
    await this.ensureRunning();
    const existing = await this.client.findAssistant(sessionId, directory, messageId);
    if (existing && isTerminalMessage(existing.info)) return resultText(existing);
    const persisted = Boolean(existing) || (await this.client.hasUserMessage(sessionId, directory, messageId));
    const pending = this.watch(sessionId, directory, messageId, signal, persisted);
    if (existing) this.markObserved(pending);
    try {
      if (!persisted) await this.client.promptAsync(sessionId, directory, messageId, input);
      await this.refresh(pending);
      return await pending.promise;
    } catch (error) {
      this.rejectPending(pending, error);
      throw error;
    }
  }

  async abort(sessionId: string, directory: string): Promise<void> {
    await this.ensureServer();
    return this.client.abort(sessionId, directory);
  }

  async close(sessionId: string, directory: string): Promise<void> {
    await this.ensureServer();
    return this.client.close(sessionId, directory);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timeoutTimer);
    this.eventAbort.abort();
    for (const pending of this.pending.values()) {
      pending.reject(new OpenCodeFailure("OPENCODE_STOPPED", "The OpenCode host stopped.", true));
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    this.pending.clear();

    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await child.exited;
  }

  private async ensureRunning(): Promise<void> {
    await this.ensureServer();
    await this.ensureEvents();
  }

  private ensureServer(): Promise<void> {
    this.starting ??= this.startServer().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startServer(): Promise<void> {
    if (await this.client.health()) return;

    const url = new URL(this.baseUrl);
    if (url.protocol !== "http:" || !isLocalHost(url.hostname)) {
      throw new OpenCodeFailure(
        "OPENCODE_UNAVAILABLE",
        `OpenCode at ${this.baseUrl} is unavailable and cannot be started locally.`,
        true,
      );
    }

    const port = url.port || "80";
    this.child = Bun.spawn({
      cmd: [this.executable, "serve", "--hostname", url.hostname, "--port", port],
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });

    for (let attempt = 0; attempt < 150; attempt++) {
      if (await this.client.health()) return;
      if (this.child.exitCode !== null) break;
      await Bun.sleep(100);
    }

    const exit = this.child.exitCode;
    this.child = undefined;
    throw new OpenCodeFailure(
      "OPENCODE_START_FAILED",
      `OpenCode did not become healthy at ${this.baseUrl}${
        exit === null ? "." : ` (process exited with code ${exit}).`
      }`,
      true,
    );
  }

  private ensureEvents(): Promise<void> {
    this.eventsReady ??= this.connectEvents().catch((error) => {
      this.eventsReady = undefined;
      throw error;
    });
    return this.eventsReady;
  }

  private async connectEvents(): Promise<void> {
    const response = await this.client.openGlobalEvents(this.eventAbort.signal);
    void this.consumeEvents(response)
      .catch(() => {
        // A broken or aborted stream is recovered by the reconnect path below.
      })
      .finally(() => {
        this.eventsReady = undefined;
        if (!this.stopped) this.scheduleReconnect();
      });
    await this.resolvePendingPrompts();
    for (const pending of this.pending.values()) void this.refresh(pending);
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = (async () => {
      while (!this.stopped) {
        try {
          await this.ensureServer();
          await this.ensureEvents();
          return;
        } catch {
          await Bun.sleep(250);
        }
      }
    })().finally(() => {
      this.reconnecting = undefined;
    });
  }

  private async consumeEvents(response: Response): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data = "";
    try {
      while (!this.stopped) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let start = 0;
        while (true) {
          const newline = buffer.indexOf("\n", start);
          if (newline < 0) break;
          const line = buffer.slice(start, newline);
          start = newline + 1;
          if (line === "" || line === "\r") {
            if (data) this.handleEvent(data);
            data = "";
          } else if (line.startsWith("data:")) {
            const value = line.charCodeAt(5) === 32 ? line.slice(6) : line.slice(5);
            data = data ? `${data}\n${value}` : value;
          }
        }
        if (start > 0) buffer = buffer.slice(start);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleEvent(data: string): void {
    if (!isRelevantEvent(data)) return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;
    const wrapper = value as { payload?: unknown; type?: unknown; properties?: unknown };
    const payload =
      wrapper.payload && typeof wrapper.payload === "object"
        ? (wrapper.payload as { type?: unknown; properties?: unknown })
        : wrapper;
    if (typeof payload.type !== "string" || !payload.properties || typeof payload.properties !== "object") return;
    const properties = payload.properties as Record<string, unknown>;

    switch (payload.type) {
      case "permission.asked":
      case "permission.v2.asked":
        if (
          typeof properties.id === "string" &&
          typeof properties.sessionID === "string" &&
          this.pending.has(properties.sessionID)
        ) {
          const pending = this.pending.get(properties.sessionID);
          if (!pending) break;
          void this.client.approvePermission(properties.id, pending.directory).catch((error) => {
            this.failSession(properties.sessionID, error);
          });
        }
        break;
      case "question.asked":
      case "question.v2.asked":
        if (
          typeof properties.id === "string" &&
          typeof properties.sessionID === "string" &&
          this.pending.has(properties.sessionID)
        ) {
          const pending = this.pending.get(properties.sessionID);
          if (!pending) break;
          void this.client.rejectQuestion(properties.id, pending.directory).catch((error) => {
            this.failSession(properties.sessionID, error);
          });
        }
        break;
      case "message.updated": {
        const info = properties.info;
        if (!info || typeof info !== "object") break;
        const message = info as {
          id?: unknown;
          sessionID?: unknown;
          role?: unknown;
          parentID?: unknown;
          error?: unknown;
          finish?: unknown;
          time?: { completed?: unknown };
        };
        const sessionId =
          typeof message.sessionID === "string"
            ? message.sessionID
            : typeof properties.sessionID === "string"
              ? properties.sessionID
              : undefined;
        const pending = sessionId ? this.pending.get(sessionId) : undefined;
        if (
          sessionId !== undefined &&
          pending &&
          message.role === "assistant" &&
          message.parentID === pending.userMessageId &&
          typeof message.id === "string"
        ) {
          this.markObserved(pending);
          if (message.error) this.rejectPending(pending, errorFromAssistant(message.error));
          else if (isTerminalMessage(message)) void this.finish(sessionId);
        }
        break;
      }
      case "session.idle":
        if (typeof properties.sessionID === "string") {
          const pending = this.pending.get(properties.sessionID);
          if (pending) void this.refresh(pending);
        }
        break;
      case "session.status": {
        const status = properties.status;
        if (typeof properties.sessionID === "string" && status && typeof status === "object") {
          const pending = this.pending.get(properties.sessionID);
          if (!pending) break;
          const type = (status as { type?: unknown }).type;
          if (type === "busy" || type === "retry") this.markObserved(pending);
          else if (type === "idle") void this.refresh(pending);
        }
        break;
      }
      case "session.error":
        this.failSession(properties.sessionID, errorFromAssistant(properties.error));
        break;
    }
  }

  private watch(
    sessionId: string,
    directory: string,
    userMessageId: string,
    signal: AbortSignal,
    failIfIdleWithoutResult: boolean,
  ): PendingTurn {
    if (this.pending.has(sessionId)) {
      throw new OpenCodeFailure(
        "SESSION_BUSY",
        `OpenCode session ${sessionId} already has an active turn.`,
        false,
      );
    }
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const pending: PendingTurn = {
      sessionId,
      directory,
      userMessageId,
      promise,
      signal,
      resolve,
      reject,
      observed: false,
      failIfIdleWithoutResult,
      finishing: false,
      lastActivityAt: Date.now(),
      childUpdatedAt: 0,
      abortListener: () => {
        this.rejectPending(
          pending,
          new OpenCodeFailure("TURN_INTERRUPTED", "The OpenCode turn was interrupted.", false),
        );
      },
    };
    this.pending.set(sessionId, pending);
    signal.addEventListener("abort", pending.abortListener, { once: true });
    if (signal.aborted) pending.abortListener();
    return pending;
  }

  private async refresh(pending: PendingTurn): Promise<void> {
    if (this.pending.get(pending.sessionId) !== pending || pending.finishing) return;
    const assistant = await this.client.findAssistant(
      pending.sessionId,
      pending.directory,
      pending.userMessageId,
    );
    if (this.pending.get(pending.sessionId) !== pending) return;
    if (assistant) {
      this.markObserved(pending);
      if (assistant.info.error) {
        this.rejectPending(pending, errorFromAssistant(assistant.info.error));
        return;
      }
      if (isTerminalMessage(assistant.info)) {
        this.resolvePending(pending, resultText(assistant));
        return;
      }
    }
    const status = await this.client.sessionStatus(pending.sessionId, pending.directory);
    if (status === "busy" || status === "retry") {
      this.markObserved(pending);
    } else if (pending.observed || pending.failIfIdleWithoutResult) {
      await this.finish(pending.sessionId);
    }
  }

  private async finish(sessionId: string): Promise<void> {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.finishing) return;
    pending.finishing = true;
    try {
      const message = await this.client.findAssistant(sessionId, pending.directory, pending.userMessageId);
      if (!message || !isTerminalMessage(message.info)) {
        if (!pending.failIfIdleWithoutResult) return;
        throw new OpenCodeFailure(
          "MISSING_TURN_RESULT",
          `OpenCode session ${sessionId} became idle without an assistant result.`,
          true,
        );
      }
      this.resolvePending(pending, resultText(message));
    } catch (error) {
      this.rejectPending(pending, error);
    } finally {
      pending.finishing = false;
    }
  }

  private resolvePending(pending: PendingTurn, text: string): void {
    if (this.pending.get(pending.sessionId) !== pending) return;
    this.pending.delete(pending.sessionId);
    pending.signal.removeEventListener("abort", pending.abortListener);
    pending.resolve(text);
  }

  private rejectPending(pending: PendingTurn, error: unknown): void {
    if (this.pending.get(pending.sessionId) !== pending) return;
    this.pending.delete(pending.sessionId);
    pending.signal.removeEventListener("abort", pending.abortListener);
    pending.reject(error);
  }

  private failSession(sessionId: unknown, error: unknown): void {
    if (typeof sessionId !== "string") return;
    const pending = this.pending.get(sessionId);
    if (pending) this.rejectPending(pending, error);
  }

  private async resolvePendingPrompts(): Promise<void> {
    const directories = new Set<string>();
    for (const pending of this.pending.values()) directories.add(pending.directory);
    await Promise.all(
      [...directories].map(async (directory) => {
        const [permissions, questions] = await Promise.all([
          this.client.pendingPermissions(directory),
          this.client.pendingQuestions(directory),
        ]);
        const replies: Promise<void>[] = [];
        for (const request of permissions) {
          if (typeof request.id !== "string" || typeof request.sessionID !== "string") continue;
          if (this.pending.get(request.sessionID)?.directory !== directory) continue;
          replies.push(this.client.approvePermission(request.id, directory));
        }
        for (const request of questions) {
          if (typeof request.id !== "string" || typeof request.sessionID !== "string") continue;
          if (this.pending.get(request.sessionID)?.directory !== directory) continue;
          replies.push(this.client.rejectQuestion(request.id, directory));
        }
        await Promise.allSettled(replies);
      }),
    );
  }
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

function parseModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new OpenCodeFailure(
      "INVALID_MODEL",
      `Model must use provider/model format; received ${JSON.stringify(model)}.`,
      false,
    );
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function resultText(message: MessageEnvelope): string {
  if (message.info.error) throw errorFromAssistant(message.info.error);
  let result = "";
  for (const part of message.parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    result = result ? `${result}\n${part.text}` : part.text;
  }
  return result;
}

function isTerminalMessage(info: {
  error?: unknown;
  finish?: unknown;
  time?: { completed?: unknown };
}): boolean {
  if (info.error) return true;
  if (info.finish === "tool-calls") return false;
  return Boolean(info.finish || info.time?.completed);
}

function errorFromAssistant(error: unknown): OpenCodeFailure {
  if (error instanceof OpenCodeFailure) return error;
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; message?: unknown; data?: { message?: unknown; isRetryable?: unknown } };
    const message =
      typeof value.data?.message === "string"
        ? value.data.message
        : typeof value.message === "string"
          ? value.message
          : JSON.stringify(error).slice(0, 4096);
    return new OpenCodeFailure(
      typeof value.name === "string" ? `OPENCODE_${value.name.toUpperCase()}` : "OPENCODE_TURN_FAILED",
      message,
      value.data?.isRetryable === true,
    );
  }
  return new OpenCodeFailure("OPENCODE_TURN_FAILED", String(error ?? "OpenCode turn failed."), false);
}

function isRelevantEvent(data: string): boolean {
  return (
    data.includes("permission.") ||
    data.includes("question.") ||
    data.includes("message.updated") ||
    data.includes("session.idle") ||
    data.includes("session.status") ||
    data.includes("session.error")
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function jsonObject(response: Response, name: string): Promise<Record<string, unknown>> {
  const value = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidResponse(`OpenCode returned an invalid ${name} response.`);
  }
  return value as Record<string, unknown>;
}

function requestList(value: unknown, name: string): Array<{ id?: string; sessionID?: string }> {
  if (!Array.isArray(value)) invalidResponse(`OpenCode returned an invalid ${name} list.`);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") invalidResponse(`OpenCode returned an invalid ${name} request.`);
    const request = entry as { id?: unknown; sessionID?: unknown };
    if (request.id !== undefined && typeof request.id !== "string") {
      invalidResponse(`OpenCode returned an invalid ${name} request ID.`);
    }
    if (request.sessionID !== undefined && typeof request.sessionID !== "string") {
      invalidResponse(`OpenCode returned an invalid ${name} session ID.`);
    }
    return {
      id: typeof request.id === "string" ? request.id : undefined,
      sessionID: typeof request.sessionID === "string" ? request.sessionID : undefined,
    };
  });
}

function messageList(value: unknown): MessageEnvelope[] {
  if (!Array.isArray(value)) invalidResponse("OpenCode returned an invalid message list.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") invalidResponse("OpenCode returned an invalid message.");
    const message = entry as { info?: unknown; parts?: unknown };
    if (!message.info || typeof message.info !== "object" || !Array.isArray(message.parts)) {
      invalidResponse("OpenCode returned an invalid message envelope.");
    }
    const info = message.info as Record<string, unknown>;
    if (typeof info.id !== "string" || (info.role !== "user" && info.role !== "assistant")) {
      invalidResponse("OpenCode returned invalid message information.");
    }
    if (info.parentID !== undefined && typeof info.parentID !== "string") {
      invalidResponse("OpenCode returned an invalid parent message ID.");
    }
    const parts = message.parts.map((part) => {
      if (!part || typeof part !== "object") invalidResponse("OpenCode returned an invalid message part.");
      const value = part as { type?: unknown; text?: unknown; tool?: unknown };
      if (value.type !== undefined && typeof value.type !== "string") {
        invalidResponse("OpenCode returned an invalid message part type.");
      }
      if (value.text !== undefined && typeof value.text !== "string") {
        invalidResponse("OpenCode returned invalid message text.");
      }
      if (value.tool !== undefined && typeof value.tool !== "string") {
        invalidResponse("OpenCode returned an invalid message part tool.");
      }
      return {
        type: typeof value.type === "string" ? value.type : undefined,
        text: typeof value.text === "string" ? value.text : undefined,
        tool: typeof value.tool === "string" ? value.tool : undefined,
      };
    });
    return { info: info as unknown as MessageEnvelope["info"], parts };
  });
}

function sessionList(value: unknown): SessionInfo[] {
  if (!Array.isArray(value)) invalidResponse("OpenCode returned an invalid session list.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") invalidResponse("OpenCode returned an invalid session.");
    const session = entry as { id?: unknown; parentID?: unknown; time?: unknown };
    if (typeof session.id !== "string") invalidResponse("OpenCode returned an invalid session ID.");
    if (session.parentID !== undefined && typeof session.parentID !== "string") {
      invalidResponse("OpenCode returned an invalid parent session ID.");
    }
    let updatedAt = 0;
    if (session.time && typeof session.time === "object") {
      const time = session.time as { updated?: unknown; created?: unknown };
      if (typeof time.updated === "number") updatedAt = time.updated;
      else if (typeof time.created === "number") updatedAt = time.created;
    }
    return {
      id: session.id,
      ...(typeof session.parentID === "string" ? { parentID: session.parentID } : {}),
      updatedAt,
    };
  });
}

function invalidResponse(message: string): never {
  throw new OpenCodeFailure("INVALID_OPENCODE_RESPONSE", message, false);
}
