---
name: use-opencode-agent
description: Delegate repository work to persistent OpenCode workers through the opencode-agent CLI. Use when an AI coding harness should spawn an OpenCode subagent, monitor or wait for its turn, continue the same conversation, interrupt active work, run parallel workers, or close a worker.
---

# Use OpenCode Agent

Use `opencode-agent` as a persistent subagent. Let the parent agent delegate, inspect the result, and send follow-ups.

## Workflow

1. Spawn a worker with a bounded task and completion criteria:

   ```text
   opencode-agent spawn "Inspect the parser for correctness bugs and report evidence."
   ```

2. Retain both returned IDs:

   ```json
   {"workerId":"wrk_...","turnId":"trn_...","status":"running"}
   ```

   Use the Worker ID for the persistent conversation. Use the Turn ID for one task execution.

3. Check without blocking, or wait for completion:

   ```text
   opencode-agent status trn_...
   opencode-agent wait trn_...
   ```

   Prefer `status` for long-running work. Use `wait` when blocking is safe.

4. Continue the same worker and retain the new Turn ID:

   ```text
   opencode-agent followup wrk_... "Implement the highest-severity fix and run its tests."
   ```

5. Stop active work or end the worker:

   ```text
   opencode-agent interrupt wrk_...
   opencode-agent close wrk_...
   ```

## Rules

- Manage workers by ID, not label; labels may be duplicated.
- Keep the same project scope across commands. Project scope is the default; use `--scope global` consistently when global state is required.
- Use `--dir <path>` to control the worker's working directory.
- Omit `--agent` and `--model` to use the existing OpenCode defaults. Set them only when the task needs a particular OpenCode agent or cheaper model.
- Use `--file <path>` or `--stdin` for prompts that are awkward to quote.
- Parse stdout as JSON. Errors are JSON on stderr with a nonzero exit code. Use `--text` only when machine-readable output is unnecessary.
- There is no `result` command. Read completed output with `status <turn-id>` or `wait <turn-id>`.
- Workers run concurrently; turns within one worker run FIFO.
- Give concurrent write-capable workers separate Git worktrees when their file ownership may overlap.
- Close workers when no further follow-up is needed.

## Delegation pattern

```text
spawn(task)                 -> Worker ID + Turn ID
status(turnId)              -> nonblocking state or result
wait(turnId)                -> blocking final result
followup(workerId, message) -> new Turn ID
interrupt(workerId)         -> stop the active turn
close(workerId)             -> end the persistent worker
list()                      -> workers in the selected scope
```
