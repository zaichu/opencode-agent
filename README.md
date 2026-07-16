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
| `close <worker-id>` | Stops the worker, cancels its queue, and closes its OpenCode session |

There is no separate `result` command. A completed turn's text is returned by `status` and `wait`.

## Options

```text
--dir <path>             Worker directory; defaults to the current directory
--label <label>          Optional display label
--agent <agent>          Optional OpenCode agent override
--model <provider/model> Optional OpenCode model override
--scope project|global   Registry scope; defaults to project
--project <path>         Select another project's registry
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
4. Use `interrupt` for the active turn or `close` when the conversation is finished.

Keep registry scope consistent across commands: run from the same Git project, pass the same `--project`, or use `--scope global` each time.

JSON is the default. Successful commands write one JSON value to stdout. Failures write one JSON error to stderr and exit nonzero:

```json
{"error":{"code":"WORKER_NOT_FOUND","message":"Worker wrk_... was not found.","retryable":false}}
```

The response omits OpenCode reasoning, internal events, session IDs, token details, and cost.

## Long-running and parallel work

There is no adapter turn timeout. The local daemon keeps accepted work running after the original CLI process exits. A harness terminal may still have its own timeout; for long tasks, poll with `status` and call `wait` near completion.

Workers run concurrently without a fixed adapter limit. Turns within one worker remain FIFO.

Do not let write-capable workers edit the same checkout concurrently. Give overlapping workers separate Git worktrees.

## Server, state, and permissions

You normally do not need to start `opencode serve`. On first use, the adapter daemon:

- reuses a healthy OpenCode server at `http://127.0.0.1:4096`;
- starts `opencode serve` when that local server is absent;
- stores workers and turns in SQLite under the OS user-data directory.

State is project-scoped by default using the nearest Git root. `--project` selects another project registry; `--dir` controls where the worker reads and writes.

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
