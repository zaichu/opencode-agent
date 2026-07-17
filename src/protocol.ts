import type { TurnId, WorkerId } from "./runtime.ts";

type CommandFor<Worker extends string, Turn extends string> =
  | {
      operation: "spawn";
      input: { task: string; projectRoot: string; worktree?: string; label?: string; agent?: string; model?: string };
    }
  | { operation: "list"; input: { projectRoot?: string } }
  | { operation: "status"; input: { id: Worker | Turn } }
  | {
      operation: "followup";
      input: { workerId: Worker; message: string; agent?: string; model?: string };
    }
  | { operation: "wait"; input: { turnId: Turn } }
  | { operation: "interrupt"; input: { workerId: Worker } }
  | { operation: "merge"; input: { workerId: Worker } }
  | { operation: "close"; input: { workerId: Worker } };

export type CommandRequest = CommandFor<string, string>;
export type DecodedCommand = CommandFor<WorkerId, TurnId>;

export interface ErrorBody {
  code: string;
  message: string;
  retryable?: true;
}

export class ProtocolError extends Error {
  constructor(readonly code: "INVALID_USAGE" | "INVALID_ID", message: string) {
    super(message);
  }
}

export function decodeCommand(value: unknown): DecodedCommand {
  const request = object(value, "Invalid daemon request.");
  const input = object(request.input, "Invalid daemon command input.");

  switch (request.operation) {
    case "spawn":
      return {
        operation: "spawn",
        input: {
          task: stringField(input, "task"),
          projectRoot: stringField(input, "projectRoot"),
          worktree: optionalString(input, "worktree"),
          label: optionalString(input, "label"),
          agent: optionalString(input, "agent"),
          model: optionalString(input, "model"),
        },
      };
    case "list":
      return { operation: "list", input: { projectRoot: optionalString(input, "projectRoot") } };
    case "status":
      return { operation: "status", input: { id: agentId(input, "id") } };
    case "followup":
      return {
        operation: "followup",
        input: {
          workerId: workerId(input, "workerId"),
          message: stringField(input, "message"),
          agent: optionalString(input, "agent"),
          model: optionalString(input, "model"),
        },
      };
    case "wait":
      return { operation: "wait", input: { turnId: turnId(input, "turnId") } };
    case "interrupt":
      return { operation: "interrupt", input: { workerId: workerId(input, "workerId") } };
    case "merge":
      return { operation: "merge", input: { workerId: workerId(input, "workerId") } };
    case "close":
      return { operation: "close", input: { workerId: workerId(input, "workerId") } };
    default:
      throw new ProtocolError("INVALID_USAGE", "Invalid daemon operation.");
  }
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
