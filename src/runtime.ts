import { realpath } from "node:fs/promises";
import type { OpenCodePort } from "./opencode.ts";
import { Registry, RegistryError, type TurnRecord, type WorkerRecord } from "./registry.ts";
import { WorktreeError, type WorktreeInfo, type WorktreePort } from "./worktree.ts";

export type WorkerId = `wrk_${string}`;
export type TurnId = `trn_${string}`;
export type WorkerState = "running" | "idle" | "closed";
export type TurnState = "queued" | "running" | "completed" | "interrupted" | "failed";

export interface SpawnRequest {
  task: string;
  projectRoot: string;
  worktree?: string;
  label?: string;
  agent?: string;
  model?: string;
}

export interface SpawnReceipt {
  workerId: WorkerId;
  turnId: TurnId;
  status: "running";
  label?: string;
}

export interface FollowupRequest {
  workerId: WorkerId;
  message: string;
  agent?: string;
  model?: string;
}

export interface TurnReceipt {
  workerId: WorkerId;
  turnId: TurnId;
  status: "queued" | "running";
}

export interface MergeReceipt {
  workerId: WorkerId;
  status: "merged";
}

export interface WorkerSnapshot {
  type: "worker";
  workerId: WorkerId;
  status: WorkerState;
  activeTurnId: TurnId | null;
  queuedTurnIds: TurnId[];
  directory: string;
  label?: string;
  worktree?: WorktreeInfo;
}

export interface TurnSnapshot {
  type: "turn";
  turnId: TurnId;
  workerId: WorkerId;
  status: TurnState;
  text?: string;
  error?: RuntimeErrorBody;
}

export type TerminalTurnSnapshot = TurnSnapshot & {
  status: "completed" | "interrupted" | "failed";
};

export interface WorkerRuntime {
  spawn(request: SpawnRequest): Promise<SpawnReceipt>;
  list(projectRoot?: string): Promise<{ workers: WorkerSnapshot[] }>;
  status(id: WorkerId | TurnId): Promise<WorkerSnapshot | TurnSnapshot>;
  followup(request: FollowupRequest): Promise<TurnReceipt>;
  wait(turnId: TurnId): Promise<TerminalTurnSnapshot>;
  interrupt(workerId: WorkerId): Promise<WorkerSnapshot & { interruptedTurnId?: TurnId }>;
  merge(workerId: WorkerId): Promise<MergeReceipt>;
  close(workerId: WorkerId): Promise<WorkerSnapshot>;
}

export interface RuntimeErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }

  toJSON(): RuntimeErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export type HostedWorkerRuntime = WorkerRuntime & AsyncDisposable;

interface TurnLatch {
  promise: Promise<void>;
  resolve(): void;
}

