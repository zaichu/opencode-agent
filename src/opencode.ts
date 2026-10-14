import { readFile, writeFile } from "node:fs/promises";

export interface TurnProgress {
  steps: number;
  activeSubagents: number;
  lastActivityAt: number;
  lastTool?: string;
}

// /api/session/{id}/message が返す章立て済みメッセージ(v2)。assistant は1turnで
// 複数作られ、turn の完了は type:"idle" のマーカー(outcome 付き)で示される。
interface MessageEntry {
  id: string;
  type?: string;
  content?: Array<Record<string, unknown>>;
  outcome?: string;
  error?: unknown;
  time?: { created?: number; streamed?: number; completed?: number };
}

interface SessionInfo {
  id: string;
  parentID?: string;
  time?: { created?: number };
}

interface PermissionRequest {
  id?: string;
  sessionID?: string;
}

type TurnScan =
  | { status: "unadmitted" }
  | { status: "running" }
  | { status: "unresolved" }
  | { status: "done"; text: string };

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
  readonly messageSnapshots: Map<string, MessageSnapshot>;
  readonly lastActivityBySession: Map<string, number>;
  readonly pollPrioritySessionIds: Set<string>;
  pollDescendantCursor: number;
  pollMessageCursor: number;
  polling?: Promise<void>;
  lastTool?: string;
}

interface MessageSnapshot {
  fingerprint: string;
  messageID?: string;
  createdAt?: number;
  type?: string;
  tool?: string;
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

// v2 の /api 配下は Basic 認証(ユーザー名 "opencode"、パスワードは serve が生成
// するトークン)。serve 自分起動時は OPENCODE_PASSWORD 環境変数でパスワードを固定
// して渡すため stdout 解析は不要。既存サーバーへ外部接続する場合も同じ環境変数を
// クライアント側で参照する。
class Auth {
  private header?: string;

  constructor(password?: string) {
    this.set(password);
  }

  set(password?: string): void {
    this.header = password === undefined ? undefined : `Basic ${btoa(`opencode:${password}`)}`;
  }

  get authorization(): string | undefined {
    return this.header;
  }
}

class OpenCodeClient {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly baseUrl = "http://127.0.0.1:4096",
    private readonly auth: Auth = new Auth(),
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.headers = { accept: "application/json" };
  }

  async health(): Promise<boolean> {
    try {
      // listen していないポートへの接続が RST を返さずハングする環境があるため timeout 必須。
      // ここが固まると ensureServer がサーバ起動の判断へ進めなくなる。
      const response = await fetch(this.url("/info"), {
        headers: this.headersOf(),
        signal: AbortSignal.timeout(2_000),
      });
      // 401 は「稼働中だがパスワード不明」。ここで false にすると同一ポートに
      // もう一台 serve を起動して衝突するだけなので稼働扱いにし、認証失敗は
      // 後続リクエストの OPENCODE_UNAUTHORIZED で報告する。
      return response.ok || response.status === 401;
    } catch {
      return false;
    }
  }

  async createSession(input: { directory: string; label?: string }): Promise<string> {
    const body: Record<string, unknown> = { location: { directory: input.directory } };
    if (input.label !== undefined) body.title = input.label;
    const response = await this.request("/session", { method: "POST", body: JSON.stringify(body) });
    const payload = await this.body(response);
    const session = payload?.data as { id?: unknown } | undefined;
    if (typeof session?.id !== "string") {
      throw new OpenCodeFailure("INVALID_OPENCODE_RESPONSE", "OpenCode returned a session without an ID.", false);
    }
    return session.id;
  }

