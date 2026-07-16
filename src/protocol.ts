export type Scope = { scope: "global" } | { scope: "project"; projectRoot: string };

export type Operation = "spawn" | "list" | "status" | "followup" | "wait" | "interrupt" | "close";

export interface CommandRequest {
  scope: Scope;
  operation: Operation;
  input: Record<string, unknown>;
}

export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export const OPERATIONS: readonly Operation[] = [
  "spawn",
  "list",
  "status",
  "followup",
  "wait",
  "interrupt",
  "close",
] as const;
