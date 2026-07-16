#!/usr/bin/env bun

import { runCli } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { runDaemon } from "./daemon.ts";

const config = loadConfig();

if (Bun.argv[2] === "__daemon") {
  try {
    await runDaemon(config);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "daemon_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
} else {
  await runCli(Bun.argv.slice(2), config);
}
