/**
 * T703 / G94 — compact/ref-first bytes against frozen T681 fixtures.
 * Performance-intent, Active, Blackbox-Atomic. No provider samples.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const T681 = path.resolve(import.meta.dir, "../../ledger-mcp/test/fixtures/t681");

interface PromptRecord {
  readonly surface: string;
  readonly roleId: string;
  readonly legacyParentVisibleBytes: number;
  readonly compactParentVisibleBytes: number;
}

interface PromptFixture {
  readonly records: readonly PromptRecord[];
  readonly scope: { readonly aggregateClaim: boolean; readonly crossHarnessClaim: boolean };
  readonly rs4: {
    readonly researchId: string;
    readonly sampleSize: number;
    readonly representative: { readonly byteReductionPercent: number };
  };
}

interface Rs5Fixture {
  readonly sampleSize: number;
  readonly aggregateClaim: boolean;
  readonly crossHarnessClaim: boolean;
  readonly strategies: {
    readonly legacyValidateOutput: { readonly parentVisibleBytes: number };
    readonly refFirstSingleFetch: {
      readonly parentVisibleBytes: number;
      readonly fetchCount: number;
      readonly modelVisibleFullOutputCopies: number;
    };
  };
}

const prompts = JSON.parse(readFileSync(path.join(T681, "prompt-dispatch.json"), "utf8")) as PromptFixture;
const rs5 = JSON.parse(readFileSync(path.join(T681, "rs5-codex-n1.json"), "utf8")) as Rs5Fixture;

describe("T703 compact/ref-first benchmark against T681 fixtures", () => {
  test("every role/surface reports an exact compact delta and sample count 1 [BA]", () => {
    expect(prompts.scope.aggregateClaim).toBe(false);
    expect(prompts.scope.crossHarnessClaim).toBe(false);
    expect(prompts.records.length).toBe(27);
    for (const record of prompts.records) {
      const delta = record.legacyParentVisibleBytes - record.compactParentVisibleBytes;
      expect(delta).toBeGreaterThan(0);
      expect(record.compactParentVisibleBytes).toBeLessThan(record.legacyParentVisibleBytes);
    }
  });

  test("RS4 representative stays at least 95% smaller and stays labeled N=1 [BA]", () => {
    expect(prompts.rs4.researchId).toBe("RS4");
    expect(prompts.rs4.sampleSize).toBe(1);
    expect(prompts.rs4.representative.byteReductionPercent).toBeGreaterThanOrEqual(95);
  });

  test("RS5 N=1 pair reproduces one fetched body and no second validate_output copy [BA]", () => {
    expect(rs5.sampleSize).toBe(1);
    expect(rs5.aggregateClaim).toBe(false);
    expect(rs5.crossHarnessClaim).toBe(false);
    const legacy = rs5.strategies.legacyValidateOutput.parentVisibleBytes;
    const refFirst = rs5.strategies.refFirstSingleFetch;
    expect(refFirst.parentVisibleBytes).toBeLessThan(legacy);
    expect(refFirst.fetchCount).toBe(1);
    expect(refFirst.modelVisibleFullOutputCopies).toBe(1);
  });
});
