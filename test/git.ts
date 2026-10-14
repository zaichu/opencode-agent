import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function initializeRepository(root: string): Promise<void> {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "tests@opencode-agent.local");
  await git(root, "config", "user.name", "opencode-agent tests");
  await writeFile(join(root, "tracked.txt"), "main\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "initial");
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}
