#!/usr/bin/env bun

import { runCli } from "./cli.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import type { ErrorBody } from "./protocol.ts";
import { RuntimeError } from "./runtime.ts";

const daemonMode = Bun.argv[2] === "__daemon";
try {
  const config = loadConfig();
  if (daemonMode) {
    await runDaemon(config);
  } else {
    await runCli(Bun.argv.slice(2), config);
  }
} catch (error) {
  if (daemonMode) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "daemon_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } else {
    const body = errorBody(error);
    console.error(JSON.stringify({ error: body }));
    process.exitCode = exitCode(body.code);
  }
}

function errorBody(error: unknown): ErrorBody {
  if (error instanceof RuntimeError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.retryable ? { retryable: true as const } : {}),
    };
  }
  if (error instanceof ConfigError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

function exitCode(code: string): number {
  if (
    code === "INVALID_USAGE" ||
    code === "INVALID_DIRECTORY" ||
    code === "INVALID_ID" ||
    code === "INVALID_CONFIG" ||
    code === "PROMPT_FILE_NOT_FOUND"
  ) {
    return 2;
  }
  if (code === "WORKER_NOT_FOUND" || code === "WORKER_CLOSED") return 3;
  if (code === "TURN_NOT_FOUND") return 4;
  if (code === "DAEMON_UNAVAILABLE" || code === "DAEMON_VERSION_MISMATCH") return 7;
  return 5;
}
