import assert from "node:assert/strict";
import { createLiveTerminalFixture } from "./terminal-suite-support.ts";

const executable = Bun.which("opencode-agent");
if (!executable) {
  throw new Error("opencode-agent is not installed on PATH. Run `bun link` from this project first.");
}

const openCodeUrl = Bun.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const agent = Bun.env.OPENCODE_AGENT_TEST_AGENT;
const model = Bun.env.OPENCODE_AGENT_TEST_MODEL;
const spawnOptions = [
  ...(agent ? ["--agent", agent] : []),
  ...(model ? ["--model", model] : []),
];

console.log(`LIVE OpenCode smoke test using ${openCodeUrl}${model ? ` with ${model}` : ""}.`);
console.log("LIVE This test invokes a real model and may incur provider cost.");

await using fixture = await createLiveTerminalFixture(executable, process.cwd(), openCodeUrl);
let workerId: string | undefined;
try {
  const spawned = await fixture.json([
    "spawn",
    ...spawnOptions,
    "--label",
    "live-memory-smoke",
    "Do not modify files or run tools. Remember LIVE-BLUE-7392 and reply exactly READY.",
  ]);
  if (typeof spawned.workerId !== "string" || typeof spawned.turnId !== "string") {
    throw new Error(`spawn returned invalid IDs: ${JSON.stringify(spawned)}`);
  }
  const activeWorkerId = spawned.workerId;
  workerId = activeWorkerId;
  assert.match(activeWorkerId, /^wrk_/);
  assert.match(spawned.turnId, /^trn_/);
  console.log(`PASS spawned ${activeWorkerId} with turn ${spawned.turnId}`);

  const first = await fixture.json(["wait", spawned.turnId]);
  assert.equal(first.status, "completed", JSON.stringify(first));
  assert.equal(first.text.trim(), "READY");
  console.log("PASS initial live turn completed");

  const followup = await fixture.json([
    "followup",
    activeWorkerId,
    "What code did I ask you to remember? Reply with only the code.",
  ]);
  const second = await fixture.json(["wait", followup.turnId]);
  assert.equal(second.status, "completed", JSON.stringify(second));
  assert.equal(second.text.trim(), "LIVE-BLUE-7392");
  console.log("PASS live follow-up retained worker context");
} finally {
  if (workerId) await fixture.json(["close", workerId]).catch(() => undefined);
}
