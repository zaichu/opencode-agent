import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RuntimeError } from "./runtime.ts";
import type { Scope } from "./protocol.ts";

export async function resolveScope(input: {
  scope?: string;
  project?: string;
  cwd: string;
}): Promise<Scope> {
  const value = input.scope ?? "project";
  if (value === "global") {
    if (input.project) throw new RuntimeError("INVALID_USAGE", "--project cannot be used with --scope global.");
    return { scope: "global" };
  }
  if (value !== "project") throw new RuntimeError("INVALID_USAGE", "--scope must be project or global.");
  return {
    scope: "project",
    projectRoot: input.project
      ? await canonicalDirectory(input.project)
      : await findProjectRoot(input.cwd),
  };
}

export async function stateFileFor(dataRoot: string, scope: Scope): Promise<string> {
  if (scope.scope === "global") {
    const directory = join(dataRoot, "global");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return join(directory, "state.sqlite");
  }

  const root = await canonicalDirectory(scope.projectRoot);
  const key = new Bun.CryptoHasher("sha256").update(normalizePath(root)).digest("hex").slice(0, 24);
  const directory = join(dataRoot, "projects", key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = join(directory, "project.json");
  try {
    await writeFile(metadata, JSON.stringify({ root }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return join(directory, "state.sqlite");
}

export async function daemonToken(dataRoot: string): Promise<string> {
  const tokenFile = join(dataRoot, "daemon.token");
  const existing = await readNonEmpty(tokenFile);
  if (existing) return existing;

  await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID() + crypto.randomUUID();
  try {
    const file = await open(tokenFile, "wx", 0o600);
    try {
      await file.writeFile(token, "utf8");
    } finally {
      await file.close();
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    for (let attempt = 0; attempt < 20; attempt++) {
      const raced = await readNonEmpty(tokenFile);
      if (raced) return raced;
      await Bun.sleep(10);
    }
    throw new RuntimeError("TOKEN_FAILURE", `Daemon token ${tokenFile} remained empty after creation.`);
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    const canonical = await realpath(resolve(path));
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new RuntimeError("INVALID_DIRECTORY", `Directory ${JSON.stringify(path)} does not exist.`);
  }
}

async function findProjectRoot(start: string): Promise<string> {
  let current = await canonicalDirectory(start);
  const fallback = current;
  while (true) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return fallback;
      current = parent;
    }
  }
}

async function readNonEmpty(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function normalizePath(path: string): string {
  return platform() === "win32" ? path.toLowerCase() : path;
}
