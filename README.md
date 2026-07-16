# OpenCode Agent

A CLI-first, harness-neutral runtime that makes OpenCode sessions behave like persistent Codex or Claude-style delegated workers. A capable main agent can delegate long-running work to cheaper OpenCode models, then follow up, inspect, wait for, interrupt, and close workers through durable Worker and Turn IDs.

```powershell
bun install
bun .\src\index.ts spawn --agent build --model deepseek/deepseek-v4-pro "Review the parser"
```

The CLI prints JSON by default. `spawn` returns immediately while the automatically started adapter daemon keeps the turn alive:

```json
{"workerId":"wrk_...","turnId":"trn_...","status":"running"}
```

```powershell
bun .\src\index.ts status trn_...
bun .\src\index.ts wait trn_...
bun .\src\index.ts followup wrk_... "Now implement the first fix"
bun .\src\index.ts interrupt wrk_...
bun .\src\index.ts close wrk_...
```

State is project-scoped by default. Use `--scope global` for a user-global registry or `--project <path>` to address another project's registry. The daemon reuses a healthy OpenCode server at `OPENCODE_URL` (default `http://127.0.0.1:4096`) or starts `opencode serve` automatically.

See the [system design](./docs/architecture.md) and project [language](./CONTEXT.md).

## Testing

Run the normal source-level suite:

```powershell
bun test
```

Run the deterministic terminal suite through the installed `opencode-agent` command:

```powershell
bun link
```

```powershell
bun run test:terminal
```

This suite uses an isolated fake OpenCode server, so it is repeatable and does not invoke or charge a model. It verifies command discovery, JSON output, spawn, status, list, wait, stateful follow-up, interruption, close, project/global scope isolation, structured errors, long-running turns, and daemon cleanup.

Run every deterministic check together:

```powershell
bun run test:all
```

Run the opt-in live smoke suite against a real OpenCode server and model:

```powershell
bun run test:live
```

The live suite may incur provider cost. It creates an isolated adapter daemon and registry, sends two small turns through `opencode-agent`, confirms worker context is retained, closes the worker, and removes its temporary state. Override the server, agent, or model when needed:

```powershell
$env:OPENCODE_URL="http://127.0.0.1:4096"; $env:OPENCODE_AGENT_TEST_AGENT="build"; $env:OPENCODE_AGENT_TEST_MODEL="deepseek/deepseek-v4-pro"; bun run test:live
```
