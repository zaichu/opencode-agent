import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import type { AdapterConfig } from "./config.ts";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, VERSION } from "./config.ts";
import type { CommandRequest, ErrorBody } from "./protocol.ts";
import { RuntimeError } from "./runtime.ts";
import { daemonToken, resolveProject } from "./scope.ts";

interface ParsedArgs {
  options: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

export async function runCli(argv: string[], config: AdapterConfig): Promise<void> {
  const parsed = parseArgs(argv);
  const command = parsed.positionals.shift();
  if (command === "version" || parsed.flags.has("version")) {
    console.log(VERSION);
    return;
  }
  if (!command || parsed.flags.has("help")) {
    console.log(help());
    return;
  }

  const projectRoot = await resolveProject({
    project: parsed.options.get("project"),
    cwd: process.cwd(),
  });
  const request = await makeRequest(command, parsed, projectRoot);
  const result = await callDaemon(request, config);
  printResult(result, parsed.flags.has("text"));
}

async function makeRequest(
  command: string,
  parsed: ParsedArgs,
  projectRoot: string,
): Promise<CommandRequest> {
  rejectUnusedOptions(parsed, command);

  switch (command) {
    case "spawn": {
      const worktree = parsed.options.get("worktree");
      return {
        operation: "spawn",
        input: {
          task: await readPrompt(parsed),
          projectRoot,
          worktree,
          label: parsed.options.get("label"),
          agent: parsed.options.get("agent"),
          model: parsed.options.get("model"),
        },
      };
    }
    case "list":
      requirePositionals(parsed, 0, "list");
      if (parsed.flags.has("all") && parsed.options.has("project")) {
        throw usage("--all and --project cannot be used together.");
      }
      return { operation: "list", input: { projectRoot: parsed.flags.has("all") ? undefined : projectRoot } };
    case "status":
      return { operation: "status", input: { id: oneId(parsed, "status") } };
    case "followup": {
      const workerId = parsed.positionals.shift();
      if (!workerId) throw usage("followup requires a Worker ID.");
      return {
        operation: "followup",
        input: {
          workerId,
          message: await readPrompt(parsed),
          agent: parsed.options.get("agent"),
          model: parsed.options.get("model"),
        },
      };
    }
    case "wait":
      return { operation: "wait", input: { turnId: oneId(parsed, "wait") } };
    case "interrupt":
      return { operation: "interrupt", input: { workerId: oneId(parsed, "interrupt") } };
    case "merge":
      return { operation: "merge", input: { workerId: oneId(parsed, "merge") } };
    case "close":
      return { operation: "close", input: { workerId: oneId(parsed, "close") } };
    default:
      throw usage(`Unknown command ${JSON.stringify(command)}.`);
  }
}

async function callDaemon(command: CommandRequest, config: AdapterConfig): Promise<unknown> {
  const token = await daemonToken(config.dataRoot);
  let response = await daemonFetch(command, token, config).catch(() => undefined);
  if (!response) {
    await startDaemon(config);
    response = await daemonFetch(command, token, config);
  }

  assertProtocol(response);
  const body = (await response.json()) as { error?: unknown };
  if (!response.ok && body && typeof body === "object" && "error" in body) {
    const remote = body.error as Partial<ErrorBody>;
    throw new RuntimeError(
      typeof remote.code === "string" ? remote.code : "DAEMON_FAILURE",
      typeof remote.message === "string" ? remote.message : "The adapter daemon failed.",
      remote.retryable === true,
    );
  }
  return body;
}

function daemonFetch(command: CommandRequest, token: string, config: AdapterConfig): Promise<Response> {
  return fetch(`${config.daemonUrl}/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    },
    body: JSON.stringify(command),
  });
}

async function startDaemon(config: AdapterConfig): Promise<void> {
  await mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
  const entry = join(import.meta.dir, "index.ts");
  const log = Bun.file(join(config.dataRoot, "daemon.log"));
  const child = Bun.spawn({
    cmd: [process.execPath, entry, "__daemon"],
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: log,
    stderr: log,
    env: process.env,
  });
  child.unref();

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${config.daemonUrl}/health`);
      assertProtocol(response);
      const health = (await response.json()) as {
        name?: unknown;
        protocol?: unknown;
      };
      if (
        response.ok &&
        health.name === "opencode-agent" &&
        health.protocol === PROTOCOL_VERSION
      ) {
        return;
      }
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "DAEMON_VERSION_MISMATCH") throw error;
    }
    await Bun.sleep(50);
  }
  throw new RuntimeError(
    "DAEMON_UNAVAILABLE",
    `The adapter daemon did not start. See ${join(config.dataRoot, "daemon.log")}.`,
    true,
  );
}