export function createWorkerRuntime(input: {
  client: OpenCodePort;
  stateFile: string;
  worktrees?: WorktreePort;
}): HostedWorkerRuntime {
  let registry: Registry;
  try {
    registry = new Registry(input.stateFile);
  } catch (error) {
    if (error instanceof RegistryError) throw new RuntimeError("REGISTRY_FAILURE", error.message);
    throw error;
  }

  const controllers = new Map<TurnId, AbortController>();
  const latches = new Map<TurnId, TurnLatch>();
  const jobs = new Set<Promise<void>>();
  const mergingWorkers = new Set<WorkerId>();
  let mergeTail = Promise.resolve();
  let disposing = false;
  let disposePromise: Promise<void> | undefined;

  const execute = async (turn: TurnRecord, worker: WorkerRecord): Promise<void> => {
    const controller = new AbortController();
    controllers.set(turn.id, controller);
    let next: TurnRecord | null = null;
    try {
      if (!turn.openCodeMessageId) {
        throw new RuntimeError(
          "TURN_UNRECOVERABLE",
          "The turn has no OpenCode message identity and cannot be recovered.",
          true,
        );
      }
      const text = await input.client.executeTurn(
        worker.sessionId,
        worker.directory,
        turn.openCodeMessageId,
        {
          message: turn.message,
          agent: turn.agent ?? worker.agent,
          model: turn.model ?? worker.model,
        },
        controller.signal,
      );
      if (!disposing) next = registry.finishTurn(turn.id, text);
    } catch (error) {
      if (!disposing) next = registry.failTurn(turn.id, runtimeErrorBody(error));
    } finally {
      controllers.delete(turn.id);
      signal(turn.id);
      if (next && !disposing) launch(next, requiredWorker(worker.id));
    }
  };

  const launch = (turn: TurnRecord, worker: WorkerRecord): void => {
    if (disposing) return;
    const job = execute(turn, worker);
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  };

  const recover = async (): Promise<void> => {
    for (const turn of registry.runningTurns()) {
      const worker = registry.getWorker(turn.workerId);
      if (!worker) {
        registry.failTurn(turn.id, {
          code: "WORKER_NOT_FOUND",
          message: `Worker ${turn.workerId} was not found during recovery.`,
          retryable: false,
        });
        continue;
      }
      launch(turn, worker);
    }
  };

  const ready = recover();

  const runtime: HostedWorkerRuntime = {
    async spawn(request) {
      await ready;
      if (!request.task.trim()) throw new RuntimeError("INVALID_TASK", "Task cannot be empty.");

      const projectRoot = await canonicalDirectory(request.projectRoot);
      const worktree = request.worktree ? await createWorktree(projectRoot, request.worktree) : undefined;
      const directory = worktree?.path ?? projectRoot;

      let sessionId: string;
      try {
        sessionId = await input.client.createSession({ directory, label: request.label });
      } catch (error) {
        if (worktree) await rollbackWorktree(projectRoot, worktree);
        throw error;
      }
      const workerId = makeWorkerId();
      const turnId = makeTurnId();
      const worker: WorkerRecord = {
        id: workerId,
        sessionId,
        projectRoot,
        directory,
        label: request.label,
        agent: request.agent,
        model: request.model,
        worktree,
        status: "running",
        activeTurnId: turnId,
      };
      const turn: TurnRecord = {
        id: turnId,
        workerId,
        message: request.task,
        openCodeMessageId: makeOpenCodeMessageId(),
        agent: request.agent,
        model: request.model,
        status: "running",
      };
      try {
        registry.createWorkerAndTurn(worker, turn);
      } catch (error) {
        await Promise.allSettled([input.client.close(sessionId, directory)]);
        if (worktree) await rollbackWorktree(projectRoot, worktree);
        throw error;
      }
      launch(turn, worker);
      return { workerId, turnId, status: "running" as const, label: request.label };
    },

    async list(projectRoot) {
      await ready;
      const project = projectRoot ? await canonicalDirectory(projectRoot) : undefined;
      return { workers: registry.listWorkers(project).map(workerSnapshot) };
    },

    async status(id) {
      await ready;
      if (id.startsWith("wrk_")) return workerSnapshot(requiredWorker(id as WorkerId));
      if (id.startsWith("trn_")) return turnSnapshot(requiredTurn(id as TurnId));
      throw new RuntimeError("INVALID_ID", `Expected a wrk_... or trn_... ID; received ${id}.`);
    },

    async followup(request) {
      await ready;
      if (!request.message.trim()) throw new RuntimeError("INVALID_MESSAGE", "Message cannot be empty.");
      const worker = requiredWorker(request.workerId);
      if (worker.status === "closed") {
        throw new RuntimeError("WORKER_CLOSED", `Worker ${request.workerId} is closed.`);
      }
      if (mergingWorkers.has(worker.id)) {
        throw new RuntimeError("WORKER_BUSY", `Worker ${request.workerId} is being merged.`);
      }

      const turn: TurnRecord = {
        id: makeTurnId(),
        workerId: worker.id,
        message: request.message,
        openCodeMessageId: makeOpenCodeMessageId(),
        agent: request.agent,
        model: request.model,
        status: "queued",
      };
      const status = registry.enqueueTurn(turn);
      if (status === "running") {
        const current = requiredWorker(worker.id);
        launch(turn, current);
      }
      return { workerId: worker.id, turnId: turn.id, status };
    },

    async wait(turnId) {
      await ready;
      let turn = requiredTurn(turnId);
      if (isTerminal(turn.status)) return turnSnapshot(turn) as TerminalTurnSnapshot;

      const latch = getLatch(turnId);
      turn = requiredTurn(turnId);
      if (!isTerminal(turn.status)) await latch.promise;
      return turnSnapshot(requiredTurn(turnId)) as TerminalTurnSnapshot;
    },

    async interrupt(workerId) {
      await ready;
      const worker = requiredWorker(workerId);
      const transition = registry.interruptActive(workerId);
      if (!transition) return workerSnapshot(worker);
      const { interruptedTurnId } = transition;

      controllers.get(interruptedTurnId)?.abort();
      signal(interruptedTurnId);
      await Promise.allSettled([input.client.abort(worker.sessionId, worker.directory)]);
      if (transition.next) launch(transition.next, requiredWorker(workerId));
      return { ...workerSnapshot(requiredWorker(workerId)), interruptedTurnId };
    },

    async merge(workerId) {
      await ready;
      const worker = requiredWorker(workerId);
      const worktree = worker.worktree;
      if (!worktree) {
        throw new RuntimeError("WORKTREE_REQUIRED", `Worker ${workerId} does not use a managed worktree.`);
      }
      if (worker.activeTurnId || registry.queuedTurnIds(worker.id).length > 0 || mergingWorkers.has(worker.id)) {
        throw new RuntimeError("WORKER_BUSY", `Worker ${workerId} still has active or queued work.`);
      }
      const worktrees = input.worktrees;
      if (!worktrees) throw new RuntimeError("INVALID_USAGE", "Managed worktrees are unavailable.");

      mergingWorkers.add(worker.id);
      const operation = mergeTail.then(async () => {
        try {
          await worktrees.merge(worker.projectRoot, worktree);
          return { workerId, status: "merged" as const };
        } catch (error) {
          if (error instanceof WorktreeError) {
            throw new RuntimeError(error.code, error.message, error.retryable);
          }
          throw error;
        } finally {
          mergingWorkers.delete(worker.id);
        }
      });
      mergeTail = operation.then(() => undefined, () => undefined);
      return operation;
    },

    async close(workerId) {
      await ready;
      const worker = requiredWorker(workerId);
      const closed = registry.closeWorker(workerId);
      if (!closed || worker.status === "closed") return workerSnapshot(worker);

      for (const turnId of closed.interrupted) {
        controllers.get(turnId)?.abort();
        signal(turnId);
      }
      await Promise.allSettled([input.client.abort(worker.sessionId, worker.directory)]);
      await Promise.allSettled([input.client.close(worker.sessionId, worker.directory)]);
      return workerSnapshot(requiredWorker(workerId));
    },

    [Symbol.asyncDispose]() {
      if (disposePromise) return disposePromise;
      disposing = true;
      for (const controller of controllers.values()) controller.abort();
      for (const turnId of latches.keys()) signal(turnId);
      disposePromise = Promise.allSettled([...jobs]).then(() => {
        controllers.clear();
        registry.close();
      });
      return disposePromise;
    },
  };

  return runtime;

  function requiredWorker(workerId: WorkerId): WorkerRecord {
    const worker = registry.getWorker(workerId);
    if (!worker) throw new RuntimeError("WORKER_NOT_FOUND", `Worker ${workerId} was not found.`);
    return worker;
  }

  function requiredTurn(turnId: TurnId): TurnRecord {
    const turn = registry.getTurn(turnId);
    if (!turn) throw new RuntimeError("TURN_NOT_FOUND", `Turn ${turnId} was not found.`);
    return turn;
  }

  function workerSnapshot(worker: WorkerRecord): WorkerSnapshot {
    return {
      type: "worker" as const,
      workerId: worker.id,
      status: worker.status,
      activeTurnId: worker.activeTurnId,
      queuedTurnIds: registry.queuedTurnIds(worker.id),
      directory: worker.directory,
      label: worker.label,
      worktree: worker.worktree,
    };
  }

  async function createWorktree(projectRoot: string, name: string): Promise<WorktreeInfo> {
    if (!input.worktrees) throw new RuntimeError("INVALID_USAGE", "Managed worktrees are unavailable.");
    try {
      return await input.worktrees.create(projectRoot, name);
    } catch (error) {
      if (error instanceof WorktreeError) {
        throw new RuntimeError(error.code, error.message, error.retryable);
      }
      throw error;
    }
  }

  async function rollbackWorktree(projectRoot: string, worktree: WorktreeInfo): Promise<void> {
    if (!input.worktrees) return;
    await input.worktrees.rollback(projectRoot, worktree);
  }

  function getLatch(turnId: TurnId): TurnLatch {
    let latch = latches.get(turnId);
    if (latch) return latch;
    const { promise, resolve } = Promise.withResolvers<void>();
    latch = { promise, resolve };
    latches.set(turnId, latch);
    return latch;
  }

  function signal(turnId: TurnId): void {
    const latch = latches.get(turnId);
    if (!latch) return;
    latches.delete(turnId);
    latch.resolve();
  }
}

