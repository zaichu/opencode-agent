---
name: use-opencode-agent
description: Delegate repository work to persistent OpenCode workers through the opencode-agent CLI. Use when an AI coding harness should spawn an OpenCode subagent, monitor or wait for its turn, continue the same conversation, merge isolated work, interrupt active work, run parallel workers, or close a worker.
---

# Use OpenCode Agent

Use `opencode-agent` as a persistent subagent. Keep the parent agent responsible for task scope, validation, and acceptance.

## Workflow

1. Spawn a worker with a bounded task and completion criteria:

   ```text
   opencode-agent spawn --project <repo> "Inspect the parser for correctness bugs and report evidence."
   ```

   Omit `--project` when already inside the repository. Add `--worktree <name>` to create a new isolated checkout. For substantial prompts, use `--file <path>` or `--stdin`.

2. Retain both returned IDs:

   ```json
   {"workerId":"wrk_...","turnId":"trn_...","status":"running"}
   ```

   Use the Worker ID for the persistent conversation. Use the Turn ID for one task execution.

   Validate that `workerId` begins with `wrk_`, `turnId` begins with `trn_`, and `status` is `"running"` before tracking the turn. Do not invent missing IDs.

3. Check without blocking, or wait for completion:

   ```text
   opencode-agent status trn_...
   opencode-agent wait trn_...
   ```

   Prefer polling `status` for long work so the parent remains responsive and can interrupt the worker. Use `wait` when blocking is acceptable.

4. Continue the same worker and retain the new Turn ID:

   ```text
   opencode-agent followup wrk_... "Implement the highest-severity fix and run its tests."
   ```

   After `followup`, require valid Worker and Turn IDs and accept `status: "queued"` or `"running"` before tracking the new turn. Turns within one worker run FIFO.

5. Merge isolated work, stop active work, or end the worker:

   ```text
   opencode-agent interrupt wrk_...
   opencode-agent merge wrk_...
   opencode-agent close wrk_...
   ```

## Rules

* Manage workers by ID, not label; labels may be duplicated.
* Worker and Turn IDs work from any directory. Use `--project <path>` only when spawning outside the target repository or filtering `list`; use `list --all` for every project.
* Omit `--agent` and `--model` to use the existing OpenCode defaults. Set them only when the task requires a particular agent or model.
* Parse stdout as JSON. Errors are JSON on stderr with a nonzero exit code. Retry only when `error.retryable` is `true`.
* There is no `result` command. Read completed output with `status <turn-id>` or `wait <turn-id>`.
* After a caller timeout, check the existing Turn ID with `status`; do not spawn a duplicate worker.
* Send a focused follow-up when work is incomplete or validation fails.
* Inspect unexpected file changes and never discard unknown changes automatically.
* Independently inspect changes and run relevant validation before accepting write-capable work.
* Give concurrent write-capable workers separate Git worktrees when their file ownership may overlap.
* After validating an idle managed-worktree worker, use `merge <worker-id>`. It commits and merges the changes while preserving the worker and worktree.
* Close workers when no further follow-up is needed.
