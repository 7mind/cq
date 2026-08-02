/**
 * T288: formatReviewerToken round-trip tests.
 *
 * Acceptance: for each of
 *   pi:grok-build/grok-build:xhigh
 *   claude:opus-4.8[1m]:high
 *   pi:ollama-cloud/minimax-m3
 *   claude:opus-4.8[1m]
 *   codex:gpt-5.6-sol:ultra
 * formatReviewerToken(parseReviewerToken(s)) === s.
 *
 * Also verifies that effort:null emits no trailing :<effort>.
 */

import { describe, it, expect } from "bun:test";
import {
  parseReviewerToken,
  formatReviewerToken,
} from "../src/index.js";

const ROUND_TRIP_CASES: string[] = [
  "pi:grok-build/grok-build:xhigh",
  "claude:opus-4.8[1m]:high",
  "pi:ollama-cloud/minimax-m3",
  "claude:opus-4.8[1m]",
  "codex:gpt-5.6-sol:ultra",
];

describe("formatReviewerToken — round-trip (T288)", () => {
  for (const s of ROUND_TRIP_CASES) {
    it(`formatReviewerToken(parseReviewerToken("${s}")) === "${s}"`, () => {
      expect(formatReviewerToken(parseReviewerToken(s))).toBe(s);
    });
  }

  it("effort:null emits no trailing :<effort> (pi token)", () => {
    const token = parseReviewerToken("pi:ollama-cloud/minimax-m3");
    expect(token.effort).toBeNull();
    // Must equal exactly the no-effort form — no extra colon-delimited suffix.
    expect(formatReviewerToken(token)).toBe("pi:ollama-cloud/minimax-m3");
  });

  it("effort:null emits no trailing :<effort> (claude token)", () => {
    const token = parseReviewerToken("claude:opus-4.8[1m]");
    expect(token.effort).toBeNull();
    expect(formatReviewerToken(token)).toBe("claude:opus-4.8[1m]");
  });
});
