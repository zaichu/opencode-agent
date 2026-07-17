import { expect, test } from "bun:test";
import { decodeCommand } from "../src/protocol.ts";

test("the protocol decoder returns a typed command", () => {
  expect(
    decodeCommand({
      operation: "followup",
      input: { workerId: "wrk_123", message: "continue" },
    }),
  ).toEqual({
    operation: "followup",
    input: { workerId: "wrk_123", message: "continue", agent: undefined, model: undefined },
  });
});

test("the protocol decoder accepts a project worktree", () => {
  expect(
    decodeCommand({
      operation: "spawn",
      input: { task: "fix parser", projectRoot: "C:\\workspace", worktree: "parser" },
    }),
  ).toEqual({
    operation: "spawn",
    input: {
      task: "fix parser",
      projectRoot: "C:\\workspace",
      worktree: "parser",
      label: undefined,
      agent: undefined,
      model: undefined,
    },
  });
});

test("the protocol decoder accepts a project merge", () => {
  expect(
    decodeCommand({ operation: "merge", input: { workerId: "wrk_123" } }),
  ).toEqual({ operation: "merge", input: { workerId: "wrk_123" } });
});

test("the protocol decoder rejects invalid IDs and command fields", () => {
  expect(() =>
    decodeCommand({ operation: "wait", input: { turnId: "wrk_wrong-kind" } }),
  ).toThrow("turnId must be a Turn ID");
  expect(() =>
    decodeCommand({ operation: "spawn", input: { task: "", projectRoot: "C:\\workspace" } }),
  ).toThrow("task must be a non-empty string");
  expect(() =>
    decodeCommand({
      operation: "spawn",
      input: { task: "fix parser", projectRoot: "", worktree: "parser" },
    }),
  ).toThrow("projectRoot must be a non-empty string");
});
