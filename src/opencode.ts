export interface TurnProgress {
  steps: number;
  activeSubagents: number;
  lastActivityAt: number;
  lastTool?: string;
}

interface SessionInfo {
  id: string;
  parentID?: string;
  time?: { created?: number };
}

interface MessagePart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  time?: { start?: number; end?: number };
}

interface MessageEnvelope {
  info: {
    id: string;
    sessionID?: string;
    role: "user" | "assistant";
    parentID?: string;
    time?: { created?: number; completed?: number };
    finish?: string;
    error?: unknown;
  };
  parts: MessagePart[];
}

interface MessageSnapshot {
  fingerprint: string;
  messageID?: string;
  createdAt?: number;
  tool?: string;
}

export interface OpenCodePort {
  createSession(input: { directory: string; label?: string }): Promise<string>;
  executeTurn(
    sessionId: string,
    directory: string,
    messageId: string,
    input: { message: string; agent?: string; model?: string },
    signal: AbortSignal,
    turnId?: string,
  ): Promise<string>;
  abort(sessionId: string, directory: string): Promise<void>;
  close(sessionId: string, directory: string): Promise<void>;
  turnProgress?(turnId: string, sessionId: string, directory: string): Promise<TurnProgress | undefined>;
}

interface PendingTurn {
  readonly turnId: string;
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
  readonly startedAt: number;
  lastActivityAt: number;
  progress?: TurnProgress;
  readonly stepKeys: Set<string>;
  readonly activeSessions: Set<string>;
  readonly descendantIds: Set<string>;
  readonly observedMessageIds: Set<string>;
  readonly messageSnapshots: Map<string, MessageSnapshot>;
  readonly lastActivityBySession: Map<string, number>;
  readonly pollPrioritySessionIds: Set<string>;
  pollDescendantCursor: number;
  pollMessageCursor: number;
  polling?: Promise<void>;
  lastTool?: string;
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

