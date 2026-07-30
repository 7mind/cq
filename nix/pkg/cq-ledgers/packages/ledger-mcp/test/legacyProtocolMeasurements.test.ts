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
const PROMPT_RECORDS_SHA256 = "ac9c355f95c129558c9629fb6f86b8e404aea920ee65636b55833bb7958a5a16";
const PROMPT_TYPED_INPUTS_SHA256 =
  "c45b977797cc8709aad2c8adee6fba57d1ba1a675e5f6e7d349562e5224cec07";
const PROMPT_UNAVAILABLE = {
  parentVisibleTokens:
    "Unavailable: no tokenizer was run for the 27 surface-specific serialization fixtures.",
  childTokens: "Unavailable: no tokenizer was run for the 27 rendered child prompt fixtures.",
  latency: "Unavailable: deterministic serialization performed no provider or dispatch timing.",
  providerUsage: "Unavailable: deterministic serialization has no provider usage attribution.",
} as const;
const RS4_ROLE_MEASUREMENTS = [
  { roleId: "plan-advance", bytes: 32939, words: 4551 },
  { roleId: "plan-reviewer", bytes: 11831, words: 1691 },
  { roleId: "implement-worker", bytes: 6902, words: 1022 },
  { roleId: "implement-reviewer", bytes: 6847, words: 993 },
  { roleId: "implement-conflict-resolver", bytes: 4276, words: 628 },
  { roleId: "investigate-explorer", bytes: 8170, words: 1169 },
  { roleId: "investigate-prober", bytes: 10164, words: 1491 },
  { roleId: "research-explorer", bytes: 10092, words: 1453 },
  { roleId: "research-experimenter", bytes: 12466, words: 1789 },
] as const;
const RS4_REPRESENTATIVE = {
  sha256: "1ffcc02930c646322eaf26ea89a54439b444a17192da7e407cf10b7dea4722d0",
  reference: '{"roleId":"research-explorer","version":1}',
  input:
    '{"hypothesisId":"H104","statement":"Resolve catalog prompts inside dispatch_subagent","branchContext":"RS4 root; test dispatcher-side catalog resolution."}',
} as const;
const RS5_EXACT_PAIR_SHA256 = {
  childPayload: "20d678c75b495cdada4a8f1dbdde00c1b319b442a3d82122672777c5e60465e3",
  validateOutputArguments: "69bc1b6fafd62607239d3b711665d474a4c325db50fd00ccfc50bd3c0b3d0f2d",
  validationResult: "8c74aec4f14647ccffe18e37649d2ec52ea39445151419c9a92c94f6eb9e1195",
} as const;
const RS5_STRATEGIES = {
  legacyValidateOutput: {
    serializedParentVisible: "3f105d14311aef59199e197c79c1a4baa50dda0cd20d7010c8c114b59cde35ad",
    parentVisibleBytes: 1873,
    parentVisibleO200kTokens: 432,
    childBytes: 1131,
    modelVisibleFullOutputCopies: 2,
    fetchCount: 0,
    validationCallCount: 1,
    parentRoundTrips: 2,
  },
  refFirstSingleFetch: {
    acknowledgement: "c8f70520f9f9cc574b54d197e4f109dccfcaace1b270c9264dcffffe0c3bc206",
    fetchArguments: "c8f70520f9f9cc574b54d197e4f109dccfcaace1b270c9264dcffffe0c3bc206",
    terminalEnvelope: "73cdc77e939a28cfcef4b93735999a66ebfbee1dfd509f8830ffa31cdb55ac52",
    serializedParentVisible: "780bbff49409dd31485e0ee04b6a53a5ab1e3ce4453600d0a7b433bb4634e7d5",
    parentVisibleBytes: 839,
    parentVisibleO200kTokens: 207,
    childBytes: 1131,
    modelVisibleFullOutputCopies: 1,
    fetchCount: 1,
    validationCallCount: 0,
    parentRoundTrips: 2,
  },
  dispatcherFinalization: {
    terminalEnvelope: "73cdc77e939a28cfcef4b93735999a66ebfbee1dfd509f8830ffa31cdb55ac52",
    serializedParentVisible: "73cdc77e939a28cfcef4b93735999a66ebfbee1dfd509f8830ffa31cdb55ac52",
    parentVisibleBytes: 745,
    parentVisibleO200kTokens: 161,
    childBytes: 1131,
    modelVisibleFullOutputCopies: 1,
    fetchCount: 0,
    validationCallCount: 0,
    parentRoundTrips: 1,
  },
} as const;

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
  readonly frozenAtCommit: string;
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
    readonly researchId: string;
    readonly sampleSize: number;
    readonly frozenAtCommit: string;
    readonly allRoleMeasurements: readonly {
      readonly roleId: string;
      readonly bytes: number;
      readonly words: number;
    }[];
    readonly allRoleBytes: number;
    readonly allRoleWords: number;
    readonly representative: {
      readonly roleId: string;
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
  readonly fixtureVersion: number;
  readonly researchId: string;
  readonly hypothesisId: string;
  readonly harness: string;
  readonly frozenAtCommit: string;
  readonly sampleSize: number;
  readonly aggregateClaim: boolean;
  readonly crossHarnessClaim: boolean;
  readonly source: {
    readonly baseCommit: string;
    readonly corpusCutoff: string;
    readonly corpusManifestSha256: string;
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
    expect(promptFixture.frozenAtCommit).toBe("1f0af11883b94ea95b1a7ead4f2013231aa5944f");
    expect(promptFixture.scope).toEqual({
      sampleSizePerRoleSurface: 1,
      roles: DISPATCHED_ROLES,
      surfaces: SURFACES,
      aggregateClaim: false,
      crossHarnessClaim: false,
    });
    expect(promptFixture.records).toHaveLength(DISPATCHED_ROLES.length * SURFACES.length);
    expect(sha256(JSON.stringify(promptFixture.records))).toBe(PROMPT_RECORDS_SHA256);
    expect(sha256(JSON.stringify(promptFixture.typedInputs))).toBe(PROMPT_TYPED_INPUTS_SHA256);

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
    expect(promptFixture.unavailable).toEqual(PROMPT_UNAVAILABLE);
  });

  test("retains the exact RS4 representative bytes and compact comparison", () => {
    const rs4 = promptFixture.rs4;
    const representative = rs4.representative;
    const prompt = readFileSync(path.join(FIXTURE_ROOT, representative.fixturePath), "utf8");

    expect(rs4.researchId).toBe("RS4");
    expect(rs4.sampleSize).toBe(1);
    expect(rs4.frozenAtCommit).toBe("96823788f5b47440b5f74d4ba5ff7ccfe95cccb8");
    expect(rs4.allRoleMeasurements).toEqual(RS4_ROLE_MEASUREMENTS);
    expect(representative.roleId).toBe("research-explorer");
    expect(representative.fixturePath).toBe("rs4-research-explorer.md");
    expect(sha256(prompt)).toBe(RS4_REPRESENTATIVE.sha256);
    expect(utf8Bytes(prompt)).toBe(representative.fullPromptBytes);
    expect(whitespaceWords(prompt)).toBe(representative.fullPromptWords);
    expect(representative.fullPromptBytes).toBe(10092);
    expect(representative.fullPromptWords).toBe(1453);
    expect(representative.reference).toBe(RS4_REPRESENTATIVE.reference);
    expect(representative.input).toBe(RS4_REPRESENTATIVE.input);
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

    expect(rs5Fixture.fixtureVersion).toBe(1);
    expect(rs5Fixture.researchId).toBe("RS5");
    expect(rs5Fixture.hypothesisId).toBe("H108");
    expect(rs5Fixture.harness).toBe("codex");
    expect(rs5Fixture.frozenAtCommit).toBe("104d1c2f8fb962a852152bafdf26c7f0a0d27859");
    expect(rs5Fixture.source).toEqual({
      baseCommit: "104d1c2f8fb962a852152bafdf26c7f0a0d27859",
      corpusCutoff: "2026-07-24T17:52:41.427Z",
      corpusManifestSha256: "2b3c136fe963ea1fb72e07f1ab0f01d5b2244f36e051502f10f352497ddcfb46",
      roleId: "implement-reviewer",
      resultSemanticValue: { ok: true },
    });
    expect(rs5Fixture.sampleSize).toBe(1);
    expect(rs5Fixture.aggregateClaim).toBe(false);
    expect(rs5Fixture.crossHarnessClaim).toBe(false);
    expect(utf8Bytes(exact.childPayload)).toBe(exact.childBytes);
    expect(utf8Bytes(exact.validateOutputArguments)).toBe(exact.validationArgumentBytes);
    expect(utf8Bytes(exact.validationResult)).toBe(exact.validationResultBytes);
    expect({
      childPayload: sha256(exact.childPayload),
      validateOutputArguments: sha256(exact.validateOutputArguments),
      validationResult: sha256(exact.validationResult),
    }).toEqual(RS5_EXACT_PAIR_SHA256);
    expect({
      legacyValidateOutput: {
        ...legacy,
        serializedParentVisible: sha256(legacy.serializedParentVisible),
      },
      refFirstSingleFetch: {
        ...refFirst,
        acknowledgement: sha256(refFirst.acknowledgement),
        fetchArguments: sha256(refFirst.fetchArguments),
        terminalEnvelope: sha256(refFirst.terminalEnvelope),
        serializedParentVisible: sha256(refFirst.serializedParentVisible),
      },
      dispatcherFinalization: {
        ...dispatcher,
        terminalEnvelope: sha256(dispatcher.terminalEnvelope),
        serializedParentVisible: sha256(dispatcher.serializedParentVisible),
      },
    }).toEqual(RS5_STRATEGIES);
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
    expect(utf8Bytes(legacy.serializedParentVisible)).toBe(legacy.parentVisibleBytes);
    expect(utf8Bytes(refFirst.serializedParentVisible)).toBe(refFirst.parentVisibleBytes);
    expect(utf8Bytes(dispatcher.serializedParentVisible)).toBe(dispatcher.parentVisibleBytes);
    expect(utf8Bytes(legacy.serializedParentVisible)).toBe(1873);
    expect(utf8Bytes(refFirst.serializedParentVisible)).toBe(839);
    expect(utf8Bytes(dispatcher.serializedParentVisible)).toBe(745);
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
