import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AdapterConfig } from "./config.ts";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, VERSION } from "./config.ts";
import type { CommandRequest, ErrorBody, Scope } from "./protocol.ts";
import { RuntimeError } from "./runtime.ts";
import { daemonToken, resolveScope } from "./scope.ts";

interface ParsedArgs {
  options: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

export async function runCli(argv: string[], config: AdapterConfig): Promise<void> {
  try {
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

    const scope = await resolveScope({
      scope: parsed.options.get("scope"),
      project: parsed.options.get("project"),
      cwd: process.cwd(),
    });
    const request = await makeRequest(command, parsed, scope);
    const result = await callDaemon(request, config);
    printResult(result, parsed.flags.has("text"));
  } catch (error) {
    const body = errorBody(error);
    console.error(JSON.stringify({ error: body }));
    process.exitCode = exitCode(body.code);
  }
}

async function makeRequest(
  command: string,
  parsed: ParsedArgs,
  scope: Scope,
): Promise<CommandRequest> {
  rejectUnusedOptions(parsed, command);

  switch (command) {
    case "spawn":
      return {
        scope,
        operation: "spawn",
        input: compact({
          task: await readPrompt(parsed),
          directory: resolve(parsed.options.get("dir") ?? process.cwd()),
          label: parsed.options.get("label"),
          agent: parsed.options.get("agent"),
          model: parsed.options.get("model"),
        }),
      };
    case "list":
      requirePositionals(parsed, 0, "list");
      return { scope, operation: "list", input: {} };
    case "status":
      return { scope, operation: "status", input: { id: oneId(parsed, "status") } };
    case "followup": {
      const workerId = parsed.positionals.shift();
      if (!workerId) throw usage("followup requires a Worker ID.");
      return {
        scope,
        operation: "followup",
        input: compact({
          workerId,
          message: await readPrompt(parsed),
          agent: parsed.options.get("agent"),
          model: parsed.options.get("model"),
        }),
      };
    }
    case "wait":
      return { scope, operation: "wait", input: { turnId: oneId(parsed, "wait") } };
    case "interrupt":
      return { scope, operation: "interrupt", input: { workerId: oneId(parsed, "interrupt") } };
    case "close":
      return { scope, operation: "close", input: { workerId: oneId(parsed, "close") } };
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
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  const valueOptions = new Set(["dir", "label", "agent", "model", "file", "scope", "project"]);
  const flagOptions = new Set(["stdin", "text", "help", "version"]);

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    if (valueOptions.has(name)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw usage(`--${name} requires a value.`);
      if (options.has(name)) throw usage(`--${name} can only be supplied once.`);
      options.set(name, value);
    } else if (flagOptions.has(name)) {
      flags.add(name);
    } else {
      throw usage(`Unknown option --${name}.`);
    }
  }
  return { options, flags, positionals };
}

function rejectUnusedOptions(parsed: ParsedArgs, command: string): void {
  const common = new Set(["scope", "project"]);
  const allowed: Record<string, Set<string>> = {
    spawn: new Set([...common, "dir", "label", "agent", "model", "file"]),
    followup: new Set([...common, "agent", "model", "file"]),
    list: common,
    status: common,
    wait: common,
    interrupt: common,
    close: common,
  };
  const commandOptions = allowed[command];
  if (!commandOptions) return;
  for (const option of parsed.options.keys()) {
    if (!commandOptions.has(option)) throw usage(`--${option} cannot be used with ${command}.`);
  }
  if (parsed.flags.has("stdin") && command !== "spawn" && command !== "followup") {
    throw usage(`--stdin cannot be used with ${command}.`);
  }
}

async function readPrompt(parsed: ParsedArgs): Promise<string> {
  const fromFile = parsed.options.get("file");
  const fromStdin = parsed.flags.has("stdin");
  const fromArgs = parsed.positionals.length > 0;
  const sources = Number(Boolean(fromFile)) + Number(fromStdin) + Number(fromArgs);
  if (sources !== 1) throw usage("Supply exactly one prompt: arguments, --file, or --stdin.");

  const value = fromFile
    ? await readFile(resolve(fromFile), "utf8")
    : fromStdin
      ? await new Response(Bun.stdin.stream()).text()
      : parsed.positionals.join(" ");
  parsed.positionals = [];
  if (!value.trim()) throw usage("Prompt cannot be empty.");
  return value;
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

function errorBody(error: unknown): ErrorBody {
  if (error instanceof RuntimeError) return error.toJSON();
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function usage(message: string): RuntimeError {
  return new RuntimeError("INVALID_USAGE", message);
}

function exitCode(code: string): number {
  if (code === "INVALID_USAGE" || code === "INVALID_DIRECTORY" || code === "INVALID_ID") return 2;
  if (code === "WORKER_NOT_FOUND" || code === "WORKER_CLOSED") return 3;
  if (code === "TURN_NOT_FOUND") return 4;
  if (code === "DAEMON_UNAVAILABLE" || code === "DAEMON_VERSION_MISMATCH") return 7;
  return 5;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
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
  opencode-agent close [options] <worker-id>

Scope:
  --scope project|global   State scope (default: project)
  --project <path>         Project registry to use from another directory

Spawn:
  --dir <path>             Worker directory (default: current directory)
  --label <label>          Optional display label; duplicates are allowed
  --agent <agent>          OpenCode agent
  --model <provider/model> OpenCode model

Prompt input:
  --file <path>            Read the task or follow-up from a file
  --stdin                  Read the task or follow-up from stdin

Output:
  JSON is the default. Use --text for human-readable output.`;
}
