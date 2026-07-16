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
