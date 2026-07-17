import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
}

export interface WorktreePort {
  create(projectRoot: string, name: string): Promise<WorktreeInfo>;
  merge(projectRoot: string, worktree: WorktreeInfo): Promise<void>;
  rollback(projectRoot: string, worktree: WorktreeInfo): Promise<void>;
}

export class WorktreeError extends Error {
  readonly retryable = false;

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class GitWorktrees implements WorktreePort {
  constructor(private readonly root: string) {}

  async create(projectRoot: string, name: string): Promise<WorktreeInfo> {
    validateName(name);
    const project = await canonicalDirectory(projectRoot, "INVALID_PROJECT");
    const repository = await git(project, "rev-parse", "--show-toplevel").catch((error) => {
      throw new WorktreeError("INVALID_PROJECT", messageOf(error));
    });
    if (normalize(await canonicalDirectory(repository, "INVALID_PROJECT")) !== normalize(project)) {
      throw new WorktreeError("INVALID_PROJECT", `${projectRoot} is not a Git worktree root.`);
    }

    const managedRoot = resolve(this.root, projectKey(project));
    await mkdir(managedRoot, { recursive: true, mode: 0o700 });
    const path = resolve(managedRoot, name);
    if (await exists(path)) throw new WorktreeError("WORKTREE_EXISTS", `Worktree ${name} already exists.`);

    const branch = `opencode-agent/${name}`;
    await git(project, "check-ref-format", "--branch", branch).catch(() => {
      throw new WorktreeError("INVALID_WORKTREE", `Worktree name ${JSON.stringify(name)} is not a valid Git branch name.`);
    });
    if (await git(project, "branch", "--list", branch)) {
      throw new WorktreeError("WORKTREE_EXISTS", `Branch ${branch} already exists.`);
    }

    try {
      await git(project, "worktree", "add", "-b", branch, path, "HEAD");
      return { name, path: await realpath(path), branch };
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw new WorktreeError("WORKTREE_CREATE_FAILED", messageOf(error));
    }
  }

  async rollback(projectRoot: string, worktree: WorktreeInfo): Promise<void> {
    const project = await canonicalDirectory(projectRoot, "INVALID_PROJECT");
    const { path: expectedPath, branch: expectedBranch } = this.managed(project, worktree);
    await git(project, "worktree", "remove", "--force", expectedPath).catch(() => undefined);
    await rm(expectedPath, { recursive: true, force: true });
    await git(project, "branch", "-D", expectedBranch).catch(() => undefined);
  }

  async merge(projectRoot: string, worktree: WorktreeInfo): Promise<void> {
    const project = await canonicalDirectory(projectRoot, "INVALID_PROJECT");
    const managed = this.managed(project, worktree);
    if (await git(project, "status", "--porcelain")) {
      throw new WorktreeError("DIRTY_TARGET", "The project checkout has uncommitted changes.");
    }

    if (await git(managed.path, "status", "--porcelain")) {
      await git(managed.path, "add", "-A");
      await git(managed.path, "commit", "-m", `opencode-agent: merge ${worktree.name}`).catch((error) => {
        throw new WorktreeError("WORKTREE_COMMIT_FAILED", messageOf(error));
      });
    }

    try {
      await git(project, "merge", "--no-edit", managed.branch);
    } catch (error) {
      await git(project, "merge", "--abort").catch(() => undefined);
      throw new WorktreeError("WORKTREE_MERGE_FAILED", messageOf(error));
    }
  }

  private managed(projectRoot: string, worktree: WorktreeInfo): { path: string; branch: string } {
    validateName(worktree.name);
    const path = resolve(this.root, projectKey(projectRoot), worktree.name);
    const branch = `opencode-agent/${worktree.name}`;
    if (normalize(resolve(worktree.path)) !== normalize(path) || worktree.branch !== branch) {
      throw new WorktreeError("INVALID_WORKTREE", "Refusing to operate on an unmanaged worktree.");
    }
    return { path, branch };
  }
}

function validateName(name: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ||
    name.includes("..") ||
    name.endsWith(".")
  ) {
    throw new WorktreeError(
      "INVALID_WORKTREE",
      "Worktree name must be 1-64 letters, numbers, dots, underscores, or hyphens and cannot contain '..'.",
    );
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args.join(" ")} exited ${exitCode}.`);
  }
  return stdout.trim();
}

async function canonicalDirectory(path: string, code: string): Promise<string> {
  try {
    const canonical = await realpath(resolve(path));
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new WorktreeError(code, `Directory ${JSON.stringify(path)} does not exist.`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function normalize(path: string): string {
  return platform() === "win32" ? path.toLowerCase() : path;
}

function projectKey(path: string): string {
  return new Bun.CryptoHasher("sha256").update(normalize(path)).digest("hex").slice(0, 24);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
