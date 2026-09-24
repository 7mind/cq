/** G224: `cq mcp` takes a child's result capability from its environment exactly once. */

import { describe, expect, test } from "bun:test";
import {
  CQ_DISPATCH_RESULT_CAPABILITY_ENV,
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
