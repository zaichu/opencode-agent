import type { TurnId, WorkerId } from "./runtime.ts";

export type Scope = { scope: "global" } | { scope: "project"; projectRoot: string };

export const OPERATIONS = ["spawn", "list", "status", "followup", "wait", "interrupt", "close"] as const;
export type Operation = (typeof OPERATIONS)[number];

type CommandFor<Worker extends string, Turn extends string> =
  | {
      scope: Scope;
      operation: "spawn";
      input: { task: string; directory: string; label?: string; agent?: string; model?: string };
    }
  | { scope: Scope; operation: "list"; input: Record<never, never> }
  | { scope: Scope; operation: "status"; input: { id: Worker | Turn } }
  | {
      scope: Scope;
      operation: "followup";
      input: { workerId: Worker; message: string; agent?: string; model?: string };
    }
  | { scope: Scope; operation: "wait"; input: { turnId: Turn } }
  | { scope: Scope; operation: "interrupt"; input: { workerId: Worker } }
  | { scope: Scope; operation: "close"; input: { workerId: Worker } };

export type CommandRequest = CommandFor<string, string>;
export type DecodedCommand = CommandFor<WorkerId, TurnId>;

export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export class ProtocolError extends Error {
  constructor(readonly code: "INVALID_USAGE" | "INVALID_ID", message: string) {
    super(message);
  }
}

export function decodeCommand(value: unknown): DecodedCommand {
  const request = object(value, "Invalid daemon request.");
  const scope = decodeScope(request.scope);
  const input = object(request.input, "Invalid daemon command input.");

  switch (request.operation) {
    case "spawn":
      return {
        scope,
        operation: "spawn",
        input: {
          task: stringField(input, "task"),
          directory: stringField(input, "directory"),
          label: optionalString(input, "label"),
          agent: optionalString(input, "agent"),
          model: optionalString(input, "model"),
        },
      };
    case "list":
      return { scope, operation: "list", input: {} };
    case "status":
      return { scope, operation: "status", input: { id: agentId(input, "id") } };
    case "followup":
      return {
        scope,
        operation: "followup",
        input: {
          workerId: workerId(input, "workerId"),
          message: stringField(input, "message"),
          agent: optionalString(input, "agent"),
          model: optionalString(input, "model"),
        },
      };
    case "wait":
      return { scope, operation: "wait", input: { turnId: turnId(input, "turnId") } };
    case "interrupt":
      return { scope, operation: "interrupt", input: { workerId: workerId(input, "workerId") } };
    case "close":
      return { scope, operation: "close", input: { workerId: workerId(input, "workerId") } };
    default:
      throw new ProtocolError("INVALID_USAGE", "Invalid daemon operation.");
  }
}

function decodeScope(value: unknown): Scope {
  const scope = object(value, "Invalid daemon scope.");
  if (scope.scope === "global") return { scope: "global" };
  if (scope.scope === "project" && typeof scope.projectRoot === "string" && scope.projectRoot) {
    return { scope: "project", projectRoot: scope.projectRoot };
  }
  throw new ProtocolError("INVALID_USAGE", "Invalid daemon scope.");
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("INVALID_USAGE", message);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || !result) {
    throw new ProtocolError("INVALID_USAGE", `${field} must be a non-empty string.`);
  }
  return result;
}

function optionalString(value: Record<string, unknown>, field: string): string | undefined {
  if (value[field] === undefined) return undefined;
  return stringField(value, field);
}

function workerId(value: Record<string, unknown>, field: string): WorkerId {
  const id = stringField(value, field);
  if (!id.startsWith("wrk_")) throw new ProtocolError("INVALID_ID", `${field} must be a Worker ID.`);
  return id as WorkerId;
}

function turnId(value: Record<string, unknown>, field: string): TurnId {
  const id = stringField(value, field);
  if (!id.startsWith("trn_")) throw new ProtocolError("INVALID_ID", `${field} must be a Turn ID.`);
  return id as TurnId;
}

function agentId(value: Record<string, unknown>, field: string): WorkerId | TurnId {
  const id = stringField(value, field);
  if (id.startsWith("wrk_") || id.startsWith("trn_")) return id as WorkerId | TurnId;
  throw new ProtocolError("INVALID_ID", `${field} must be a Worker ID or Turn ID.`);
}
