import { describe, expect, test } from "bun:test";
import { validateAgainstSchema, type JSONSchema } from "@cq/config";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const FIXTURE_ROOT = path.join(import.meta.dir, "fixtures", "t681");
const DISPATCHED_ROLES = [
  "plan-advance",
  "plan-reviewer",
  "implement-worker",
  "implement-reviewer",
  "implement-conflict-resolver",
  "investigate-explorer",
  "investigate-prober",
  "research-explorer",
  "research-experimenter",
] as const;
const SURFACES = ["claude", "codex", "pi"] as const;

interface PromptRecord {
  readonly surface: string;
  readonly roleId: string;
  readonly fixturePath: string;
  readonly sha256: string;
  readonly legacyParentVisibleBytes: number;
  readonly compactParentVisibleBytes: number;
  readonly childPromptBytes: number;
  readonly typedInputBytes: number;
  readonly childBytes: number;
  readonly legacyFetchCount: number;
  readonly compactFetchCount: number;
}

interface PromptFixture {
  readonly fixtureVersion: number;
  readonly scope: {
    readonly sampleSizePerRoleSurface: number;
    readonly roles: readonly string[];
    readonly surfaces: readonly string[];
    readonly aggregateClaim: boolean;
    readonly crossHarnessClaim: boolean;
  };
  readonly unavailable: Readonly<Record<string, string>>;
  readonly piInlineCommandRecursion: {
    readonly measuredAsDispatchedRole: boolean;
    readonly roleKind: string;
    readonly mechanism: string;
    readonly example: string;
    readonly reason: string;
  };
  readonly typedInputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly records: readonly PromptRecord[];
  readonly rs4: {
    readonly sampleSize: number;
    readonly allRoleMeasurements: readonly {
      readonly roleId: string;
      readonly bytes: number;
      readonly words: number;
    }[];
    readonly allRoleBytes: number;
    readonly allRoleWords: number;
    readonly representative: {
      readonly fixturePath: string;
      readonly fullPromptBytes: number;
      readonly fullPromptWords: number;
      readonly reference: string;
      readonly referenceBytes: number;
      readonly referenceWords: number;
      readonly input: string;
      readonly inputBytes: number;
      readonly inputWords: number;
      readonly compactBytes: number;
      readonly compactWords: number;
      readonly byteReductionPercent: number;
      readonly wordReductionPercent: number;
      readonly tokenizerTokens: string;
      readonly latency: string;
      readonly providerUsage: string;
    };
  };
}