  async promptAsync(sessionId: string, messageId: string, message: string): Promise<void> {
    // delivery は常に queue。アダプタは1セッション1turnを保証するため、
    // 実行待ちの差し込み(steer)は起きない。
    await this.request(`/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ id: messageId, text: message, delivery: "queue" }),
    });
  }

  async switchAgent(sessionId: string, agent: string): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}/agent`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    });
  }

  async switchModel(sessionId: string, model: string): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      body: JSON.stringify({ model: parseModel(model) }),
    });
  }

  async activeSessions(): Promise<Set<string>> {
    const response = await this.request("/session/active");
    const payload = await this.body(response);
    const data = payload?.data as Record<string, unknown> | undefined;
    const running = new Set<string>();
    for (const [sessionId, entry] of data && typeof data === "object" ? Object.entries(data) : []) {
      if ((entry as { type?: unknown } | undefined)?.type === "running") running.add(sessionId);
    }
    return running;
  }

  // /api/session は既定で最新50件しか返さないため、子孫の列挙は cursor を辿る。
  async sessionChildren(sessionId: string, directory: string, timeoutMs: number): Promise<SessionInfo[]> {
    const children: SessionInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = this.url("/session");
      url.searchParams.set("parentID", sessionId);
      url.searchParams.set("directory", directory);
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await this.requestUrl(url, { signal: AbortSignal.timeout(timeoutMs) });
      const payload = await this.body(response);
      children.push(...sessionList(payload?.data));
      const next = (payload?.cursor as { next?: unknown } | undefined)?.next;
      if (typeof next !== "string") break;
      cursor = next;
    }
    return children;
  }

  // 最新(limit件、降順)ページだけ取得する進捗ポーリング用。
  async latestMessages(sessionId: string, limit: number, timeoutMs: number): Promise<MessageEntry[]> {
    const url = this.url(`/session/${encodeURIComponent(sessionId)}/message`);
    url.searchParams.set("limit", String(limit));
    const response = await this.requestUrl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const payload = await this.body(response);
    return messageList(payload?.data).reverse();
  }

  // メッセージ一覧は新しい順(desc)。既定ページサイズで打ち切られるため
  // cursor で1ページずつ辿る。
  async messagePage(sessionId: string, cursor?: string): Promise<{ entries: MessageEntry[]; next?: string }> {
    const url = this.url(`/session/${encodeURIComponent(sessionId)}/message`);
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await this.requestUrl(url, {});
    const payload = await this.body(response);
    const next = (payload?.cursor as { next?: unknown } | undefined)?.next;
    return { entries: messageList(payload?.data), next: typeof next === "string" ? next : undefined };
  }

  async findMessage(sessionId: string, messageId: string): Promise<MessageEntry | null> {
    let response: Response;
    try {
      response = await this.requestUrl(
        this.url(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`),
        {},
      );
    } catch (error) {
      // 未 admitted の user メッセージは 404({_tag: "MessageNotFoundError"})で返る。
      // 失敗ではなく precheck の「まだ persist されていない」判定に使う。
      if (error instanceof OpenCodeFailure && error.code === "OPENCODE_NOT_FOUND") return null;
      throw error;
    }
    const payload = await this.body(response);
    return messageEntry(payload?.data);
  }

  async openGlobalEvents(signal: AbortSignal): Promise<Response> {
    const response = await this.requestUrl(this.url("/event"), {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.body) {
      throw new OpenCodeFailure("INVALID_OPENCODE_RESPONSE", "OpenCode returned an empty event stream.", true);
    }
    return response;
  }

  async pendingPermissions(): Promise<PermissionRequest[]> {
    const response = await this.request("/permission/request");
    const payload = await this.body(response);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return data.map((entry: unknown) => {
      const value = entry as PermissionRequest;
      return {
        id: typeof value?.id === "string" ? value.id : undefined,
        sessionID: typeof value?.sessionID === "string" ? value.sessionID : undefined,
      };
    });
  }

  async approvePermission(requestId: string, sessionId: string): Promise<void> {
    await this.request(
      `/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { method: "POST", body: JSON.stringify({ decision: "once" }) },
    );
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST" });
  }

  async close(sessionId: string): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  private async request(
    path: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const response = await this.requestUrl(this.url(path), init);
    if (response.status === 404) {
      const detail = (await response.text()).trim().slice(0, 4096);
      throw new OpenCodeFailure(
        "OPENCODE_NOT_FOUND",
        `OpenCode ${init.method ?? "GET"} ${path} failed (404)${detail ? `: ${detail}` : ""}`,
        false,
      );
    }
    return response;
  }

  private async body(response: Response): Promise<(Record<string, unknown> & { data?: unknown }) | undefined> {
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown> & { data?: unknown };
  }

  private async requestUrl(
    url: URL,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
  ): Promise<Response> {
    let response: Response;
    try {
      // 呼び出し側の signal が無い REST 呼び出しはここで時間切れにする。応答しない
      // serve へ watch 登録前に待ち続けると、pending 未登録で turn タイムアウトも
      // 効かず executeTurn が戻らない。SSE とポーリングは呼び出し側の signal が優先。
      response = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
        headers: { ...this.headersOf(), ...init.headers },
      });
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

    if (response.status === 401) {
      throw new OpenCodeFailure(
        "OPENCODE_UNAUTHORIZED",
        `OpenCode at ${this.baseUrl} requires authentication. Set OPENCODE_PASSWORD to the server password.`,
        false,
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

  private headersOf(): Record<string, string> {
    const authorization = this.auth.authorization;
    return authorization === undefined ? this.headers : { ...this.headers, authorization };
  }

  // v2 の全ルートは /api 配下なので、呼び出し側は resource パスだけ渡す。
  private url(path: string): URL {
    return new URL(`/api${path}`, this.baseUrl);
  }
}

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const TIMEOUT_CHECK_INTERVAL_MS = 30 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_DESCENDANT_LIMIT = 20;
const DEFAULT_POLL_MESSAGE_LIMIT = 20;
const DEFAULT_ACTIVE_SESSION_TTL_MS = 60_000;
const POLL_MESSAGE_LIMIT = 1;

function passwordFromEnvironment(): string | undefined {
  return Bun.env.OPENCODE_PASSWORD ?? Bun.env.OPENCODE_SERVER_PASSWORD;
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export class ManagedOpenCode implements OpenCodePort {
  private readonly auth: Auth;
  private readonly client: OpenCodeClient;
  private readonly eventAbort = new AbortController();
  private readonly pending = new Map<string, PendingTurn>();
  private readonly pendingByTurn = new Map<string, PendingTurn>();
  private readonly sessionParents = new Map<string, string>();
  private readonly sessionTurns = new Map<string, string>();
  private readonly appliedAgentBySession = new Map<string, string>();
  private readonly appliedModelBySession = new Map<string, string>();
  private child?: ReturnType<typeof Bun.spawn>;
  private starting?: Promise<void>;
  private eventsReady?: Promise<void>;
  private reconnecting?: Promise<void>;
  private stopped = false;
  private readonly timeoutTimer: ReturnType<typeof setInterval>;
  private password: string | undefined;

  constructor(
    private readonly baseUrl = "http://127.0.0.1:4096",
    private readonly executable = "opencode",
    private readonly turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    timeoutCheckIntervalMs = TIMEOUT_CHECK_INTERVAL_MS,
    private readonly pollRequestTimeoutMs = DEFAULT_POLL_REQUEST_TIMEOUT_MS,
    private readonly pollDescendantLimit = DEFAULT_POLL_DESCENDANT_LIMIT,
    private readonly pollMessageLimit = DEFAULT_POLL_MESSAGE_LIMIT,
    private readonly activeSessionTtlMs = DEFAULT_ACTIVE_SESSION_TTL_MS,
    private readonly passwordFile?: string,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    // 外部接続のときは環境変数のパスワード、自分で起動するときは固定パスワードを
    // 生成する。乱数パスワードは子プロセスに OPENCODE_PASSWORD として渡されるため
    // stdout を解析する必要がない。
    this.password = passwordFromEnvironment();
    this.auth = new Auth(this.password);
    this.client = new OpenCodeClient(baseUrl, this.auth, requestTimeoutMs);
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
        // turn 開始前に作られた子は前turnの成果物。次の進捗に混ぜない。
        if (!isBeforeTurn(child.time?.created, pending.startedAt)) this.adoptDescendant(pending, child.id);
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
    let messages: MessageEntry[];
    try {
      messages = await this.client.latestMessages(sessionId, POLL_MESSAGE_LIMIT, this.pollRequestTimeoutMs);
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
      const fresh = snapshot.createdAt === undefined || snapshot.createdAt >= pending.startedAt;
      if (fresh && !pending.stepKeys.has(messageKey)) {
        // ステップとして数えるのは assistant メッセージだけ(user プロンプトや
        // idle マーカーは SSE の step.started に対応しない)。
        this.observeActivity(
          pending,
          sessionId,
          Date.now(),
          snapshot.type === "assistant" ? messageKey : undefined,
          snapshot.tool,
        );
      }
      return;
    }
    if (previous.fingerprint === snapshot.fingerprint) return;
    const stepKey =
      snapshot.type === "assistant" && previous.messageID !== snapshot.messageID
        ? messageStepKey(sessionId, snapshot.messageID)
        : undefined;
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
    if (input.agent && this.appliedAgentBySession.get(sessionId) !== input.agent) {
      await this.client.switchAgent(sessionId, input.agent);
      this.appliedAgentBySession.set(sessionId, input.agent);
    }
    if (input.model && this.appliedModelBySession.get(sessionId) !== input.model) {
      await this.client.switchModel(sessionId, input.model);
      this.appliedModelBySession.set(sessionId, input.model);
    }
    const precheck = await this.findTurnResult(sessionId, messageId);
    if (precheck.status === "done") return precheck.text;
    const persisted = precheck.status !== "unadmitted";
    const pending = this.watch(turnId, sessionId, directory, messageId, signal, persisted);
    if (persisted) this.markObserved(pending);
    try {
      if (!persisted) await this.client.promptAsync(sessionId, messageId, input.message);
      await this.refresh(pending);
      return await pending.promise;
    } catch (error) {
      this.rejectPending(pending, error);
      throw error;
    }
  }

  // user メッセージを起点に、次の user メッセージまたは idle マーカーまでの
  // assistant メッセージをその1つの成果物として読む。ランタイムはセッション毎に
  // turn を直列化しているため、区間の中に別 turn のメッセージは入らない。
  private async findTurnResult(sessionId: string, userMessageId: string): Promise<TurnScan> {
    const userMessage = await this.client.findMessage(sessionId, userMessageId);
    if (!userMessage) return { status: "unadmitted" };
    // メッセージ一覧は新しい順・既定ページサイズ打ち切りのため、ページを辿りながら
    // 対象の user メッセージ以降(= この turn の区間)だけを集める。
    const collected: MessageEntry[] = [];
    let cursor: string | undefined;
    let admitted = false;
    for (let page = 0; page < 20 && !admitted; page++) {
      const { entries, next } = await this.client.messagePage(sessionId, cursor);
      for (const message of entries) {
        if (message.type === "user" && message.id === userMessageId) {
          admitted = true;
          break;
        }
        collected.push(message);
      }
      if (!next) break;
      cursor = next;
    }
    // persist 済みの user メッセージがページ取得で見つからないのは不整合。再送は
    // 重複になるため unadmitted にはせず、判別不能として扱う。
    if (!admitted) return { status: "unresolved" };
    const entries = collected.reverse();
    const turn: MessageEntry[] = [];
    for (const message of entries) {
      if (message.type === "idle") {
        const failed = turn.find((entry) => entry.error);
        if (failed?.error) throw errorFromAssistant(failed.error);
        if (message.outcome === "succeeded") return { status: "done", text: resultText(turn) };
        // idle は実行終了。成功以外の outcome(failed/interrupted 等)を終了しない
        // ものとして扱うと turn が timeout まで残るため、詳細不明でも失敗で返す。
        if (typeof message.outcome === "string") {
          throw new OpenCodeFailure(
            "OPENCODE_TURN_FAILED",
            `OpenCode turn ${userMessageId} in session ${sessionId} finished with outcome ${message.outcome}.`,
            false,
          );
        }
        return { status: "unresolved" };
      }
      if (message.type === "user" && message.id !== userMessageId) return { status: "unresolved" };
      if (message.type === "assistant") turn.push(message);
    }
    return { status: "running" };
  }

  async abort(sessionId: string, _directory: string): Promise<void> {
    await this.ensureServer();
    await this.client.abort(sessionId);
  }

  async close(sessionId: string, _directory: string): Promise<void> {
    await this.ensureServer();
    await this.client.close(sessionId);
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
    this.appliedAgentBySession.clear();
    this.appliedModelBySession.clear();

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

  // 自分が起動した serve のパスワードは passwordFile(= daemon の状態ディレクトリ
  // 配下)に退避する。daemon が SIGKILL 等で落ちて serve だけが残った場合、次の
  // daemon が同じパスワードで 401 の孤児 serve に接続して復帰できる。
  private async loadPersistedPassword(): Promise<void> {
    if (this.password !== undefined || !this.passwordFile) return;
    try {
      const value = (await readFile(this.passwordFile, "utf8")).trim();
      if (value) {
        this.password = value;
        this.auth.set(value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async startServer(): Promise<void> {
    await this.loadPersistedPassword();
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
    const password = this.password ?? randomPassword();
    if (this.password === undefined && this.passwordFile) {
      await writeFile(this.passwordFile, password, { mode: 0o600 });
    }
    this.auth.set(password);
    this.child = Bun.spawn({
      cmd: [this.executable, "serve", "--hostname", url.hostname, "--port", port],
      env: { ...Bun.env, OPENCODE_PASSWORD: password },
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

  // v2 の SSE は {type, data} の1行 data JSON(v1 の {payload: {…}} ラップなし)。
  private handleEvent(data: string): void {
    if (!isRelevantEvent(data)) return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;
    const event = value as { type?: unknown; data?: unknown; created?: unknown };
    if (typeof event.type !== "string" || !event.data || typeof event.data !== "object") return;
    const payload = event.data as Record<string, unknown>;
    const sessionId = sessionIdOf(payload);

    switch (event.type) {
      case "session.created":
        this.handleSessionCreated(payload, numberValue(event.created));
        break;
      case "permission.asked":
      case "permission.v2.asked": {
        if (!sessionId || typeof payload.id !== "string") break;
        const pending = this.pendingForSession(sessionId);
        if (!pending) break;
        this.observeActivity(pending, sessionId, Date.now(), `permission:${payload.id}`);
        void this.client.approvePermission(payload.id, sessionId).catch((error) => {
          this.failSession(sessionId, error);
        });
        break;
      }
      case "session.inbox.delivered": {
        if (!sessionId) break;
        const pending = this.pendingForSession(sessionId);
        if (pending) this.observeActivity(pending, sessionId, Date.now());
        break;
      }
      case "session.step.started": {
        if (!sessionId) break;
        const pending = this.pendingForSession(sessionId);
        if (!pending) break;
        const key =
          typeof payload.assistantMessageID === "string"
            ? messageStepKey(sessionId, payload.assistantMessageID)
            : undefined;
        this.observeActivity(pending, sessionId, numberValue(payload.started) ?? Date.now(), key);
        break;
      }
      case "session.text.started":
      case "session.reasoning.started":
      case "session.tool.input.started": {
        if (!sessionId) break;
        const pending = this.pendingForSession(sessionId);
        if (!pending) break;
        const tool = typeof payload.name === "string" && payload.name ? payload.name : undefined;
        this.observeActivity(pending, sessionId, Date.now(), undefined, tool);
        break;
      }
      case "session.text.delta":
      case "session.reasoning.delta":
      case "session.tool.input.delta":
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed": {
        if (!sessionId) break;
        const pending = this.pendingForSession(sessionId);
        if (pending) this.observeActivity(pending, sessionId, Date.now());
        break;
      }
      case "session.execution.started":
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        if (!sessionId) break;
        const pending = this.pendingForSession(sessionId);
        if (!pending) break;
        if (sessionId === pending.sessionId) void this.refresh(pending).catch(() => undefined);
        else this.deactivate(pending, sessionId);
        break;
      }
      case "session.status": {
        if (!sessionId || !payload.status || typeof payload.status !== "object") break;
        const pending = this.pendingForSession(sessionId);
        if (!pending) break;
        const type = (payload.status as { type?: unknown }).type;
        if (type === "busy" || type === "retry") this.observeActivity(pending, sessionId, Date.now());
        break;
      }
      case "session.error":
        this.failSession(sessionId, errorFromAssistant(payload.error));
        break;
    }
  }

  private handleSessionCreated(payload: Record<string, unknown>, createdAt?: number): void {
    if (typeof payload.sessionID !== "string") return;
    const sessionId = payload.sessionID;
    const parentID = typeof payload.parentID === "string" ? payload.parentID : undefined;
    const inheritedTurn = parentID ? this.sessionTurns.get(parentID) : undefined;
    const turnId = inheritedTurn ?? this.pending.get(this.rootSession(sessionId))?.turnId;
    if (!turnId) return;
    const pending = this.pendingByTurn.get(turnId);
    if (!pending) return;
    if (isBeforeTurn(createdAt, pending.startedAt)) return;
    if (parentID) this.sessionParents.set(sessionId, parentID);
    this.sessionTurns.set(sessionId, turnId);
    if (sessionId !== pending.sessionId) pending.descendantIds.add(sessionId);
    this.observeActivity(pending, sessionId, Date.now());
  }

  private pendingForSession(sessionId: string | undefined): PendingTurn | undefined {
    if (typeof sessionId !== "string") return undefined;
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

  private adoptDescendant(pending: PendingTurn, sessionId: string): void {
    if (this.sessionTurns.has(sessionId) || pending.descendantIds.has(sessionId)) return;
    this.sessionTurns.set(sessionId, pending.turnId);
    if (sessionId !== pending.sessionId) pending.descendantIds.add(sessionId);
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
    let scan: TurnScan;
    try {
      scan = await this.findTurnResult(pending.sessionId, pending.userMessageId);
    } catch (error) {
      this.rejectPending(pending, error);
      return;
    }
    if (this.pending.get(pending.sessionId) !== pending) return;
    if (scan.status === "done") {
      this.markObserved(pending);
      this.resolvePending(pending, scan.text);
      return;
    }
    if (scan.status === "running") {
      const active = await this.client.activeSessions();
      if (active.has(pending.sessionId)) this.markObserved(pending);
      else if (pending.observed || pending.failIfIdleWithoutResult) await this.finish(pending.sessionId);
      return;
    }
    // unadmitted: prompt がまだ persist されていない。開始直後の空振り。
    // unresolved: 中断済み(実行が終わったが成果物を持たない)。既存の
    // failIfIdleWithoutResult の扱いに従う。
    if (scan.status === "unresolved" && (pending.observed || pending.failIfIdleWithoutResult)) {
      await this.finish(pending.sessionId);
    }
  }

  private async finish(sessionId: string): Promise<void> {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.finishing) return;
    pending.finishing = true;
    try {
      const scan = await this.findTurnResult(sessionId, pending.userMessageId);
      if (scan.status === "done") {
        this.resolvePending(pending, scan.text);
        return;
      }
      if (!pending.failIfIdleWithoutResult) return;
      throw new OpenCodeFailure(
        "MISSING_TURN_RESULT",
        `OpenCode session ${sessionId} became idle without an assistant result.`,
        true,
      );
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
    pending.stepKeys.clear();
  }

  private failSession(sessionId: unknown, error: unknown): void {
    if (typeof sessionId !== "string") return;
    const pending = this.pending.get(sessionId);
    if (pending) this.rejectPending(pending, error);
  }

  private async resolvePendingPrompts(): Promise<void> {
    let requests: PermissionRequest[] = [];
    try {
      requests = await this.client.pendingPermissions();
    } catch {
      return;
    }
    const replies: Promise<void>[] = [];
    for (const request of requests) {
      if (typeof request.id !== "string" || typeof request.sessionID !== "string") continue;
      if (!this.pendingForSession(request.sessionID)) continue;
      replies.push(this.client.approvePermission(request.id, request.sessionID));
    }
    await Promise.allSettled(replies);
  }
}

function sessionIdOf(payload: Record<string, unknown>): string | undefined {
  return typeof payload.sessionID === "string" ? payload.sessionID : undefined;
}

function parseModel(model: string): { providerID: string; id: string } {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new OpenCodeFailure(
      "INVALID_MODEL",
      `Model must use provider/model format; received ${JSON.stringify(model)}.`,
      false,
    );
  }
  return { providerID: model.slice(0, separator), id: model.slice(separator + 1) };
}

function resultText(entries: MessageEntry[]): string {
  let result = "";
  for (const entry of entries) {
    for (const part of entry.content ?? []) {
      const value = part as { type?: unknown; text?: unknown };
      if (value.type !== "text" || typeof value.text !== "string") continue;
      result = result ? `${result}\n${value.text}` : value.text;
    }
  }
  return result;
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
    data.includes("session.inbox.") ||
    data.includes("session.execution.") ||
    data.includes("session.step.") ||
    data.includes("session.text.") ||
    data.includes("session.reasoning.") ||
    data.includes("session.tool.") ||
    data.includes("session.status") ||
    data.includes("session.error") ||
    data.includes("permission.")
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

function messageList(value: unknown): MessageEntry[] {
  if (!Array.isArray(value)) invalidResponse("OpenCode returned an invalid message list.");
  return value.map((entry) => messageEntry(entry));
}

function messageEntry(value: unknown): MessageEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidResponse("OpenCode returned an invalid message envelope.");
  }
  const entry = value as MessageEntry & Record<string, unknown>;
  if (typeof entry.id !== "string") invalidResponse("OpenCode returned an invalid message ID.");
  if (entry.time !== undefined && (!entry.time || typeof entry.time !== "object")) {
    invalidResponse("OpenCode returned an invalid message time.");
  }
  return entry;
}

function sessionList(value: unknown): SessionInfo[] {
  if (!Array.isArray(value)) invalidResponse("OpenCode returned an invalid session list.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") invalidResponse("OpenCode returned an invalid session.");
    const session = entry as SessionInfo & Record<string, unknown>;
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

function snapshotMessages(messages: MessageEntry[]): MessageSnapshot {
  const message = messages.findLast((entry) => entry.type === "assistant");
  if (!message) return { fingerprint: "empty" };
  let tool: string | undefined;
  let text: string | undefined;
  for (const part of message.content ?? []) {
    const value = part as { type?: unknown; name?: unknown; text?: unknown };
    if (typeof value.name === "string" && value.name) tool = value.name;
    if (value.type === "text" && typeof value.text === "string") text = value.text;
  }
  return {
    fingerprint: JSON.stringify({
      id: message.id,
      created: message.time?.created,
      streamed: message.time?.streamed,
      completed: message.time?.completed,
      outcome: message.outcome,
      type: message.type,
      tool,
      text,
    }),
    messageID: message.id,
    ...(message.time?.created === undefined ? {} : { createdAt: message.time.created }),
    ...(message.type === undefined ? {} : { type: message.type }),
    ...(tool === undefined ? {} : { tool }),
  };
}

function invalidResponse(message: string): never {
  throw new OpenCodeFailure("INVALID_OPENCODE_RESPONSE", message, false);
}
