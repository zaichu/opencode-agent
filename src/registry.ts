import { Database, type Statement } from "bun:sqlite";
import type { RuntimeErrorBody, TurnId, TurnState, WorkerId, WorkerState } from "./runtime.ts";

const SCHEMA_VERSION = 1;

export interface WorkerRecord {
  id: WorkerId;
  sessionId: string;
  directory: string;
  label?: string;
  agent?: string;
  model?: string;
  status: WorkerState;
  activeTurnId: TurnId | null;
}

export interface TurnRecord {
  id: TurnId;
  workerId: WorkerId;
  message: string;
  openCodeMessageId: string | null;
  agent?: string;
  model?: string;
  status: TurnState;
  text?: string;
  error?: RuntimeErrorBody;
}

interface WorkerRow {
  id: string;
  session_id: string;
  directory: string;
  label: string | null;
  agent: string | null;
  model: string | null;
  status: WorkerState;
  active_turn_id: string | null;
}

interface TurnRow {
  id: string;
  worker_id: string;
  message: string;
  opencode_message_id: string | null;
  agent: string | null;
  model: string | null;
  status: TurnState;
  text: string | null;
  error_code: string | null;
  error_message: string | null;
  error_retryable: number | null;
}

export class Registry {
  private readonly database: Database;
  private readonly getWorkerStatement: Statement<WorkerRow, [string]>;
  private readonly getTurnStatement: Statement<TurnRow, [string]>;
  private readonly listWorkersStatement: Statement<WorkerRow, []>;
  private readonly queuedIdsStatement: Statement<{ id: string }, [string]>;
  private readonly runningTurnsStatement: Statement<TurnRow, []>;

  constructor(readonly path: string) {
    try {
      this.database = new Database(path, { create: true, strict: true });
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = FULL");
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.migrateSchema();
      this.getWorkerStatement = this.database.query<WorkerRow, [string]>(
        "SELECT id, session_id, directory, label, agent, model, status, active_turn_id FROM workers WHERE id = ?1",
      );
      this.getTurnStatement = this.database.query<TurnRow, [string]>(
        `SELECT id, worker_id, message, opencode_message_id, agent, model, status, text,
                error_code, error_message, error_retryable
           FROM turns WHERE id = ?1`,
      );
      this.listWorkersStatement = this.database.query<WorkerRow, []>(
        "SELECT id, session_id, directory, label, agent, model, status, active_turn_id FROM workers ORDER BY created_at",
      );
      this.queuedIdsStatement = this.database.query<{ id: string }, [string]>(
        "SELECT id FROM turns WHERE worker_id = ?1 AND status = 'queued' ORDER BY ordinal",
      );
      this.runningTurnsStatement = this.database.query<TurnRow, []>(
        `SELECT t.id, t.worker_id, t.message, t.opencode_message_id, t.agent, t.model,
                t.status, t.text, t.error_code, t.error_message, t.error_retryable
           FROM turns t JOIN workers w ON w.id = t.worker_id
          WHERE t.status = 'running' AND w.status != 'closed'
          ORDER BY t.ordinal`,
      );
    } catch (error) {
      throw new RegistryError(`Cannot open worker registry ${path}: ${messageOf(error)}`);
    }
  }

  close(): void {
    this.database.close(false);
  }

