import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorktrees, WorktreeError } from "./worktree.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("a named worktree gets an isolated branch and can be rolled back", async () => {
  const project = await temporaryDirectory("opencode-agent-project-");
  const managed = await temporaryDirectory("opencode-agent-worktrees-");
  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "tests@opencode-agent.local");
  await git(project, "config", "user.name", "opencode-agent tests");
  await writeFile(join(project, "tracked.txt"), "main\n");
  await git(project, "add", "tracked.txt");
  await git(project, "commit", "-m", "initial");

  const worktrees = new GitWorktrees(managed);
  const created = await worktrees.create(project, "parser");

  expect(created).toMatchObject({
    name: "parser",
    branch: "opencode-agent/parser",
  });
  expect(await git(created.path, "branch", "--show-current")).toBe(created.branch);
  expect((await Bun.file(join(created.path, "tracked.txt")).text()).trim()).toBe("main");
  await expect(worktrees.create(project, "parser")).rejects.toBeInstanceOf(WorktreeError);

  await worktrees.rollback(project, created);
  expect(await Bun.file(created.path).exists()).toBe(false);
  expect(await git(project, "branch", "--list", created.branch)).toBe("");
});

test("merge commits worker changes into a clean project checkout", async () => {
  const project = await temporaryDirectory("opencode-agent-merge-project-");
  const managed = await temporaryDirectory("opencode-agent-merge-worktrees-");
  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "tests@opencode-agent.local");
  await git(project, "config", "user.name", "opencode-agent tests");
  await writeFile(join(project, "tracked.txt"), "main\n");
  await git(project, "add", "tracked.txt");
  await git(project, "commit", "-m", "initial");

  const worktrees = new GitWorktrees(managed);
  const created = await worktrees.create(project, "parser");
  await writeFile(join(created.path, "tracked.txt"), "worker\n");
  await writeFile(join(created.path, "new.txt"), "new\n");

  await worktrees.merge(project, created);

  expect((await Bun.file(join(project, "tracked.txt")).text()).trim()).toBe("worker");
  expect((await Bun.file(join(project, "new.txt")).text()).trim()).toBe("new");
  expect(await git(project, "status", "--porcelain")).toBe("");
  expect(await git(project, "log", "-1", "--format=%s")).toBe("opencode-agent: merge parser");
});

test("merge refuses to touch a dirty project checkout", async () => {
  const project = await temporaryDirectory("opencode-agent-dirty-project-");
  const managed = await temporaryDirectory("opencode-agent-dirty-worktrees-");
  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "tests@opencode-agent.local");
  await git(project, "config", "user.name", "opencode-agent tests");
  await writeFile(join(project, "tracked.txt"), "main\n");
  await git(project, "add", "tracked.txt");
  await git(project, "commit", "-m", "initial");

  const worktrees = new GitWorktrees(managed);
  const created = await worktrees.create(project, "parser");
  await writeFile(join(created.path, "tracked.txt"), "worker\n");
  await writeFile(join(project, "local.txt"), "local\n");

  await expect(worktrees.merge(project, created)).rejects.toMatchObject({ code: "DIRTY_TARGET" });
  expect(await Bun.file(join(project, "tracked.txt")).text()).toBe("main\n");
});

test("worktree names cannot escape the managed directory", async () => {
  const managed = await temporaryDirectory("opencode-agent-worktrees-");
  const worktrees = new GitWorktrees(managed);
  await expect(worktrees.create(process.cwd(), "../escape")).rejects.toMatchObject({
    code: "INVALID_WORKTREE",
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
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
