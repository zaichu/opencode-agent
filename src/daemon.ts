import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterConfig } from "./config.ts";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, VERSION } from "./config.ts";
import { ManagedOpenCode } from "./opencode.ts";
import { OPERATIONS, type CommandRequest, type ErrorBody, type Scope } from "./protocol.ts";
import {
  RuntimeError,
  createWorkerRuntime,
  disposeRuntime,
  type HostedWorkerRuntime,
  type TurnId,
  type WorkerId,
  type WorkerRuntime,
} from "./runtime.ts";
import { daemonToken, stateFileFor } from "./scope.ts";

export async function runDaemon(config: AdapterConfig): Promise<void> {
  await mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
  const lock = await acquireDaemonLock(config);
  const token = await daemonToken(config.dataRoot);
  const openCode = new ManagedOpenCode(config.openCodeUrl, config.openCodeBinary);
  const runtimes = new Map<string, HostedWorkerRuntime>();

  const runtimeFor = async (scope: Scope): Promise<WorkerRuntime> => {
    const stateFile = await stateFileFor(config.dataRoot, scope);
    let runtime = runtimes.get(stateFile);
    if (!runtime) {
      runtime = createWorkerRuntime({ client: openCode, stateFile });
      runtimes.set(stateFile, runtime);
    }
    return runtime;
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: config.daemonPort,
      // `wait` intentionally has no public timeout; the client may stay attached
      // for the full lifetime of a long-running OpenCode turn.
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
          return json({ name: "opencode-agent", version: VERSION, protocol: PROTOCOL_VERSION });
        }
        if (request.method !== "POST" || url.pathname !== "/command") {
          return json({ error: errorBody(new RuntimeError("NOT_FOUND", "Not found.")) }, 404);
        }
        if (request.headers.get("authorization") !== `Bearer ${token}`) {
          return json({ error: errorBody(new RuntimeError("UNAUTHORIZED", "Invalid daemon token.")) }, 401);
        }

        try {
          const declaredLength = Number(request.headers.get("content-length") ?? "0");
          if (declaredLength > config.maxRequestBytes) {
            throw new RuntimeError(
              "REQUEST_TOO_LARGE",
              `Command body exceeds ${config.maxRequestBytes} bytes.`,
            );
          }
          const source = await request.text();
          if (source.length > config.maxRequestBytes) {
            throw new RuntimeError(
              "REQUEST_TOO_LARGE",
              `Command body exceeds ${config.maxRequestBytes} bytes.`,
            );
          }
          const command = validateCommand(JSON.parse(source));
          const runtime = await runtimeFor(command.scope);
          return json(await dispatch(runtime, command));
        } catch (error) {
          const body = errorBody(error);
          return json({ error: body }, httpStatus(body.code));
        }
      },
    });
  } catch (error) {
    await lock.release();
    throw error;
  }

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    await Promise.allSettled([...runtimes.values()].map((runtime) => runtime[disposeRuntime]()));
    runtimes.clear();
    await openCode.stop();
    await lock.release();
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
  process.once("beforeExit", () => void stop());
  await new Promise<void>(() => {});
}

async function dispatch(runtime: WorkerRuntime, command: CommandRequest): Promise<unknown> {
  const input = command.input;
  switch (command.operation) {
    case "spawn":
      return runtime.spawn({
        task: stringField(input, "task"),
        directory: stringField(input, "directory"),
        label: optionalString(input, "label"),
        agent: optionalString(input, "agent"),
        model: optionalString(input, "model"),
      });
    case "list":
      return runtime.list();
    case "status":
      return runtime.status(agentIdField(input, "id"));
    case "followup":
      return runtime.followup({
        workerId: workerIdField(input, "workerId"),
        message: stringField(input, "message"),
        agent: optionalString(input, "agent"),
        model: optionalString(input, "model"),
      });
    case "wait":
      return runtime.wait(turnIdField(input, "turnId"));
    case "interrupt":
      return runtime.interrupt(workerIdField(input, "workerId"));
    case "close":
      return runtime.close(workerIdField(input, "workerId"));
  }
}

function validateCommand(value: unknown): CommandRequest {
  if (!value || typeof value !== "object") throw new RuntimeError("INVALID_USAGE", "Invalid daemon request.");
  const request = value as Partial<CommandRequest>;
  if (!request.scope || !request.operation || !request.input) {
    throw new RuntimeError("INVALID_USAGE", "Invalid daemon request.");
  }
  if (!OPERATIONS.includes(request.operation)) {
    throw new RuntimeError("INVALID_USAGE", "Invalid daemon operation.");
  }
  if (request.scope.scope !== "global" && request.scope.scope !== "project") {
    throw new RuntimeError("INVALID_USAGE", "Invalid daemon scope.");
  }
  if (request.scope.scope === "project" && typeof request.scope.projectRoot !== "string") {
    throw new RuntimeError("INVALID_USAGE", "Project scope requires a project root.");
  }
  return request as CommandRequest;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
  });
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || !result) {
    throw new RuntimeError("INVALID_USAGE", `${field} must be a non-empty string.`);
  }
  return result;
}

function optionalString(value: Record<string, unknown>, field: string): string | undefined {
  const result = value[field];
  if (result === undefined) return undefined;
  if (typeof result !== "string" || !result) {
    throw new RuntimeError("INVALID_USAGE", `${field} must be a non-empty string.`);
  }
  return result;
}

function workerIdField(value: Record<string, unknown>, field: string): WorkerId {
  const id = stringField(value, field);
  if (!id.startsWith("wrk_")) throw new RuntimeError("INVALID_ID", `${field} must be a Worker ID.`);
  return id as WorkerId;
}

function turnIdField(value: Record<string, unknown>, field: string): TurnId {
  const id = stringField(value, field);
  if (!id.startsWith("trn_")) throw new RuntimeError("INVALID_ID", `${field} must be a Turn ID.`);
  return id as TurnId;
}

function agentIdField(value: Record<string, unknown>, field: string): WorkerId | TurnId {
  const id = stringField(value, field);
  if (id.startsWith("wrk_") || id.startsWith("trn_")) return id as WorkerId | TurnId;
  throw new RuntimeError("INVALID_ID", `${field} must be a Worker ID or Turn ID.`);
}

function errorBody(error: unknown): ErrorBody {
  if (error instanceof RuntimeError) return error.toJSON();
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function httpStatus(code: string): number {
  if (code === "WORKER_NOT_FOUND" || code === "TURN_NOT_FOUND") return 404;
  if (code === "UNAUTHORIZED") return 401;
  if (code === "WORKER_CLOSED") return 409;
  if (code === "REQUEST_TOO_LARGE") return 413;
  if (code.startsWith("INVALID_")) return 400;
  return 500;
}

interface DaemonLock {
  release(): Promise<void>;
}

async function acquireDaemonLock(config: AdapterConfig): Promise<DaemonLock> {
  const path = join(config.dataRoot, "daemon.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readLock(path);
      if (owner && processIsAlive(owner.pid)) {
        throw new RuntimeError(
          "DAEMON_ALREADY_RUNNING",
          `Adapter daemon ${owner.pid} already owns ${path}.`,
        );
      }
      await unlink(path).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
      continue;
    }
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, port: config.daemonPort, protocol: PROTOCOL_VERSION }),
      "utf8",
    );
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await handle.close();
        await unlink(path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      },
    };
  }
  throw new RuntimeError("DAEMON_LOCKED", `Could not acquire adapter daemon lock ${path}.`);
}

async function readLock(path: string): Promise<{ pid: number } | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" ? { pid: value.pid } : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