interface FrozenFetchPrompt {
  readonly roleId: string;
  readonly kind: string;
  readonly dispatched: boolean;
  readonly promptTemplate: string;
  readonly promptSurface: string;
  readonly inputSchema: Readonly<Record<string, unknown>> & {
    readonly required?: readonly string[];
  };
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

interface Rs5Strategy {
  readonly serializedParentVisible: string;
  readonly parentVisibleBytes: number;
  readonly parentVisibleO200kTokens: number;
  readonly childBytes: number;
  readonly modelVisibleFullOutputCopies: number;
  readonly fetchCount: number;
  readonly validationCallCount: number;
  readonly parentRoundTrips: number;
}

interface Rs5Fixture {
  readonly sampleSize: number;
  readonly aggregateClaim: boolean;
  readonly crossHarnessClaim: boolean;
  readonly source: {
    readonly roleId: string;
    readonly resultSemanticValue: Readonly<Record<string, unknown>>;
  };
  readonly exactPair: {
    readonly childPayload: string;
    readonly validateOutputArguments: string;
    readonly validationResult: string;
    readonly childBytes: number;
    readonly childO200kTokens: number;
    readonly validationArgumentBytes: number;
    readonly validationArgumentO200kTokens: number;
    readonly validationResultBytes: number;
    readonly validationResultO200kTokens: number;
  };
  readonly strategies: {
    readonly legacyValidateOutput: Rs5Strategy;
    readonly refFirstSingleFetch: Rs5Strategy & {
      readonly acknowledgement: string;
      readonly fetchArguments: string;
      readonly terminalEnvelope: string;
    };
    readonly dispatcherFinalization: Rs5Strategy & {
      readonly terminalEnvelope: string;
    };
  };
  readonly latencyMs: {
    readonly legacyValidationToolCalls: {
      readonly sampleSize: number;
      readonly p50: number;
      readonly p95: number;
    };
    readonly exactChildToValidation: {
      readonly sampleSize: number;
      readonly observed: number;
    };
    readonly refFirstSingleFetch: string;
    readonly dispatcherFinalization: string;
  };
  readonly providerUsage: {
    readonly nearestEvent: {
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly outputTokens: number;
    };
    readonly attribution: string;
  };
  readonly corpusCoverage: Readonly<
    Record<
      string,
      {
        readonly validationCalls: number;
        readonly exactPairs: number;
        readonly successes: number;
        readonly failures: number;
      }
    >
  >;
}

function readJson<T>(fixturePath: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, fixturePath), "utf8")) as T;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function whitespaceWords(value: string): number {
  const trimmed = value.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const promptFixture = readJson<PromptFixture>("prompt-dispatch.json");
const rs5Fixture = readJson<Rs5Fixture>("rs5-codex-n1.json");

describe("T681 immutable legacy protocol measurements", () => {
  test("freezes one schema-bearing fetch response and compact input per role and surface", () => {
    expect(promptFixture.fixtureVersion).toBe(1);
    expect(promptFixture.scope).toEqual({
      sampleSizePerRoleSurface: 1,
      roles: DISPATCHED_ROLES,
      surfaces: SURFACES,
      aggregateClaim: false,
      crossHarnessClaim: false,
    });
    expect(promptFixture.records).toHaveLength(DISPATCHED_ROLES.length * SURFACES.length);

    const combinations = new Set<string>();
    for (const record of promptFixture.records) {
      combinations.add(`${record.surface}:${record.roleId}`);
      const raw = readFileSync(path.join(FIXTURE_ROOT, record.fixturePath), "utf8");
      const fetched = JSON.parse(raw) as FrozenFetchPrompt;
      const input = promptFixture.typedInputs[record.roleId];
      expect(input).toBeDefined();

      expect(utf8Bytes(raw)).toBe(record.legacyParentVisibleBytes);
      expect(sha256(raw)).toBe(record.sha256);
      expect(JSON.stringify(fetched)).toBe(raw);
      expect(fetched.roleId).toBe(record.roleId);
      expect(fetched.promptSurface).toBe(record.surface);
      expect(fetched.kind).toBe("dispatched-subagent");
      expect(fetched.dispatched).toBe(true);
      expect(fetched.inputSchema).toBeDefined();
      expect(fetched.outputSchema).toBeDefined();

      expect(validateAgainstSchema(fetched.inputSchema as JSONSchema, input).ok).toBe(true);
      expect(utf8Bytes(JSON.stringify({ roleId: record.roleId, input }))).toBe(
        record.compactParentVisibleBytes,
      );
      expect(utf8Bytes(fetched.promptTemplate)).toBe(record.childPromptBytes);
      expect(utf8Bytes(JSON.stringify(input))).toBe(record.typedInputBytes);
      expect(record.childPromptBytes + record.typedInputBytes).toBe(record.childBytes);
      expect(record.legacyFetchCount).toBe(1);
      expect(record.compactFetchCount).toBe(0);
    }

    expect([...combinations].sort()).toEqual(
      SURFACES.flatMap((surface) =>
        DISPATCHED_ROLES.map((roleId) => `${surface}:${roleId}`),
      ).sort(),
    );
    expect(
      Object.values(promptFixture.unavailable).every((value) => value.startsWith("Unavailable:")),
    ).toBe(true);
  });

  test("retains the exact RS4 representative bytes and compact comparison", () => {
    const rs4 = promptFixture.rs4;
    const representative = rs4.representative;
    const prompt = readFileSync(path.join(FIXTURE_ROOT, representative.fixturePath), "utf8");

    expect(rs4.sampleSize).toBe(1);
    expect(utf8Bytes(prompt)).toBe(representative.fullPromptBytes);
    expect(whitespaceWords(prompt)).toBe(representative.fullPromptWords);
    expect(representative.fullPromptBytes).toBe(10092);
    expect(representative.fullPromptWords).toBe(1453);
    expect(utf8Bytes(representative.reference)).toBe(representative.referenceBytes);
    expect(whitespaceWords(representative.reference)).toBe(representative.referenceWords);
    expect(utf8Bytes(representative.input)).toBe(representative.inputBytes);
    expect(whitespaceWords(representative.input)).toBe(representative.inputWords);
    expect(representative.referenceBytes + representative.inputBytes).toBe(197);
    expect(representative.referenceWords + representative.inputWords).toBe(11);
    expect(representative.compactBytes).toBe(197);
    expect(representative.compactWords).toBe(11);
    expect(representative.byteReductionPercent).toBeCloseTo(98.047959, 6);
    expect(representative.wordReductionPercent).toBeCloseTo(99.242946, 6);
    expect(rs4.allRoleMeasurements.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(
      rs4.allRoleBytes,
    );
    expect(rs4.allRoleMeasurements.reduce((sum, entry) => sum + entry.words, 0)).toBe(
      rs4.allRoleWords,
    );
    expect(rs4.allRoleBytes).toBe(103687);
    expect(rs4.allRoleWords).toBe(14787);
    expect(representative.tokenizerTokens).toStartWith("Unavailable:");
    expect(representative.latency).toStartWith("Unavailable:");
    expect(representative.providerUsage).toStartWith("Unavailable:");
  });

  test("retains the exact RS5 Codex N=1 resend and ref-first serializations", () => {
    const exact = rs5Fixture.exactPair;
    const legacy = rs5Fixture.strategies.legacyValidateOutput;
    const refFirst = rs5Fixture.strategies.refFirstSingleFetch;
    const dispatcher = rs5Fixture.strategies.dispatcherFinalization;

    expect(rs5Fixture.sampleSize).toBe(1);
    expect(rs5Fixture.aggregateClaim).toBe(false);
    expect(rs5Fixture.crossHarnessClaim).toBe(false);
    expect(utf8Bytes(exact.childPayload)).toBe(exact.childBytes);
    expect(utf8Bytes(exact.validateOutputArguments)).toBe(exact.validationArgumentBytes);
    expect(utf8Bytes(exact.validationResult)).toBe(exact.validationResultBytes);
    expect(exact).toMatchObject({
      childBytes: 1131,
      childO200kTokens: 273,
      validationArgumentBytes: 668,
      validationArgumentO200kTokens: 132,
      validationResultBytes: 74,
      validationResultO200kTokens: 27,
    });

    const fencedOutput = exact.childPayload.match(/```json\n([\s\S]+)\n```$/u);
    expect(fencedOutput).not.toBeNull();
    const argumentsValue = JSON.parse(exact.validateOutputArguments) as {
      readonly roleId: string;
      readonly output: Readonly<Record<string, unknown>>;
    };
    expect(JSON.parse(fencedOutput![1]!)).toEqual(argumentsValue.output);
    expect(argumentsValue.roleId).toBe(rs5Fixture.source.roleId);
    const resultWire = exact.validationResult.split("Output:\n")[1];
    expect(resultWire).toBeDefined();
    const resultContent = JSON.parse(resultWire!) as Array<{ readonly text: string }>;
    expect(JSON.parse(resultContent[0]!.text)).toEqual(rs5Fixture.source.resultSemanticValue);

    expect(legacy.serializedParentVisible).toBe(
      exact.childPayload + exact.validateOutputArguments + exact.validationResult,
    );
    expect(refFirst.serializedParentVisible).toBe(
      refFirst.acknowledgement + refFirst.fetchArguments + refFirst.terminalEnvelope,
    );
    expect(dispatcher.serializedParentVisible).toBe(dispatcher.terminalEnvelope);
    expect(utf8Bytes(legacy.serializedParentVisible)).toBe(1873);
    expect(utf8Bytes(refFirst.serializedParentVisible)).toBe(839);
    expect(utf8Bytes(dispatcher.serializedParentVisible)).toBe(745);

    expect(legacy).toMatchObject({
      parentVisibleO200kTokens: 432,
      childBytes: 1131,
      modelVisibleFullOutputCopies: 2,
      fetchCount: 0,
      validationCallCount: 1,
      parentRoundTrips: 2,
    });
    expect(refFirst).toMatchObject({
      parentVisibleO200kTokens: 207,
      childBytes: 1131,
      modelVisibleFullOutputCopies: 1,
      fetchCount: 1,
      validationCallCount: 0,
      parentRoundTrips: 2,
    });
    expect(dispatcher).toMatchObject({
      parentVisibleO200kTokens: 161,
      childBytes: 1131,
      modelVisibleFullOutputCopies: 1,
      fetchCount: 0,
      validationCallCount: 0,
      parentRoundTrips: 1,
    });
  });

  test("keeps latency, provider attribution, and harness coverage separate", () => {
    expect(rs5Fixture.latencyMs).toEqual({
      legacyValidationToolCalls: { sampleSize: 159, p50: 69, p95: 726 },
      exactChildToValidation: { sampleSize: 1, observed: 4919 },
      refFirstSingleFetch:
        "Unavailable: the experiment did not measure store or typed-fetch latency.",
      dispatcherFinalization:
        "Unavailable: the experiment did not measure dispatcher finalization latency.",
    });
    expect(rs5Fixture.providerUsage.nearestEvent).toEqual({
      inputTokens: 30774,
      cachedInputTokens: 29440,
      outputTokens: 173,
    });
    expect(rs5Fixture.providerUsage.attribution).toStartWith("Unavailable:");
    expect(rs5Fixture.corpusCoverage).toEqual({
      claude: { validationCalls: 1, exactPairs: 0, successes: 0, failures: 1 },
      codex: { validationCalls: 159, exactPairs: 1, successes: 153, failures: 6 },
      pi: { validationCalls: 0, exactPairs: 0, successes: 0, failures: 0 },
    });
  });

  test("keeps Pi command recursion distinct and all fixture data non-callable", () => {
    expect(promptFixture.piInlineCommandRecursion).toEqual({
      measuredAsDispatchedRole: false,
      roleKind: "orchestrator-command",
      mechanism: "fetch_prompt(commandRoleId)",
      example: 'fetch_prompt("plan")',
      reason:
        "Pi inline command recursion is a command-loading path, not parent materialization of a dispatched-subagent prompt.",
    });
    expect(promptFixture.scope.roles).not.toContain("plan");

    const fixtureFiles = readdirSync(FIXTURE_ROOT, { recursive: true })
      .map(String)
      .filter((entry) => !entry.endsWith(path.sep));
    expect(fixtureFiles.some((entry) => /\.[cm]?[jt]sx?$/u.test(entry))).toBe(false);

    const packageJson = JSON.parse(
      readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { readonly exports: Readonly<Record<string, unknown>> };
    expect(Object.keys(packageJson.exports).some((key) => key.includes("fixture"))).toBe(false);
    expect(JSON.stringify(packageJson.exports)).not.toContain("fixtures");
  });
});
