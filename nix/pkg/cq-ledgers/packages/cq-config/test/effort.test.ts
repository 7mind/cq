/**
 * T284: isEffort guard + effort enum acceptance tests.
 *
 * Acceptance cases:
 *  - isEffort('pi','xhigh') === true
 *  - isEffort('claude','xhigh') === true
 *  - isEffort('pi','max') === true   (GPT-5.6 supports max)
 *  - isEffort('pi','none') === true  (GPT-5.6 supports none)
 *  - isEffort('claude','off') === false  (off is pi-only)
 *  - isEffort('pi','bogus') === false
 *  - PI_EFFORTS and CLAUDE_EFFORTS are re-exported from @cq/config
 *  - ReviewerToken.effort field exists and accepts Effort | null | undefined
 */

import { describe, it, expect } from "bun:test";
import {
  isEffort,
  PI_EFFORTS,
  CLAUDE_EFFORTS,
  type Effort,
  type PiEffort,
  type ClaudeEffort,
  type ReviewerToken,
} from "../src/index.js";

describe("isEffort", () => {
  it("accepts xhigh for pi", () => {
    expect(isEffort("pi", "xhigh")).toBe(true);
  });

  it("accepts xhigh for claude", () => {
    expect(isEffort("claude", "xhigh")).toBe(true);
  });

  it("accepts max for pi (GPT-5.6 supports max)", () => {
    expect(isEffort("pi", "max")).toBe(true);
  });

  it("accepts none for pi (GPT-5.6 supports none)", () => {
    expect(isEffort("pi", "none")).toBe(true);
  });

  it("rejects off for claude (off is pi-only)", () => {
    expect(isEffort("claude", "off")).toBe(false);
  });

  it("rejects bogus for pi", () => {
    expect(isEffort("pi", "bogus")).toBe(false);
  });

  it("accepts all PI_EFFORTS for pi", () => {
    for (const e of PI_EFFORTS) {
      expect(isEffort("pi", e)).toBe(true);
    }
  });

  it("accepts all CLAUDE_EFFORTS for claude", () => {
    for (const e of CLAUDE_EFFORTS) {
      expect(isEffort("claude", e)).toBe(true);
    }
  });

  it("rejects pi-only efforts for claude", () => {
    const piOnly = PI_EFFORTS.filter(
      (e) => !(CLAUDE_EFFORTS as readonly string[]).includes(e),
    );
    for (const e of piOnly) {
      expect(isEffort("claude", e)).toBe(false);
    }
  });

  it("pi accepts every claude effort (pi vocabulary is a superset)", () => {
    // GPT-5.6 brought `none` and `max` into the pi vocabulary, so every
    // CLAUDE_EFFORT is now also a valid pi effort.
    for (const e of CLAUDE_EFFORTS) {
      expect(isEffort("pi", e)).toBe(true);
    }
  });
});

describe("ReviewerToken.effort field", () => {
  it("accepts effort: null on a ReviewerToken", () => {
    const token: ReviewerToken = {
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    };
    expect(token.effort).toBeNull();
  });

  it("accepts effort omitted on a ReviewerToken", () => {
    const token: ReviewerToken = {
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
    };
    expect(token.effort).toBeUndefined();
  });

  it("accepts a valid Effort value on a ReviewerToken", () => {
    const token: ReviewerToken = {
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: "high",
    };
    expect(token.effort).toBe("high");
  });
});

// Type-level assertions: ensure the exported types are structurally correct.
const _piEffort: PiEffort = "off";
const _claudeEffort: ClaudeEffort = "max";
const _effort: Effort = "xhigh";
void _piEffort;
void _claudeEffort;
void _effort;
