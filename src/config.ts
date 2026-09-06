import { homedir, platform } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1.2;
export const PROTOCOL_HEADER = "x-opencode-agent-protocol";

export interface AdapterConfig {
  dataRoot: string;
  daemonPort: number;
  daemonUrl: string;
  openCodeUrl: string;
  openCodeBinary: string;
  maxRequestBytes: number;
  turnTimeoutMs: number;
}

export class ConfigError extends Error {
  readonly code = "INVALID_CONFIG";
}

export function loadConfig(): AdapterConfig {
  const daemonPort = integerSetting("OPENCODE_AGENT_PORT", Bun.env.OPENCODE_AGENT_PORT ?? "47321", 1, 65_535);
  return {
    dataRoot: Bun.env.OPENCODE_AGENT_HOME ?? defaultDataRoot(),
    daemonPort,
    daemonUrl: `http://127.0.0.1:${daemonPort}`,
    openCodeUrl: Bun.env.OPENCODE_URL ?? "http://127.0.0.1:4096",
    openCodeBinary: Bun.env.OPENCODE_BIN ?? "opencode",
    maxRequestBytes: integerSetting(
      "OPENCODE_AGENT_MAX_REQUEST_BYTES",
      Bun.env.OPENCODE_AGENT_MAX_REQUEST_BYTES ?? String(16 * 1024 * 1024),
      1024,
      1024 * 1024 * 1024,
    ),
    // OpenCode 本体がプロバイダのレート制限等でリトライに失敗した後、SSE で
    // 何のイベントも送出せず turn が無応答のまま固まることがある(サーバー内部
    // ログにのみ "stream error" が残り、message.updated / session.error は来ない)。
    // これを検出するため、進捗イベントが一定時間無ければ強制的に failed にする。
    turnTimeoutMs: integerSetting(
      "OPENCODE_AGENT_TURN_TIMEOUT_MS",
      Bun.env.OPENCODE_AGENT_TURN_TIMEOUT_MS ?? String(5 * 60 * 1000),
      1000,
      60 * 60 * 1000,
    ),
  };
}

function defaultDataRoot(): string {
  if (platform() === "win32" && Bun.env.LOCALAPPDATA) return join(Bun.env.LOCALAPPDATA, "opencode-agent");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "opencode-agent");
  return join(Bun.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-agent");
}

function integerSetting(name: string, value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError(`${name} must be an integer between ${minimum} and ${maximum}; received ${value}.`);
  }
  return parsed;
}
