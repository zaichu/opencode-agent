import { expect, test } from "bun:test";
import { decodeCommand } from "../src/protocol.ts";

const scope = { scope: "project", projectRoot: "C:\\workspace" } as const;

test("the protocol decoder returns a typed command", () => {
  expect(
    decodeCommand({
      scope,
      operation: "followup",
      input: { workerId: "wrk_123", message: "continue" },
    }),
  ).toEqual({
    scope,
    operation: "followup",
    input: { workerId: "wrk_123", message: "continue", agent: undefined, model: undefined },
  });
});

test("the protocol decoder rejects invalid IDs and command fields", () => {
  expect(() =>
    decodeCommand({ scope, operation: "wait", input: { turnId: "wrk_wrong-kind" } }),
  ).toThrow("turnId must be a Turn ID");
  expect(() =>
    decodeCommand({ scope, operation: "spawn", input: { task: "", directory: "C:\\workspace" } }),
  ).toThrow("task must be a non-empty string");
});
