import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RuntimeError } from "./runtime.ts";

export async function resolveProject(input: {
  project?: string;
  cwd: string;
}): Promise<string> {
  return findProjectRoot(input.project ?? input.cwd);
}

export async function stateFileFor(dataRoot: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  return join(dataRoot, "state.sqlite");
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
