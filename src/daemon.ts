import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterConfig } from "./config.ts";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, VERSION } from "./config.ts";
import { ManagedOpenCode } from "./opencode.ts";
import { ProtocolError, decodeCommand, type DecodedCommand, type ErrorBody } from "./protocol.ts";
import {
  RuntimeError,
  createWorkerRuntime,
  type WorkerRuntime,
} from "./runtime.ts";
import { daemonToken, stateFileFor } from "./scope.ts";
import { GitWorktrees } from "./worktree.ts";

export async function runDaemon(config: AdapterConfig): Promise<void> {
  await mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
  const lock = await acquireDaemonLock(config);
  const token = await daemonToken(config.dataRoot);
  const openCode = new ManagedOpenCode(config.openCodeUrl, config.openCodeBinary);
  const runtime = createWorkerRuntime({
    client: openCode,
    stateFile: await stateFileFor(config.dataRoot),
    worktrees: new GitWorktrees(join(config.dataRoot, "worktrees")),
  });

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
          const bytes = await request.arrayBuffer();
          if (bytes.byteLength > config.maxRequestBytes) {
            throw new RuntimeError(
              "REQUEST_TOO_LARGE",
              `Command body exceeds ${config.maxRequestBytes} bytes.`,
            );
          }
          const source = new TextDecoder().decode(bytes);
          const command = decodeCommand(JSON.parse(source));
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
    await runtime[Symbol.asyncDispose]();
    await openCode.stop();
    await lock.release();
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
  process.once("beforeExit", () => void stop());
  await new Promise<void>(() => {});
}

async function dispatch(runtime: WorkerRuntime, command: DecodedCommand): Promise<unknown> {
  switch (command.operation) {
    case "spawn":
      return runtime.spawn(command.input);
    case "list":
      return runtime.list(command.input.projectRoot);
    case "status":
      return runtime.status(command.input.id);
    case "followup":
      return runtime.followup(command.input);
    case "wait":
      return runtime.wait(command.input.turnId);
    case "interrupt":
      return runtime.interrupt(command.input.workerId);
    case "merge":
      return runtime.merge(command.input.workerId);
    case "close":
      return runtime.close(command.input.workerId);
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
  });
}


function errorBody(error: unknown): ErrorBody {
  if (error instanceof RuntimeError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.retryable ? { retryable: true as const } : {}),
    };
  }
  if (error instanceof ProtocolError) return { code: error.code, message: error.message };
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

function httpStatus(code: string): number {
  if (code === "WORKER_NOT_FOUND" || code === "TURN_NOT_FOUND") return 404;
  if (code === "UNAUTHORIZED") return 401;
  if (
    code === "WORKER_CLOSED" ||
    code === "WORKER_BUSY" ||
    code === "WORKTREE_REQUIRED" ||
    code === "WORKTREE_EXISTS" ||
    code === "DIRTY_TARGET" ||
    code === "WORKTREE_COMMIT_FAILED" ||
    code === "WORKTREE_MERGE_FAILED"
  ) return 409;
  if (code === "REQUEST_TOO_LARGE") return 413;
  if (code.startsWith("INVALID_")) return 400;
  return 500;
}

async function acquireDaemonLock(
  config: AdapterConfig,
): Promise<{ release(): Promise<void> }> {
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
    await handle.writeFile(JSON.stringify({ pid: process.pid }), "utf8");
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
