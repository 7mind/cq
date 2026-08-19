/**
 * T803/T804 — [upstream] filing/recheck kill-switches.
 * Absence and missing keys default to enabled. Harness-invariant.
 */
import { describe, expect, it } from "bun:test";
import { CqConfigError, parseConfig } from "../src/index.js";

const ENABLED = { filing: "enabled", recheck: "enabled" } as const;

describe("T803 [upstream] table", () => {
  it("absent table defaults both kill-switches to enabled", () => {
    expect(parseConfig("[aliases]\n").upstream).toEqual(ENABLED);
  });

  it("empty table defaults both kill-switches to enabled", () => {
    expect(parseConfig("[upstream]\n").upstream).toEqual(ENABLED);
  });

  it("covers all four explicit filing/recheck combinations", () => {
    const cases = [
      { filing: "enabled", recheck: "enabled" },
      { filing: "enabled", recheck: "disabled" },
      { filing: "disabled", recheck: "enabled" },
      { filing: "disabled", recheck: "disabled" },
    ] as const;
    for (const expected of cases) {
      const source = `[upstream]\nfiling = "${expected.filing}"\nrecheck = "${expected.recheck}"\n`;
      expect(parseConfig(source).upstream).toEqual(expected);
    }
  });

  it("a present table with one missing key defaults that key to enabled", () => {
    expect(parseConfig('[upstream]\nfiling = "disabled"\n').upstream).toEqual({
      filing: "disabled",
      recheck: "enabled",
    });
    expect(parseConfig('[upstream]\nrecheck = "disabled"\n').upstream).toEqual({
      filing: "enabled",
      recheck: "disabled",
    });
  });

  it("rejects unknown keys, wrong types, and unknown values", () => {
    expect(() => parseConfig("[upstream]\ntoken = \"secret\"\n")).toThrow(
      /unexpected key "token" in \[upstream\]/,
    );
    expect(() => parseConfig("[upstream]\nfiling = true\n")).toThrow(CqConfigError);
    expect(() => parseConfig("[upstream]\nfiling = true\n")).toThrow(
      /filing must be "enabled" or "disabled"/,
    );
    expect(() => parseConfig('[upstream]\nrecheck = "yes"\n')).toThrow(CqConfigError);
    expect(() => parseConfig('[upstream]\nrecheck = "yes"\n')).toThrow(
      /recheck must be "enabled" or "disabled"/,
    );
  });

  it("is identical under every active harness and cannot live in [harness.*]", () => {
    const source = '[upstream]\nfiling = "disabled"\nrecheck = "disabled"\n';
    const expected = { filing: "disabled", recheck: "disabled" } as const;
    for (const harness of ["claude", "codex", "pi"] as const) {
      expect(parseConfig(source, harness).upstream).toEqual(expected);
      expect(() => parseConfig(`[harness.${harness}]\nfiling = "disabled"\n`)).toThrow(
        /filing/,
      );
    }
  });

  it("serialized result carries only the two switches and no credentials", () => {
    const serialized = JSON.stringify(parseConfig("[aliases]\n").upstream);
    expect(serialized).toBe('{"filing":"enabled","recheck":"enabled"}');
    expect(serialized).not.toMatch(/token|secret|password|bearer/i);
  });
});