function turnSnapshot(turn: TurnRecord): TurnSnapshot {
  return {
    type: "turn" as const,
    turnId: turn.id,
    workerId: turn.workerId,
    status: turn.status,
    text: turn.text,
    error: turn.error,
  };
}

function makeWorkerId(): WorkerId {
  return `wrk_${crypto.randomUUID()}`;
}

function makeTurnId(): TurnId {
  return `trn_${crypto.randomUUID()}`;
}

let lastOpenCodeMessageTimestamp = 0;
let openCodeMessageCounter = 0;

function makeOpenCodeMessageId(): string {
  const timestamp = Date.now();
  if (timestamp !== lastOpenCodeMessageTimestamp) {
    lastOpenCodeMessageTimestamp = timestamp;
    openCodeMessageCounter = 0;
  }
  openCodeMessageCounter++;

  const sortable = (BigInt(timestamp) * 0x1000n + BigInt(openCodeMessageCounter)) & 0xffffffffffffn;
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let random = "";
  for (const byte of bytes) random += alphabet[byte % alphabet.length];
  return `msg_${sortable.toString(16).padStart(12, "0")}${random}`;
}

function isTerminal(status: TurnState): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new RuntimeError("INVALID_DIRECTORY", `Directory ${JSON.stringify(path)} does not exist.`);
  }
}

function runtimeErrorBody(error: unknown): RuntimeErrorBody {
  if (error instanceof RuntimeError) return error.toJSON();
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "retryable" in error &&
    typeof error.code === "string" &&
    typeof error.retryable === "boolean"
  ) {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : String(error),
      retryable: error.retryable,
    };
  }
  return {
    code: "OPENCODE_FAILURE",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