  createWorkerAndTurn(worker: WorkerRecord, turn: TurnRecord, now = Date.now()): void {
    this.transaction(() => {
      this.database
        .query(
          `INSERT INTO workers
             (id, session_id, directory, label, agent, model, status, active_turn_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
        )
        .run(
          worker.id,
          worker.sessionId,
          worker.directory,
          worker.label ?? null,
          worker.agent ?? null,
          worker.model ?? null,
          worker.status,
          worker.activeTurnId,
          now,
        );
      this.insertTurn(turn, now);
    });
  }

  enqueueTurn(turn: TurnRecord, now = Date.now()): "queued" | "running" {
    return this.transaction(() => {
      const worker = this.getWorker(turn.workerId);
      if (!worker) throw new RegistryError(`Worker ${turn.workerId} was not found.`);
      const startsNow = worker.status === "idle" && worker.activeTurnId === null;
      turn.status = startsNow ? "running" : "queued";
      this.insertTurn(turn, now);
      if (startsNow) {
        this.database
          .query("UPDATE workers SET status = 'running', active_turn_id = ?1, updated_at = ?2 WHERE id = ?3")
          .run(turn.id, now, worker.id);
      }
      return turn.status;
    });
  }

  finishTurn(turnId: TurnId, text: string, now = Date.now()): TurnRecord | null {
    return this.transaction(() => {
      const turn = this.getTurn(turnId);
      if (!turn || turn.status !== "running") return null;
      const result = this.database
        .query(
          `UPDATE turns
              SET status = 'completed', text = ?1, error_code = NULL, error_message = NULL,
                  error_retryable = NULL, updated_at = ?2
            WHERE id = ?3 AND status = 'running'`,
        )
        .run(text, now, turnId);
      if (result.changes === 0) return null;
      return this.releaseAndClaimNext(turn.workerId, turnId, now);
    });
  }

  failTurn(turnId: TurnId, error: RuntimeErrorBody, now = Date.now()): TurnRecord | null {
    return this.transaction(() => {
      const turn = this.getTurn(turnId);
      if (!turn || turn.status !== "running") return null;
      const result = this.database
        .query(
          `UPDATE turns
              SET status = 'failed', error_code = ?1, error_message = ?2,
                  error_retryable = ?3, updated_at = ?4
            WHERE id = ?5 AND status = 'running'`,
        )
        .run(error.code, error.message, error.retryable ? 1 : 0, now, turnId);
      if (result.changes === 0) return null;
      return this.releaseAndClaimNext(turn.workerId, turnId, now);
    });
  }

  interruptActive(workerId: WorkerId, now = Date.now()): { interruptedTurnId: TurnId; next: TurnRecord | null } | null {
    return this.transaction(() => {
      const worker = this.getWorker(workerId);
      if (!worker?.activeTurnId) return null;
      const interruptedTurnId = worker.activeTurnId;
      this.database
        .query("UPDATE turns SET status = 'interrupted', updated_at = ?1 WHERE id = ?2 AND status = 'running'")
        .run(now, interruptedTurnId);
      return { interruptedTurnId, next: this.releaseAndClaimNext(workerId, interruptedTurnId, now) };
    });
  }

  closeWorker(workerId: WorkerId, now = Date.now()): { worker: WorkerRecord; interrupted: TurnId[] } | null {
    return this.transaction(() => {
      const worker = this.getWorker(workerId);
      if (!worker) return null;
      if (worker.status === "closed") return { worker, interrupted: [] };
      const interrupted = this.database
        .query<{ id: string }, [string]>(
          "SELECT id FROM turns WHERE worker_id = ?1 AND status IN ('queued', 'running') ORDER BY ordinal",
        )
        .all(workerId)
        .map((row) => row.id as TurnId);
      this.database
        .query(
          `UPDATE turns SET status = 'interrupted', updated_at = ?1
            WHERE worker_id = ?2 AND status IN ('queued', 'running')`,
        )
        .run(now, workerId);
      this.database
        .query("UPDATE workers SET status = 'closed', active_turn_id = NULL, updated_at = ?1 WHERE id = ?2")
        .run(now, workerId);
      worker.status = "closed";
      worker.activeTurnId = null;
      return { worker, interrupted };
    });
  }

  getWorker(id: WorkerId): WorkerRecord | null {
    const row = this.getWorkerStatement.get(id);
    return row ? workerFromRow(row) : null;
  }

  getTurn(id: TurnId): TurnRecord | null {
    const row = this.getTurnStatement.get(id);
    return row ? turnFromRow(row) : null;
  }

  listWorkers(): WorkerRecord[] {
    return this.listWorkersStatement.all().map(workerFromRow);
  }

  queuedTurnIds(workerId: WorkerId): TurnId[] {
    return this.queuedIdsStatement.all(workerId).map((row) => row.id as TurnId);
  }

  runningTurns(): TurnRecord[] {
    return this.runningTurnsStatement.all().map(turnFromRow);
  }

  private insertTurn(turn: TurnRecord, now: number): void {
    this.database
      .query(
        `INSERT INTO turns
           (id, worker_id, message, opencode_message_id, agent, model, status, text,
            error_code, error_message, error_retryable, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
      )
      .run(
        turn.id,
        turn.workerId,
        turn.message,
        turn.openCodeMessageId,
        turn.agent ?? null,
        turn.model ?? null,
        turn.status,
        turn.text ?? null,
        turn.error?.code ?? null,
        turn.error?.message ?? null,
        turn.error ? (turn.error.retryable ? 1 : 0) : null,
        now,
      );
  }

  private transaction<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }

  private releaseAndClaimNext(workerId: WorkerId, activeTurnId: TurnId, now: number): TurnRecord | null {
    this.database
      .query(
        `UPDATE workers SET status = 'idle', active_turn_id = NULL, updated_at = ?1
          WHERE id = ?2 AND active_turn_id = ?3 AND status != 'closed'`,
      )
      .run(now, workerId, activeTurnId);
    const row = this.database
      .query<TurnRow, [string]>(
        `SELECT id, worker_id, message, opencode_message_id, agent, model, status, text,
                error_code, error_message, error_retryable
           FROM turns WHERE worker_id = ?1 AND status = 'queued' ORDER BY ordinal LIMIT 1`,
      )
      .get(workerId);
    if (!row) return null;
    this.database.query("UPDATE turns SET status = 'running', updated_at = ?1 WHERE id = ?2").run(now, row.id);
    this.database
      .query("UPDATE workers SET status = 'running', active_turn_id = ?1, updated_at = ?2 WHERE id = ?3")
      .run(row.id, now, workerId);
    row.status = "running";
    return turnFromRow(row);
  }

  private migrateSchema(): void {
    const version = this.database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version > SCHEMA_VERSION) {
      throw new RegistryError(`Registry schema ${version} is newer than supported schema ${SCHEMA_VERSION}.`);
    }
    if (version === 0) {
      this.database.exec(`
        CREATE TABLE workers (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL UNIQUE,
          directory TEXT NOT NULL,
          label TEXT,
          agent TEXT,
          model TEXT,
          status TEXT NOT NULL,
          active_turn_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE turns (
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          worker_id TEXT NOT NULL REFERENCES workers(id),
          message TEXT NOT NULL,
          opencode_message_id TEXT,
          agent TEXT,
          model TEXT,
          status TEXT NOT NULL,
          text TEXT,
          error_code TEXT,
          error_message TEXT,
          error_retryable INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX turns_worker_status_ordinal ON turns(worker_id, status, ordinal);
        PRAGMA user_version = 1;
      `);
    }
  }

}

export class RegistryError extends Error {}

function workerFromRow(row: WorkerRow): WorkerRecord {
  return {
    id: row.id as WorkerId,
    sessionId: row.session_id,
    directory: row.directory,
    label: row.label ?? undefined,
    agent: row.agent ?? undefined,
    model: row.model ?? undefined,
    status: row.status,
    activeTurnId: row.active_turn_id as TurnId | null,
  };
}

function turnFromRow(row: TurnRow): TurnRecord {
  return {
    id: row.id as TurnId,
    workerId: row.worker_id as WorkerId,
    message: row.message,
    openCodeMessageId: row.opencode_message_id,
    agent: row.agent ?? undefined,
    model: row.model ?? undefined,
    status: row.status,
    text: row.text ?? undefined,
    error:
      row.error_code && row.error_message
        ? { code: row.error_code, message: row.error_message, retryable: row.error_retryable === 1 }
        : undefined,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