function assertProtocol(response: Response): void {
  const received = response.headers.get(PROTOCOL_HEADER);
  if (received !== String(PROTOCOL_VERSION)) {
    throw new RuntimeError(
      "DAEMON_VERSION_MISMATCH",
      `The running daemon uses protocol ${received ?? "unknown"}; this CLI requires ${PROTOCOL_VERSION}.`,
    );
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  try {
    const parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        worktree: { type: "string" }, label: { type: "string" }, agent: { type: "string" },
        model: { type: "string" }, file: { type: "string" }, project: { type: "string" },
        stdin: { type: "boolean" }, text: { type: "boolean" }, all: { type: "boolean" },
        help: { type: "boolean" }, version: { type: "boolean" },
      },
    });
    const options = new Map<string, string>();
    const flags = new Set<string>();
    for (const [name, value] of Object.entries(parsed.values)) {
      if (typeof value === "string") options.set(name, value);
      else if (value === true) flags.add(name);
    }
    return { options, flags, positionals: parsed.positionals };
  } catch (error) {
    throw usage(error instanceof Error ? error.message : String(error));
  }
}

function rejectUnusedOptions(parsed: ParsedArgs, command: string): void {
  const allowed: Record<string, Set<string>> = {
    spawn: new Set(["project", "worktree", "label", "agent", "model", "file"]),
    followup: new Set(["agent", "model", "file"]),
    list: new Set(["project"]),
    status: new Set(),
    wait: new Set(),
    interrupt: new Set(),
    merge: new Set(),
    close: new Set(),
  };
  const commandOptions = allowed[command];
  if (!commandOptions) return;
  for (const option of parsed.options.keys()) {
    if (!commandOptions.has(option)) throw usage(`--${option} cannot be used with ${command}.`);
  }
  if (parsed.flags.has("stdin") && command !== "spawn" && command !== "followup") {
    throw usage(`--stdin cannot be used with ${command}.`);
  }
  if (parsed.flags.has("all") && command !== "list") {
    throw usage(`--all cannot be used with ${command}.`);
  }
}

async function readPrompt(parsed: ParsedArgs): Promise<string> {
  const fromFile = parsed.options.get("file");
  const fromStdin = parsed.flags.has("stdin");
  const fromArgs = parsed.positionals.length > 0;
  const sources = Number(Boolean(fromFile)) + Number(fromStdin) + Number(fromArgs);
  if (sources !== 1) throw usage("Supply exactly one prompt: arguments, --file, or --stdin.");

  const value = fromFile
    ? await readPromptFile(fromFile)
    : fromStdin
      ? await new Response(Bun.stdin.stream()).text()
      : parsed.positionals.join(" ");
  parsed.positionals = [];
  if (!value.trim()) throw usage("Prompt cannot be empty.");
  return value;
}

async function readPromptFile(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  try {
    return await readFile(resolvedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RuntimeError(
        "PROMPT_FILE_NOT_FOUND",
        `Prompt file ${JSON.stringify(resolvedPath)} does not exist.`,
      );
    }
    throw error;
  }
}

function oneId(parsed: ParsedArgs, command: string): string {
  requirePositionals(parsed, 1, command);
  return parsed.positionals[0]!;
}

function requirePositionals(parsed: ParsedArgs, count: number, command: string): void {
  if (parsed.positionals.length !== count) {
    throw usage(`${command} expects ${count} argument${count === 1 ? "" : "s"}.`);
  }
}

function printResult(value: unknown, text: boolean): void {
  if (!text) {
    console.log(JSON.stringify(value));
    return;
  }
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") {
    console.log(value.text);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function usage(message: string): RuntimeError {
  return new RuntimeError("INVALID_USAGE", message);
}

function help(): string {
  return `opencode-agent ${VERSION}

Usage:
  opencode-agent spawn [options] <task>
  opencode-agent list [options]
  opencode-agent status [options] <worker-or-turn-id>
  opencode-agent followup [options] <worker-id> <message>
  opencode-agent wait [options] <turn-id>
  opencode-agent interrupt [options] <worker-id>
  opencode-agent merge [options] <worker-id>
  opencode-agent close [options] <worker-id>

Project:
  --project <path>         Project to work in (default: current Git root)
  --all                    List workers across every project

Spawn:
  --worktree <name>        Create an isolated Git worktree and branch
  --label <label>          Optional display label; duplicates are allowed
  --agent <agent>          OpenCode agent
  --model <provider/model> OpenCode model

Prompt input:
  --file <path>            Read the task or follow-up from a file
  --stdin                  Read the task or follow-up from stdin

Output:
  JSON is the default. Use --text for human-readable output.`;
}
