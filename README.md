# opencode-agent

Use OpenCode as a persistent subagent from any tool that can run a CLI command.

A strong model can remain the orchestrator while cheaper OpenCode models handle repository searches, tests, reviews, and implementation work. OpenCode does the coding; `opencode-agent` adds durable worker IDs, follow-ups, waiting, interruption, and saved state.

## Install

Requires [Bun](https://bun.sh/) 1.3 or newer and a working [OpenCode](https://opencode.ai/) installation.

```powershell
bun install
bun link
opencode-agent --version
```

## Basic workflow

Start a worker:

```text
opencode-agent spawn --label auth-review "Inspect the authentication flow and report any bugs."
```

`spawn` returns immediately:

```json
{"workerId":"wrk_...","turnId":"trn_...","status":"running","label":"auth-review"}
```

Use the Turn ID to inspect or wait for that task. Use the Worker ID to continue or close the persistent conversation.

```text
opencode-agent status trn_...
opencode-agent wait trn_...
opencode-agent followup wrk_... "Fix the highest-severity bug."
opencode-agent merge wrk_...
opencode-agent close wrk_...
```

Labels are display names and may be duplicated. Always manage workers by ID.

## Commands

| Command | Result |
| --- | --- |
| `spawn <task>` | Starts a worker and returns its Worker ID and first Turn ID |
| `list` | Lists workers in the selected registry |
| `status <id>` | Reads a Worker or Turn without blocking |
| `followup <worker-id> <message>` | Queues another turn in the same conversation |
| `wait <turn-id>` | Blocks until the turn completes, fails, or is interrupted |
| `interrupt <worker-id>` | Stops the active turn but keeps the worker open |
| `merge <worker-id>` | Commits and merges an idle managed-worktree worker into the project checkout |
| `close <worker-id>` | Stops the worker, cancels its queue, and closes its OpenCode session |

There is no separate `result` command. A completed turn's text is returned by `status` and `wait`.

## Options

```text
--worktree <name>        Create an isolated Git worktree and branch for the worker
--label <label>          Optional display label
--agent <agent>          Optional OpenCode agent override
--model <provider/model> Optional OpenCode model override
--project <path>         Select the project where the worker operates
--all                    List workers across every project
--file <path>            Read the task or follow-up from a file
--stdin                  Read the task or follow-up from stdin
--text                   Print only human-readable result text
```

Without `--agent` or `--model`, OpenCode uses its configured defaults. A primary OpenCode agent can delegate internally when instructed:

```text
opencode-agent spawn --agent build "Use the explore subagent to map the authentication flow, then report back."
```

Available agents and permissions come from the installed OpenCode version and its global or project configuration.

For long prompts, avoid shell quoting:

```powershell
opencode-agent spawn --file .\task.md
Get-Content .\task.md | opencode-agent spawn --stdin
```

Exactly one prompt source is allowed.

## Coding harnesses

Codex, Claude Code, CI, and custom orchestrators use the same CLI contract:

1. Run `spawn` and retain both returned IDs.
2. Use `status <turn-id>` for a nonblocking check or `wait <turn-id>` when blocking is safe.
3. Send follow-ups to the Worker ID and retain each new Turn ID.
4. For a managed worktree, validate the result and run `merge <worker-id>`.
5. Use `interrupt` for active work or `close` when the conversation is finished.

Worker and Turn IDs work from any directory. `--project` is needed only when spawning outside the target project or filtering `list`; use `list --all` to see every project.

JSON is the default. Successful commands write one JSON value to stdout. Failures write one JSON error to stderr and exit nonzero:

```json
{"error":{"code":"WORKER_NOT_FOUND","message":"Worker wrk_... was not found."}}
```

The response omits OpenCode reasoning, internal events, session IDs, token details, and cost.

## Long-running and parallel work

There is no adapter turn timeout. The local daemon keeps accepted work running after the original CLI process exits. A harness terminal may still have its own timeout; for long tasks, poll with `status` and call `wait` near completion.

Workers run concurrently without a fixed adapter limit. Turns within one worker remain FIFO.

Do not let write-capable workers edit the same checkout concurrently. Give overlapping workers separate Git worktrees.

### Managed worktrees

Use a named worktree for isolated write work:

```text
opencode-agent spawn --worktree parser --agent build "Fix the parser and run its tests."
```

The command creates branch `opencode-agent/parser`, checks it out under the adapter's user-data directory, and binds the worker to it. The normal `spawn` receipt remains limited to Worker ID, Turn ID, status, and optional label. A worktree name must be unique within its project.

`followup` retains the worktree and may select another agent. Once the worker is idle and its changes have been validated, merge it by Worker ID:

```text
opencode-agent merge wrk_...
```

`merge` refuses active or queued workers and a project checkout with uncommitted changes. It commits all worktree changes, merges the branch into the current project branch, and returns only `{"workerId":"wrk_...","status":"merged"}`. The worker and worktree remain available for follow-ups. `close` also preserves the checkout and branch.

## Server, state, and permissions

You normally do not need to start `opencode serve`. On first use, the adapter daemon:

- reuses a healthy OpenCode server at `http://127.0.0.1:4096`;
- starts `opencode serve` when that local server is absent;
- stores workers and turns in SQLite under the OS user-data directory.

The adapter uses one per-user SQLite database for every project. Each worker has a required project root; there are no projectless or nullable-project workers. The nearest Git root is used by default, `--project` selects another project, and `--worktree` creates an isolated checkout belonging to it.

Workers are non-interactive. OpenCode permission requests for active adapter turns are approved. Questions requiring a user answer are rejected because the CLI cannot relay them yet. Only delegate trusted tasks and directories.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_BIN` | `opencode` | OpenCode executable |
| `OPENCODE_AGENT_HOME` | OS user-data directory | SQLite state, daemon token, and logs |
| `OPENCODE_AGENT_PORT` | `47321` | Local adapter daemon port |
| `OPENCODE_AGENT_MAX_REQUEST_BYTES` | `16777216` | Maximum command body size |

## Development

```powershell
bun run test:all
```

The deterministic terminal suite uses the shared fake OpenCode adapter. The live test invokes a configured provider and may cost money:

```powershell
bun run test:live
```
