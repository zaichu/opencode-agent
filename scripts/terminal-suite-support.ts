import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeOpenCode } from "../test/fake-opencode.ts";

export interface TerminalFixture extends AsyncDisposable {
  cwd: string;
  json(args: string[]): Promise<Record<string, any>>;
  failure(args: string[]): Promise<{ exitCode: number; body: Record<string, any> }>;
}

export async function createTerminalFixture(executable: string): Promise<TerminalFixture> {
  const root = await mkdtemp(join(tmpdir(), "opencode-agent-terminal-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "opencode-agent-state-"));
  await initializeRepository(root);
  const openCode = startFakeOpenCode();
  return createHostedTerminalFixture({
    executable,
    cwd: root,
    dataRoot,
    openCodeUrl: openCode.url,
    async dispose() {
      openCode.stop();
      await removeTree(dataRoot);
      await removeTree(root);
    },
  });
}

async function initializeRepository(root: string): Promise<void> {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "tests@opencode-agent.local");
  await git(root, "config", "user.name", "opencode-agent tests");
  await writeFile(join(root, "tracked.txt"), "main\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "initial");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

export async function createLiveTerminalFixture(
  executable: string,
  cwd: string,
  openCodeUrl: string,
): Promise<TerminalFixture> {
  const dataRoot = await mkdtemp(join(tmpdir(), "opencode-agent-live-"));
  return createHostedTerminalFixture({
    executable,
    cwd,
    dataRoot,
    openCodeUrl,
    async dispose() {
      await removeTree(dataRoot);
    },
  });
}

async function createHostedTerminalFixture(input: {
  executable: string;
  cwd: string;
  dataRoot: string;
  openCodeUrl: string;
  dispose(): Promise<void>;
}): Promise<TerminalFixture> {
  const daemonPort = availablePort();
  const env = {
    ...process.env,
    OPENCODE_AGENT_HOME: input.dataRoot,
    OPENCODE_AGENT_PORT: String(daemonPort),
    OPENCODE_URL: input.openCodeUrl,
  };
  const daemon = Bun.spawn({
    cmd: [input.executable, "__daemon"],
    cwd: input.cwd,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForHealth(daemonPort, daemon);
  } catch (error) {
    daemon.kill();
    await daemon.exited;
    await input.dispose();
    throw error;
  }

  const run = async (args: string[]): Promise<CommandResult> => {
    const child = Bun.spawn({
      cmd: [input.executable, ...args],
      cwd: input.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  };

  return {
    cwd: input.cwd,
    async json(args: string[]): Promise<Record<string, any>> {
      const result = await run(args);
      if (result.exitCode !== 0) {
        throw new Error(`opencode-agent ${args[0] ?? ""} exited ${result.exitCode}: ${result.stderr}`);
      }
      return JSON.parse(result.stdout) as Record<string, any>;
    },

    async failure(args: string[]): Promise<{ exitCode: number; body: Record<string, any> }> {
      const result = await run(args);
      if (result.exitCode === 0) throw new Error(`opencode-agent ${args[0] ?? ""} unexpectedly succeeded.`);
      return { exitCode: result.exitCode, body: JSON.parse(result.stderr) as Record<string, any> };
    },

    async [Symbol.asyncDispose](): Promise<void> {
      await stopDaemon(input.dataRoot);
      if (daemon.exitCode === null) daemon.kill();
      await daemon.exited;
      await input.dispose();
    },
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function availablePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (!port) throw new Error("Bun did not allocate a terminal-test port.");
  return port;
}

async function waitForHealth(port: number, daemon: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) {
      const stderr = daemon.stderr
        ? await new Response(daemon.stderr as ReadableStream<Uint8Array>).text()
        : "";
      throw new Error(`opencode-agent daemon exited ${daemon.exitCode}: ${stderr.trim()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error("opencode-agent daemon did not become healthy.");
}

async function stopDaemon(dataRoot: string): Promise<void> {
  const lockPath = join(dataRoot, "daemon.lock");
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    if (typeof lock.pid === "number") process.kill(lock.pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") throw error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await readFile(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    }
    await Bun.sleep(20);
  }
}
async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 19) throw error;
      await Bun.sleep(25);
    }
  }
}
