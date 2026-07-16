# opencode-agent

Use OpenCode as a persistent subagent from any tool that can run a CLI command.

The reason for this project is simple: a strong model is useful as the main orchestrator, but it does not need to handle every repository search, test run, or implementation task itself. `opencode-agent` lets it hand work to an OpenCode session using whichever agent and model you choose, then check the work or send follow-ups later.

OpenCode does the actual coding. This project adds the worker lifecycle around it.

## Install

You need [Bun](https://bun.sh/) 1.3 or newer and a working [OpenCode](https://opencode.ai/) installation with a configured provider.

From this repository:

```powershell
bun install
bun link
opencode-agent --version
```

## CLI usage

JSON is the default, so a parent agent or script can keep the returned IDs and use them later. This PowerShell example runs one task, checks it, sends a follow-up, and closes the worker:

```powershell
$job = opencode-agent spawn --label auth-review "Inspect the authentication code and report any bugs." | ConvertFrom-Json
opencode-agent status $job.turnId
$result = opencode-agent wait $job.turnId | ConvertFrom-Json
$next = opencode-agent followup $job.workerId "Fix the highest-severity bug." | ConvertFrom-Json
opencode-agent wait $next.turnId
opencode-agent close $job.workerId
```

`spawn` returns immediately with IDs such as:

```json
{"workerId":"wrk_...","turnId":"trn_...","status":"running","label":"auth-review"}
```

The Worker ID identifies the persistent OpenCode conversation. Each task or follow-up gets its own Turn ID. The same flow works from Codex, Claude Code, CI, or any other caller that can run commands and read JSON.

The commands themselves are the same in PowerShell, Bash, and other shells. Only the shell syntax used to capture JSON changes.

## Using it from Codex, Claude Code, or another harness

There is no special plugin protocol. A coding harness uses its terminal tool to run `opencode-agent`, reads the JSON response, and keeps the returned IDs in its own task context.

The integration contract is:

1. Keep the registry scope consistent: run from the project root, pass the same `--project <path>`, or use `--scope global` on every command.
2. Call `spawn` and save both `workerId` and `turnId` from stdout.
3. Use `status <turn-id>` for a nonblocking check, or `wait <turn-id>` when blocking is acceptable.
4. Use `followup <worker-id>` to continue that worker's OpenCode conversation. Save the new Turn ID it returns.
5. Use `interrupt <worker-id>` to stop only the active turn, or `close <worker-id>` when the worker is finished.

Do not use labels as identifiers. Two workers may have the same label.

For reliable automation, keep the default JSON output. A successful command writes one JSON object to stdout. A failure writes a JSON error to stderr and exits nonzero. `--text` is intended for humans, not harness integrations.

Long or multiline tasks are safer through `--file` or `--stdin` than through shell quoting:

```text
opencode-agent spawn --project <project-root> --dir <worker-directory> --stdin
```

The harness supplies the task on stdin and receives:

```json
{"workerId":"wrk_...","turnId":"trn_...","status":"running"}
```

A typical instruction to a main coding agent can be as simple as:

```text
Use opencode-agent to delegate this repository review to an OpenCode worker.
Keep the Worker and Turn IDs, wait for its report, send a follow-up if needed,
then close the worker.
```

To run several subagents, call `spawn` several times, keep each receipt separately, and wait on the Turn IDs you need. Each worker has its own OpenCode session; follow-ups must go to the matching Worker ID.

`wait` has no adapter timeout, but the harness's terminal tool may have one. For very long tasks, poll with `status` and call `wait` only when the turn is near completion. Stopping a local `wait` command does not stop the worker.

## Commands

| Command | What it does |
| --- | --- |
| `spawn <task>` | Starts a worker and returns a Worker ID and Turn ID |
| `list` | Lists workers in the current registry |
| `status <id>` | Checks a Worker ID or Turn ID without blocking |
| `followup <worker-id> <message>` | Sends another message to an existing worker |
| `wait <turn-id>` | Waits until a turn completes, fails, or is interrupted |
| `interrupt <worker-id>` | Stops the active turn but keeps the worker open |
| `close <worker-id>` | Stops the worker, cancels its queue, and closes its OpenCode session |

There is no separate `result` command. Once a turn finishes, `status` includes its result. Use `wait` when you want to block until that result is ready.

Run `opencode-agent --help` to see the available options.

## Worker options

The normal command needs only a task:

```powershell
opencode-agent spawn "Implement the requested change and run its tests."
```

OpenCode uses its configured default agent and model. Only provide overrides when a task needs them:

```powershell
opencode-agent spawn `
  --dir "C:\workspace\project" `
  --agent build `
  --label implementation `
  "Implement the requested change and run its tests."
```

- `--dir` is the worker's directory. It defaults to the current directory.
- `--agent` optionally selects an OpenCode agent such as `build`, `plan`, or a configured custom agent.
- `--model` optionally overrides the configured model using OpenCode's `provider/model` format.
- `--label` is only a display name. Labels do not need to be unique.

Follow-ups use the worker's agent and model unless you override them again.

OpenCode primary agents may delegate parts of the task to subagents such as `explore` or `general`. You can request that in the task:

```powershell
opencode-agent spawn --agent build "Use the explore subagent to map the authentication flow, then report back."
```

Available agents and their permissions come from the installed OpenCode version and its global or project configuration.

For longer prompts, use a file or stdin:

```powershell
opencode-agent spawn --file .\task.md
Get-Content .\task.md | opencode-agent spawn --stdin
```

Exactly one prompt source is allowed per `spawn` or `followup` command.

## Long-running and parallel workers

There is no adapter timeout. After `spawn` returns, the local daemon keeps the turn running. You can close the terminal and come back later with `status`, `wait`, or `list`.

Workers can run at the same time, and the adapter does not impose a fixed worker limit. Turns within one worker run one at a time in the order they were received.

Do not let several write-capable workers edit the same checkout concurrently. Use a separate Git worktree for each one when their tasks may overlap.

## Server and saved state

You normally do not need to run `opencode serve` yourself. On first use, `opencode-agent` starts its own local daemon. That daemon:

1. Reuses the OpenCode server at `http://127.0.0.1:4096` if it is healthy.
2. Starts `opencode serve` if the local server is not running.
3. Keeps accepted work alive after the original CLI command exits.

Worker and turn records are saved in SQLite under your OS user-data directory. They are not written into the repository.

State is project-scoped by default. The nearest Git root determines the registry. You can address another project or use one user-global registry:

```powershell
opencode-agent list --project "C:\workspace\another-project"
opencode-agent list --scope global
```

`--project` selects the registry containing the IDs. `--dir` selects where a worker reads and writes files.

## Output

Every command prints JSON by default. The response leaves out OpenCode reasoning, internal events, session IDs, token details, and monetary cost.

Use `--text` when you only want the final response text:

```powershell
opencode-agent wait trn_... --text
```

Errors are JSON too:

```json
{"error":{"code":"WORKER_NOT_FOUND","message":"Worker wrk_... was not found.","retryable":false}}
```

## Permissions

These workers are non-interactive. When OpenCode asks for permission during an active adapter turn, the adapter approves it. OpenCode questions that require a user response are rejected because the CLI cannot relay them yet.

Only send trusted tasks, and give workers access only to directories they are allowed to change.

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
bun run typecheck
bun test
bun run test:terminal
```

Or run every deterministic check:

```powershell
bun run test:all
```

The terminal suite uses a fake OpenCode server and does not call a model. The live test uses a real provider and may cost money:

```powershell
bun run test:live
```
