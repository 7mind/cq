/**
 * T473 (Q238): resolveActiveHarness — pure env -> Harness resolver.
 *
 * Acceptance cases:
 *  - CQ_HARNESS=pi => 'pi'
 *  - CQ_HARNESS=pi with CLAUDE_CODE_SESSION_ID also set => 'pi' (explicit wins)
 *  - only CLAUDE_CODE_SESSION_ID set => 'claude'
 *  - neither set => 'claude' (DEFAULT_HARNESS)
 *  - CQ_HARNESS=bogus throws CqConfigError
 */

import { describe, it, expect } from "bun:test";
import {
  resolveActiveHarness,
  resolveActiveHarnessFromProcess,
  DEFAULT_HARNESS,
  CqConfigError,
} from "../src/index.js";

describe("resolveActiveHarness", () => {
  it("selects pi on an explicit CQ_HARNESS=pi signal", () => {
    expect(resolveActiveHarness({ CQ_HARNESS: "pi" })).toBe("pi");
  });

  it("honours CQ_HARNESS=claude for symmetry", () => {
    expect(resolveActiveHarness({ CQ_HARNESS: "claude" })).toBe("claude");
  });

  it("lets the explicit pi signal win over a Claude session id", () => {
    expect(
      resolveActiveHarness({
        CQ_HARNESS: "pi",
        CLAUDE_CODE_SESSION_ID: "abc-123",
      }),
    ).toBe("pi");
  });

  it("infers claude from a non-empty CLAUDE_CODE_SESSION_ID", () => {
    expect(resolveActiveHarness({ CLAUDE_CODE_SESSION_ID: "abc-123" })).toBe(
      "claude",
    );
  });

  it("defaults to DEFAULT_HARNESS when no signal is present", () => {
    expect(resolveActiveHarness({})).toBe(DEFAULT_HARNESS);
    expect(DEFAULT_HARNESS).toBe("claude");
  });

  it("treats an empty CQ_HARNESS as absent and falls through", () => {
    expect(
      resolveActiveHarness({ CQ_HARNESS: "", CLAUDE_CODE_SESSION_ID: "x" }),
    ).toBe("claude");
    expect(resolveActiveHarness({ CQ_HARNESS: "" })).toBe(DEFAULT_HARNESS);
  });

  it("treats an empty CLAUDE_CODE_SESSION_ID as absent", () => {
    expect(resolveActiveHarness({ CLAUDE_CODE_SESSION_ID: "" })).toBe(
      DEFAULT_HARNESS,
    );
  });

  it("throws a CqConfigError on an unknown explicit CQ_HARNESS value", () => {
    expect(() => resolveActiveHarness({ CQ_HARNESS: "bogus" })).toThrow(
      CqConfigError,
    );
  });
});

describe("resolveActiveHarnessFromProcess", () => {
  it("resolves a known harness from the actual process env", () => {
    // The boundary convenience must return one of the known harnesses for the
    // current process; under bun:test no CQ_HARNESS=bogus is set.
    const harness = resolveActiveHarnessFromProcess();
    expect(["claude", "pi"]).toContain(harness);
  });
});