  async sessionChildren(sessionId: string, directory: string, timeoutMs: number): Promise<SessionInfo[]> {
    const response = await this.request(
      this.directoryUrl(`/session/${encodeURIComponent(sessionId)}/children`, directory),
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    return sessionList(await response.json());
  }

  async latestMessages(
    sessionId: string,
    directory: string,
    limit: number,
    timeoutMs: number,
  ): Promise<MessageEnvelope[]> {
    const url = this.directoryUrl(`/session/${encodeURIComponent(sessionId)}/message`, directory);
    url.searchParams.set("limit", String(limit));
    const response = await this.request(url, { signal: AbortSignal.timeout(timeoutMs) });
    return messageList(await response.json());
  }

  async findAssistant(sessionId: string, directory: string, userMessageId: string): Promise<MessageEnvelope | null> {
    const messages = await this.messages(sessionId, directory);
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
const DEFAULT_POLL_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_DESCENDANT_LIMIT = 20;
const DEFAULT_POLL_MESSAGE_LIMIT = 20;
const DEFAULT_ACTIVE_SESSION_TTL_MS = 60_000;
const POLL_MESSAGE_LIMIT = 1;

export class ManagedOpenCode implements OpenCodePort {
  private readonly client: OpenCodeClient;
  private readonly eventAbort = new AbortController();
  private readonly pending = new Map<string, PendingTurn>();
  private readonly pendingByTurn = new Map<string, PendingTurn>();
  private readonly sessionParents = new Map<string, string>();
  private readonly sessionTurns = new Map<string, string>();
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
    timeoutCheckIntervalMs = TIMEOUT_CHECK_INTERVAL_MS,
    private readonly pollRequestTimeoutMs = DEFAULT_POLL_REQUEST_TIMEOUT_MS,
    private readonly pollDescendantLimit = DEFAULT_POLL_DESCENDANT_LIMIT,
    private readonly pollMessageLimit = DEFAULT_POLL_MESSAGE_LIMIT,
    private readonly activeSessionTtlMs = DEFAULT_ACTIVE_SESSION_TTL_MS,
  ) {
    this.client = new OpenCodeClient(baseUrl);
    this.timeoutTimer = setInterval(() => {
      void this.checkTimeouts();
    }, timeoutCheckIntervalMs);
    this.timeoutTimer.unref?.();
  }

  private markObserved(pending: PendingTurn, activityAt = Date.now()): void {
    pending.observed = true;
    pending.lastActivityAt = Math.max(pending.lastActivityAt, activityAt);
    if (pending.progress) pending.progress = { ...pending.progress, lastActivityAt: pending.lastActivityAt };
  }

  private checkTimeouts(): void {
    for (const pending of [...this.pending.values()]) {
      if (this.pending.get(pending.sessionId) !== pending) continue;
      this.pruneInactiveDescendants(pending);
      this.startPolling(pending);
      if (Date.now() - pending.lastActivityAt < this.turnTimeoutMs) continue;
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

  async turnProgress(turnId: string, sessionId: string, directory: string): Promise<TurnProgress | undefined> {
    const pending = this.pendingByTurn.get(turnId) ?? (turnId === sessionId ? this.pending.get(sessionId) : undefined);
    if (!pending || pending.sessionId !== sessionId || pending.directory !== directory) return undefined;
    this.pruneInactiveDescendants(pending);
    return pending.progress;
  }

  private startPolling(pending: PendingTurn): void {
    if (pending.polling || this.pending.get(pending.sessionId) !== pending) return;
    const polling = this.pollPending(pending);
    pending.polling = polling;
    const clear = () => {
      if (pending.polling === polling) pending.polling = undefined;
    };
    void polling.then(clear, clear);
  }

  private async pollPending(pending: PendingTurn): Promise<void> {
    const priority = new Set(pending.pollPrioritySessionIds);
    pending.pollPrioritySessionIds.clear();
    try {
      await this.supplementDescendants(pending, priority);
      if (this.pending.get(pending.sessionId) !== pending) return;
      const sessionIds = this.pollCandidates(pending, this.pollMessageLimit, "message", priority);
      const selectedMessages = new Set(sessionIds);
      for (const sessionId of priority) {
        if (!selectedMessages.has(sessionId)) pending.pollPrioritySessionIds.add(sessionId);
      }
      await Promise.all(sessionIds.map((sessionId) => this.pollSessionMessages(pending, sessionId)));
      this.pruneInactiveDescendants(pending);
    } catch {
      return;
    }
  }

  private async supplementDescendants(pending: PendingTurn, priority: ReadonlySet<string>): Promise<void> {
    const parentIds = this.pollCandidates(pending, this.pollDescendantLimit, "descendant", priority);
    for (const parentId of parentIds) {
      let children: SessionInfo[];
      try {
        children = await this.client.sessionChildren(parentId, pending.directory, this.pollRequestTimeoutMs);
      } catch {
        continue;
      }
      if (this.pending.get(pending.sessionId) !== pending) return;
      for (const child of children) {
        if (child.id === pending.sessionId) continue;
        if (isBeforeTurn(numberValue(child.time?.created), pending.startedAt)) continue;
        const owner = this.sessionTurns.get(child.id);
        if (owner && owner !== pending.turnId) continue;
        this.sessionParents.set(child.id, parentId);
        this.sessionTurns.set(child.id, pending.turnId);
        pending.descendantIds.add(child.id);
      }
    }
  }

  private pollCandidates(
    pending: PendingTurn,
    limit: number,
    kind: "descendant" | "message",
    priority: ReadonlySet<string>,
  ): string[] {
    const candidates = [pending.sessionId, ...pending.descendantIds];
    const maximum = Math.max(0, Math.floor(limit));
    if (maximum === 0 || candidates.length === 0) return [];
    const cursor = kind === "descendant" ? pending.pollDescendantCursor : pending.pollMessageCursor;
    const ordered = candidates
      .map((sessionId, index) => ({
        sessionId,
        order: (index - cursor + candidates.length) % candidates.length,
        prioritized: priority.has(sessionId),
      }))
      .sort((left, right) => Number(right.prioritized) - Number(left.prioritized) || left.order - right.order);
    const selected = ordered.slice(0, Math.min(maximum, candidates.length)).map(({ sessionId }) => sessionId);
    const nextCursor = (cursor + Math.min(maximum, candidates.length)) % candidates.length;
    if (kind === "descendant") pending.pollDescendantCursor = nextCursor;
    else pending.pollMessageCursor = nextCursor;
    return selected;
  }

  private async pollSessionMessages(pending: PendingTurn, sessionId: string): Promise<void> {
    let messages: MessageEnvelope[];
    try {
      messages = await this.client.latestMessages(
        sessionId,
        pending.directory,
        POLL_MESSAGE_LIMIT,
        this.pollRequestTimeoutMs,
      );
    } catch {
      return;
    }
    if (this.pending.get(pending.sessionId) !== pending) return;
    const snapshot = snapshotMessages(messages);
    const previous = pending.messageSnapshots.get(sessionId);
    pending.messageSnapshots.set(sessionId, snapshot);
    if (!snapshot.messageID) return;
    if (!previous) {
      const messageKey = messageStepKey(sessionId, snapshot.messageID);
      if (
        !pending.observedMessageIds.has(messageKey) &&
        (snapshot.createdAt === undefined || snapshot.createdAt >= pending.startedAt)
      ) {
        this.observeActivity(
          pending,
          sessionId,
          Date.now(),
          messageKey,
          snapshot.tool,
        );
      }
      return;
    }
    if (previous.fingerprint === snapshot.fingerprint) return;
    const stepKey = previous.messageID === snapshot.messageID ? undefined : messageStepKey(sessionId, snapshot.messageID);
    this.observeActivity(pending, sessionId, Date.now(), stepKey, snapshot.tool);
  }

  async executeTurn(
    sessionId: string,
    directory: string,
    messageId: string,
    input: { message: string; agent?: string; model?: string },
    signal: AbortSignal,
    turnId = sessionId,
  ): Promise<string> {
    await this.ensureRunning();
    const existing = await this.client.findAssistant(sessionId, directory, messageId);
    if (existing && isTerminalMessage(existing.info)) return resultText(existing);
    const persisted = Boolean(existing) || (await this.client.hasUserMessage(sessionId, directory, messageId));
    const pending = this.watch(turnId, sessionId, directory, messageId, signal, persisted);
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
    for (const pending of [...this.pending.values()]) {
      this.rejectPending(pending, new OpenCodeFailure("OPENCODE_STOPPED", "The OpenCode host stopped.", true));
    }
    this.pending.clear();
    this.pendingByTurn.clear();
    this.sessionParents.clear();
    this.sessionTurns.clear();

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
    for (const pending of this.pending.values()) {
      this.startPolling(pending);
      void this.refresh(pending);
    }
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
      case "session.created":
        this.handleSessionCreated(properties);
        break;
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
      case "message.updated":
        this.handleMessageUpdated(properties);
        break;
      case "message.part.updated":
        this.handlePartUpdated(properties);
        break;
      case "session.idle": {
        if (typeof properties.sessionID !== "string") break;
        const pending = this.pendingForSession(properties.sessionID);
        if (!pending) break;
        if (properties.sessionID === pending.sessionId) void this.refresh(pending);
        else this.deactivate(pending, properties.sessionID);
        break;
      }
      case "session.status": {
        if (typeof properties.sessionID !== "string" || !properties.status || typeof properties.status !== "object") {
          break;
        }
        const pending = this.pendingForSession(properties.sessionID);
        if (!pending) break;
        const type = (properties.status as { type?: unknown }).type;
        if (type === "busy" || type === "retry") {
          this.observeActivity(pending, properties.sessionID, Date.now());
        } else if (type === "idle") {
          if (properties.sessionID === pending.sessionId) void this.refresh(pending);
          else this.deactivate(pending, properties.sessionID);
        }
        break;
      }
      case "session.error":
        this.failSession(properties.sessionID, errorFromAssistant(properties.error));
        break;
    }
  }

  private handleSessionCreated(properties: Record<string, unknown>): void {
    const info = properties.info;
    if (!info || typeof info !== "object") return;
    const session = info as { id?: unknown; parentID?: unknown; time?: { created?: unknown } };
    if (typeof session.id !== "string") return;
    const parentID = typeof session.parentID === "string" ? session.parentID : undefined;
    const inheritedTurn = parentID ? this.sessionTurns.get(parentID) : undefined;
    const turnId = inheritedTurn ?? this.pending.get(this.rootSession(session.id))?.turnId;
    if (!turnId) return;
    const pending = this.pendingByTurn.get(turnId);
    if (!pending) return;
    if (isBeforeTurn(numberValue(session.time?.created), pending.startedAt)) return;
    if (parentID) this.sessionParents.set(session.id, parentID);
    this.sessionTurns.set(session.id, turnId);
    if (session.id !== pending.sessionId) pending.descendantIds.add(session.id);
    this.observeActivity(pending, session.id, Date.now());
  }

  private handleMessageUpdated(properties: Record<string, unknown>): void {
    const info = properties.info;
    if (!info || typeof info !== "object") return;
    const message = info as {
      id?: unknown;
      sessionID?: unknown;
      role?: unknown;
      parentID?: unknown;
      error?: unknown;
      finish?: unknown;
      time?: { created?: unknown; completed?: unknown };
    };
    const sessionId =
      typeof message.sessionID === "string"
        ? message.sessionID
        : typeof properties.sessionID === "string"
          ? properties.sessionID
          : undefined;
    if (!sessionId) return;
    const pending = this.pendingForSession(sessionId);
    if (!pending) return;
    const at = numberValue(message.time?.completed ?? message.time?.created) ?? Date.now();
    if (typeof message.id === "string") pending.observedMessageIds.add(messageStepKey(sessionId, message.id));
    const stepKey =
      message.role === "assistant" && typeof message.id === "string" ? messageStepKey(sessionId, message.id) : undefined;
    this.observeActivity(pending, sessionId, at, stepKey);
    if (
      sessionId === pending.sessionId &&
      message.role === "assistant" &&
      message.parentID === pending.userMessageId &&
      typeof message.id === "string"
    ) {
      if (message.error) this.rejectPending(pending, errorFromAssistant(message.error));
      else if (isTerminalMessage(message)) void this.finish(sessionId);
    }
  }

  private handlePartUpdated(properties: Record<string, unknown>): void {
    const part = properties.part;
    if (!part || typeof part !== "object") return;
    const value = part as {
      id?: unknown;
      messageID?: unknown;
      sessionID?: unknown;
      type?: unknown;
      tool?: unknown;
    };
    const sessionId =
      typeof value.sessionID === "string"
        ? value.sessionID
        : typeof properties.sessionID === "string"
          ? properties.sessionID
          : undefined;
    if (!sessionId) return;
    const pending = this.pendingForSession(sessionId);
    if (!pending) return;
    const messageID = typeof value.messageID === "string" ? value.messageID : undefined;
    if (messageID) pending.observedMessageIds.add(messageStepKey(sessionId, messageID));
    const stepKey =
      (value.type === "step-start" || value.type === "step-finish") && messageID
        ? messageStepKey(sessionId, messageID)
        : undefined;
    const tool = typeof value.tool === "string" && value.tool ? value.tool : undefined;
    this.observeActivity(pending, sessionId, numberValue(properties.time) ?? Date.now(), stepKey, tool);
  }

  private pendingForSession(sessionId: string): PendingTurn | undefined {
    const turnId = this.sessionTurns.get(sessionId);
    if (turnId) return this.pendingByTurn.get(turnId);
    const rootId = this.rootSession(sessionId);
    if (rootId === sessionId) return this.pending.get(rootId);
    const pending = this.pending.get(rootId);
    return pending?.descendantIds.has(sessionId) ? pending : undefined;
  }

  private rootSession(sessionId: string): string {
    let current = sessionId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const parentID = this.sessionParents.get(current);
      if (!parentID) break;
      current = parentID;
    }
    return current;
  }

  private observeActivity(
    pending: PendingTurn,
    sessionId: string,
    activityAt: number,
    stepKey?: string,
    tool?: string,
  ): void {
    this.markObserved(pending, activityAt);
    if (sessionId !== pending.sessionId) {
      pending.activeSessions.add(sessionId);
      pending.lastActivityBySession.set(sessionId, Date.now());
      pending.pollPrioritySessionIds.add(sessionId);
    }
    if (stepKey) pending.stepKeys.add(stepKey);
    if (tool) pending.lastTool = tool;
    this.updateProgress(pending);
  }

  private deactivate(pending: PendingTurn, sessionId: string): void {
    pending.activeSessions.delete(sessionId);
    pending.lastActivityBySession.delete(sessionId);
    pending.pollPrioritySessionIds.delete(sessionId);
    this.updateProgress(pending);
  }

  private pruneInactiveDescendants(pending: PendingTurn): void {
    const now = Date.now();
    let changed = false;
    for (const [sessionId, lastActivityAt] of pending.lastActivityBySession) {
      if (now - lastActivityAt < this.activeSessionTtlMs) continue;
      pending.activeSessions.delete(sessionId);
      pending.pollPrioritySessionIds.delete(sessionId);
      pending.lastActivityBySession.delete(sessionId);
      changed = true;
    }
    if (changed) this.updateProgress(pending);
  }

  private updateProgress(pending: PendingTurn): void {
    pending.progress = {
      steps: pending.stepKeys.size,
      activeSubagents: pending.activeSessions.size,
      lastActivityAt: pending.lastActivityAt,
      ...(pending.lastTool === undefined ? {} : { lastTool: pending.lastTool }),
    };
  }

  private watch(
    turnId: string,
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
    const startedAt = Date.now();
    const pending: PendingTurn = {
      turnId,
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
      startedAt,
      lastActivityAt: startedAt,
      stepKeys: new Set(),
      activeSessions: new Set(),
      descendantIds: new Set(),
      observedMessageIds: new Set(),
      messageSnapshots: new Map(),
      lastActivityBySession: new Map(),
      pollPrioritySessionIds: new Set(),
      pollDescendantCursor: 0,
      pollMessageCursor: 0,
      abortListener: () => {
        this.rejectPending(
          pending,
          new OpenCodeFailure("TURN_INTERRUPTED", "The OpenCode turn was interrupted.", false),
        );
      },
    };
    this.pending.set(sessionId, pending);
    this.pendingByTurn.set(turnId, pending);
    this.sessionTurns.set(sessionId, turnId);
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
    this.pendingByTurn.delete(pending.turnId);
    this.cleanupPendingMappings(pending);
    pending.signal.removeEventListener("abort", pending.abortListener);
    pending.resolve(text);
  }

  private rejectPending(pending: PendingTurn, error: unknown): void {
    if (this.pending.get(pending.sessionId) !== pending) return;
    this.pending.delete(pending.sessionId);
    this.pendingByTurn.delete(pending.turnId);
    this.cleanupPendingMappings(pending);
    pending.signal.removeEventListener("abort", pending.abortListener);
    pending.reject(error);
  }

  private cleanupPendingMappings(pending: PendingTurn): void {
    for (const [sessionId, turnId] of this.sessionTurns) {
      if (turnId === pending.turnId) this.sessionTurns.delete(sessionId);
    }
    this.sessionParents.delete(pending.sessionId);
    for (const sessionId of pending.descendantIds) this.sessionParents.delete(sessionId);
    pending.descendantIds.clear();
    pending.activeSessions.clear();
    pending.lastActivityBySession.clear();
    pending.pollPrioritySessionIds.clear();
    pending.messageSnapshots.clear();
    pending.observedMessageIds.clear();
    pending.stepKeys.clear();
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
    data.includes("session.created") ||
    data.includes("permission.") ||
    data.includes("question.") ||
    data.includes("message.updated") ||
    data.includes("message.part.updated") ||
    data.includes("session.idle") ||
    data.includes("session.status") ||
    data.includes("session.error")
  );
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isBeforeTurn(createdAt: number | undefined, startedAt: number): boolean {
  if (createdAt === undefined) return false;
  const normalized = createdAt < startedAt / 1000 ? createdAt * 1000 : createdAt;
  return normalized < startedAt;
}

function messageStepKey(sessionId: string, messageId: string): string {
  return `message:${sessionId}:${messageId}`;
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
      const value = part as {
        id?: unknown;
        type?: unknown;
        text?: unknown;
        tool?: unknown;
        time?: unknown;
      };
      if (value.id !== undefined && typeof value.id !== "string") {
        invalidResponse("OpenCode returned an invalid message part ID.");
      }
      if (value.type !== undefined && typeof value.type !== "string") {
        invalidResponse("OpenCode returned an invalid message part type.");
      }
      if (value.text !== undefined && typeof value.text !== "string") {
        invalidResponse("OpenCode returned invalid message text.");
      }
      if (value.tool !== undefined && typeof value.tool !== "string") {
        invalidResponse("OpenCode returned invalid message part tool.");
      }
      if (value.time !== undefined && (!value.time || typeof value.time !== "object")) {
        invalidResponse("OpenCode returned an invalid message part time.");
      }
      return {
        id: typeof value.id === "string" ? value.id : undefined,
        type: typeof value.type === "string" ? value.type : undefined,
        text: typeof value.text === "string" ? value.text : undefined,
        tool: typeof value.tool === "string" ? value.tool : undefined,
        time: value.time as MessagePart["time"],
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
    if (session.time !== undefined && (!session.time || typeof session.time !== "object")) {
      invalidResponse("OpenCode returned an invalid session time.");
    }
    const time = session.time as { created?: unknown } | undefined;
    if (time?.created !== undefined && typeof time.created !== "number") {
      invalidResponse("OpenCode returned an invalid session creation time.");
    }
    return {
      id: session.id,
      ...(typeof session.parentID === "string" ? { parentID: session.parentID } : {}),
      ...(typeof time?.created === "number" ? { time: { created: time.created } } : {}),
    };
  });
}

function snapshotMessages(messages: MessageEnvelope[]): MessageSnapshot {
  const message = messages[messages.length - 1];
  if (!message) return { fingerprint: "empty" };
  let tool: string | undefined;
  const parts = message.parts.map((part) => {
    if (typeof part.tool === "string" && part.tool) tool = part.tool;
    return {
      id: part.id,
      type: part.type,
      tool: part.tool,
      time: part.time,
    };
  });
  return {
    fingerprint: JSON.stringify({
      id: message.info.id,
      created: message.info.time?.created,
      completed: message.info.time?.completed,
      parts: parts.map((part) => ({ id: part.id, time: part.time })),
    }),
    messageID: message.info.id,
    ...(message.info.time?.created === undefined ? {} : { createdAt: message.info.time.created }),
    ...(tool === undefined ? {} : { tool }),
  };
}

function invalidResponse(message: string): never {
  throw new OpenCodeFailure("INVALID_OPENCODE_RESPONSE", message, false);
}
