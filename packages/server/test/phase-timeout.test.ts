/**
 * phase-timeout.test.ts — unit coverage for the shared phase-dispatch timeout
 * resolver (PHASE-TIMEOUT-01).
 *
 * Resolution order under test:
 *   explicit opt → valid CQ_WORKFLOW_PHASE_TIMEOUT_MS → 300_000 default.
 *
 * The resolver takes an injectable `env`, so most cases need NO global mutation.
 * The two cases that exercise the real `process.env` default path set+restore
 * the var in try/finally so nothing leaks across tests (testhyg discipline).
 */

import { describe, it, expect } from "bun:test";
import {
  resolvePhaseTimeoutMs,
  DEFAULT_PHASE_TIMEOUT_MS,
  PHASE_TIMEOUT_ENV_VAR,
} from "../src/workflow/phaseTimeout";

describe("resolvePhaseTimeoutMs", () => {
  it("defaults to 300_000 when neither opt nor env is set", () => {
    expect(DEFAULT_PHASE_TIMEOUT_MS).toBe(300_000);
    expect(resolvePhaseTimeoutMs(undefined, {})).toBe(300_000);
  });

  it("uses CQ_WORKFLOW_PHASE_TIMEOUT_MS when it is a valid positive integer", () => {
    expect(resolvePhaseTimeoutMs(undefined, { [PHASE_TIMEOUT_ENV_VAR]: "450000" })).toBe(450_000);
    // Whitespace is tolerated.
    expect(resolvePhaseTimeoutMs(undefined, { [PHASE_TIMEOUT_ENV_VAR]: "  60000 " })).toBe(60_000);
  });

  it("falls back to the default for invalid env values", () => {
    const invalid = ["", "   ", "abc", "0", "-1", "-100", "1.5", "100ms", "1e3", "NaN", "0x10"];
    for (const raw of invalid) {
      expect(resolvePhaseTimeoutMs(undefined, { [PHASE_TIMEOUT_ENV_VAR]: raw })).toBe(
        DEFAULT_PHASE_TIMEOUT_MS,
      );
    }
  });

  it("lets an explicit opt win over a valid env override", () => {
    expect(resolvePhaseTimeoutMs(50, { [PHASE_TIMEOUT_ENV_VAR]: "450000" })).toBe(50);
  });

  it("lets an explicit opt win over an invalid env value", () => {
    expect(resolvePhaseTimeoutMs(75, { [PHASE_TIMEOUT_ENV_VAR]: "garbage" })).toBe(75);
  });

  it("reads the real process.env when no env is injected (set/restore in finally)", () => {
    const saved = process.env[PHASE_TIMEOUT_ENV_VAR];
    try {
      process.env[PHASE_TIMEOUT_ENV_VAR] = "123456";
      expect(resolvePhaseTimeoutMs()).toBe(123_456);

      delete process.env[PHASE_TIMEOUT_ENV_VAR];
      expect(resolvePhaseTimeoutMs()).toBe(DEFAULT_PHASE_TIMEOUT_MS);

      process.env[PHASE_TIMEOUT_ENV_VAR] = "not-a-number";
      expect(resolvePhaseTimeoutMs()).toBe(DEFAULT_PHASE_TIMEOUT_MS);
    } finally {
      if (saved === undefined) delete process.env[PHASE_TIMEOUT_ENV_VAR];
      else process.env[PHASE_TIMEOUT_ENV_VAR] = saved;
    }
  });
});
