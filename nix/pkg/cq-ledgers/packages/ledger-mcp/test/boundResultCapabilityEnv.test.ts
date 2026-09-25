/** G224: `cq mcp` takes a child's result capability from its environment exactly once. */

import { describe, expect, test } from "bun:test";
import {
  CQ_DISPATCH_GIT_CHANGE_CAPABILITY_ENV,
  CQ_DISPATCH_GIT_CONFLICT_CAPABILITY_ENV,
  CQ_DISPATCH_RESULT_CAPABILITY_ENV,
  takeBoundGitChangeCapability,
  takeBoundGitConflictCapability,
  takeBoundResultCapability,
} from "../src/boundResultCapability.js";

const TOKEN = `cq_result_${"b".repeat(43)}`;

describe("takeBoundResultCapability", () => {
  test("binds a well-formed token and removes it from the environment", () => {
    const environment: Record<string, string | undefined> = {
      [CQ_DISPATCH_RESULT_CAPABILITY_ENV]: TOKEN,
      OTHER: "kept",
    };
    expect(takeBoundResultCapability(environment)).toEqual({ scope: "store-result", token: TOKEN });
    expect(CQ_DISPATCH_RESULT_CAPABILITY_ENV in environment).toBe(false);
    expect(environment["OTHER"]).toBe("kept");
  });

  test("an absent variable binds nothing", () => {
    expect(takeBoundResultCapability({})).toBeUndefined();
  });

  test("a malformed token is refused and still removed", () => {
    const environment: Record<string, string | undefined> = {
      [CQ_DISPATCH_RESULT_CAPABILITY_ENV]: "cq_input_not-a-result-capability",
    };
    expect(() => takeBoundResultCapability(environment)).toThrow(CQ_DISPATCH_RESULT_CAPABILITY_ENV);
    expect(CQ_DISPATCH_RESULT_CAPABILITY_ENV in environment).toBe(false);
  });
});

describe("takeBoundGitConflictCapability", () => {
  test("binds a well-formed conflict token and removes it from the environment", () => {
    const token = `cq_conflict_${"c".repeat(43)}`;
    const environment: Record<string, string | undefined> = { [CQ_DISPATCH_GIT_CONFLICT_CAPABILITY_ENV]: token };
    expect(takeBoundGitConflictCapability(environment)).toEqual({ scope: "git-conflict", token });
    expect(CQ_DISPATCH_GIT_CONFLICT_CAPABILITY_ENV in environment).toBe(false);
  });

  test("a result token is not a conflict capability", () => {
    const environment: Record<string, string | undefined> = { [CQ_DISPATCH_GIT_CONFLICT_CAPABILITY_ENV]: TOKEN };
    expect(() => takeBoundGitConflictCapability(environment)).toThrow(CQ_DISPATCH_GIT_CONFLICT_CAPABILITY_ENV);
    expect(CQ_DISPATCH_GIT_CONFLICT_CAPABILITY_ENV in environment).toBe(false);
  });

  test("an absent variable binds nothing", () => {
    expect(takeBoundGitConflictCapability({})).toBeUndefined();
  });
});

describe("takeBoundGitChangeCapability", () => {
  // D561: a cohort worker commits through the trusted broker on every surface, so
  // its Git change capability reaches the child the same way the conflict
  // capability already does — through the child server's environment.
  test("binds a well-formed change token and removes it from the environment", () => {
    const token = `cq_git_${"d".repeat(43)}`;
    const environment: Record<string, string | undefined> = { [CQ_DISPATCH_GIT_CHANGE_CAPABILITY_ENV]: token };
    expect(takeBoundGitChangeCapability(environment)).toEqual({ scope: "git-change", token });
    expect(CQ_DISPATCH_GIT_CHANGE_CAPABILITY_ENV in environment).toBe(false);
  });

  test("an absent variable binds nothing", () => {
    expect(takeBoundGitChangeCapability({})).toBeUndefined();
  });

  test("a foreign capability token is refused and still removed", () => {
    const environment: Record<string, string | undefined> = {
      [CQ_DISPATCH_GIT_CHANGE_CAPABILITY_ENV]: `cq_conflict_${"c".repeat(43)}`,
    };
    expect(() => takeBoundGitChangeCapability(environment)).toThrow(CQ_DISPATCH_GIT_CHANGE_CAPABILITY_ENV);
    expect(CQ_DISPATCH_GIT_CHANGE_CAPABILITY_ENV in environment).toBe(false);
  });
});
