import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { LEDGER_TOOL_NAMES, NON_DISPATCH_LEDGER_TOOL_NAMES } from "../packages/ledger/src/index.js";
import {
  PROFILE_NAMES,
  buildNormalizedAfterArtifact,
  measureToolSurfaces,
  serializeToolSurfaceMeasurement,
} from "./measure-tool-surface.js";

const EVIDENCE_DIR = resolve(
  import.meta.dir,
  "../docs/drafts/20260731-0216-g129-tool-surface",
);
const BASELINE_PATH = resolve(EVIDENCE_DIR, "baseline.json");
const AFTER_PATH = resolve(EVIDENCE_DIR, "after.json");
const TARGET_PATH = resolve(import.meta.dir, "baselines/t1326-tool-surface-target.json");
// D293: full-suite contention can exceed 10s for multi-profile measurement.
const T1331_COUNTERFACTUAL_TIMEOUT_MS = 30_000;
type HistoricalMeasurement = Parameters<typeof buildNormalizedAfterArtifact>[1];

function historicalMeasurement(): HistoricalMeasurement {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as HistoricalMeasurement;
}

test("the profiler preserves G129 evidence and matches the T1326 target", async () => {
  const baseline = readFileSync(BASELINE_PATH);
  const target = JSON.parse(readFileSync(TARGET_PATH, "utf8")) as {
    basedOn: { baselineSha256: string };
    target: { publicToolInventory: string[]; publicToolCount: number };
  };
  const first = await measureToolSurfaces(PROFILE_NAMES);
  const second = await measureToolSurfaces(PROFILE_NAMES);
  const firstJson = serializeToolSurfaceMeasurement(first);
  const normalized = buildNormalizedAfterArtifact(
    first,
    historicalMeasurement(),
    "docs/drafts/20260731-0216-g129-tool-surface/baseline.json",
  );
  const normalizedJson = `${JSON.stringify(normalized, null, 2)}\n`;
  const contract = {
    historicalBaselineSha256: createHash("sha256").update(baseline).digest("hex"),
    repeatIsByteIdentical: firstJson === serializeToolSurfaceMeasurement(second),
    profiles: Object.keys(first.profiles),
    durableDispatchInventory: first.profiles.full.inventory,
    nonDispatchInventory: first.profiles["non-dispatch"].inventory,
    initializeInstructionsIncluded: Object.values(first.profiles).every(
      (profile) => profile.initialize.instructions.serialization.length > 2,
    ),
    toolsListSerializationIncluded: Object.values(first.profiles).every(
      (profile) =>
        (JSON.parse(profile.toolsList.serialization) as unknown[]).length === profile.toolCount,
    ),
    everyToolDecomposed: Object.values(first.profiles).every((profile) =>
      profile.tools.every(
        (tool) =>
          Number.isInteger(tool.components.name.tokens) &&
          Number.isInteger(tool.components.description.tokens) &&
          Number.isInteger(tool.components.inputSchema.tokens) &&
          tool.schemaPaths.length > 0 &&
          tool.schemaPaths.every(
            (path) =>
              Number.isInteger(path.measurement.tokens) && Number.isInteger(path.marginalTokens),
          ),
      ),
    ),
    normalizedArtifactIsCurrent: normalizedJson === readFileSync(AFTER_PATH, "utf8"),
    budgets: normalized.budgets,
    measuredProfiles: Object.keys(normalized.profiles).length,
    corpusTranscripts: normalized.roleWeightedExposure.transcripts,
    maximumRemainingG93AttributableTokens:
      normalized.g93.maximumRemainingG93AttributableTokens,
    corpusMedianResponseSavingTokens: normalized.g93.corpusMedianResponseSavingTokens,
    transportTools: normalized.transportOnlyOverhead.tools,
    everyToolHasFieldDeltas: normalized.perToolAndFieldDeltas.every((tool) =>
      ["name", "description", "inputSchema"].every((field) =>
        Number.isInteger(
          tool.fields[field as keyof typeof tool.fields].delta.serializedTokens,
        ),
      ),
    ),
  };

  expect(contract).toEqual({
    historicalBaselineSha256: target.basedOn.baselineSha256,
    repeatIsByteIdentical: true,
    profiles: [...PROFILE_NAMES],
    durableDispatchInventory: [...target.target.publicToolInventory].sort(),
    nonDispatchInventory: [...NON_DISPATCH_LEDGER_TOOL_NAMES].sort(),
    initializeInstructionsIncluded: true,
    toolsListSerializationIncluded: true,
    everyToolDecomposed: true,
    normalizedArtifactIsCurrent: true,
    budgets: {
      tokenizerMatches: true,
      methodMatches: true,
      allSurfacesSmaller: true,
      allRequiredCallsCovered: true,
      zeroDomainProfilesHaveZeroDomainSchemaTokens: true,
      g93BelowCorpusMedian: true,
      passed: true,
      failures: [],
    },
    measuredProfiles: 27,
    corpusTranscripts: 357,
    // 817 -> 886 under T1993: fetch_prompt gained the optional projection
    // argument (D269 schema projection). Decomposition (after.json):
    // +14 inputSchema tokens (the new projection property) and +55
    // authoritative-response tokens (the longer Authoritative response:
    // sentence in wireResponseContract.ts documenting both projections).
    // 886 -> 891 under T1267: release_plan_claim acknowledgement docs gained
    // tasks/waitingTasks fields (+5 G93-attributable response tokens).
    // 891 -> 946 under T1306: worktree_manage added (+55 G93-attributable
    // response/description tokens on full-parent profiles).
    // 946 -> 961 under T1422: ITEM_PROJECTION_DESCRIPTION documents complement
    // + merge invariant (+15 G93-attributable description tokens).
    // 961 -> 1010 under T2042: the worker-only git_commit broker adds its
    // response/description contract to full-parent profiles.
    // 1010 -> 1060 under T2043: the resolver-only git_resolve_continue broker
    // adds its response/description contract to full-parent profiles.
    // 1060 -> 1177: the four operator-action lifecycle tools add their closed
    // schemas and purpose-built response contracts to full-parent profiles.
    // 1177 -> 1188: revision fencing adds revise_operator_action and the
    // expected_revision schemas while retaining concise response contracts.
    // 1188 -> 1310: complement adds its exact envelope and the compact /
    // complement partition invariant to every item-bearing read.
    // 1310 -> 1294 under T1980: the shared projection description retains the
    // partition invariant without repeating the projection field taxonomy.
    // 1294 -> 1277 under T1532: create_ledger no longer repeats its fixed
    // acknowledgement before the authoritative response carrying the same DTO.
    maximumRemainingG93AttributableTokens: 1277,
    corpusMedianResponseSavingTokens: 1461,
    transportTools: ["fetch_dispatch_input", "store_result"],
    everyToolHasFieldDeltas: true,
  });
  expect(first.profiles.full.toolCount).toBe(target.target.publicToolCount);
  expect(LEDGER_TOOL_NAMES).toHaveLength(target.target.publicToolCount);
});

test("every T1331 budget detector rejects its own counterfactual drift", async () => {
  const measured = await measureToolSurfaces(PROFILE_NAMES);
  const baseline = historicalMeasurement();
  const artifact = (
    current: typeof measured,
    historical: HistoricalMeasurement = baseline,
  ) =>
    buildNormalizedAfterArtifact(
      current,
      historical,
      "docs/drafts/20260731-0216-g129-tool-surface/baseline.json",
    );

  const tokenizerDrift = artifact(measured, {
    ...baseline,
    tokenizer: { ...baseline.tokenizer, version: "3.4.0-mutated" },
  } as HistoricalMeasurement);
  const methodDrift = artifact(measured, {
    ...baseline,
    method: { ...baseline.method, serialization: "mutated" },
  } as HistoricalMeasurement);
  const surfaceDrift = structuredClone(measured);
  surfaceDrift.profiles.full.toolsList.tokens =
    baseline.profiles.full.initialize.instructions.tokens +
    baseline.profiles.full.toolsList.tokens;
  const requiredCallDrift = structuredClone(measured);
  requiredCallDrift.profiles["plan-advance"].requiredCallInventoryCovered = false;
  const zeroDomainDrift = structuredClone(measured);
  zeroDomainDrift.profiles["implement-worker"].domainInputSchemaTokens = 1;
  const g93Drift = structuredClone(measured);
  g93Drift.profiles.full.responseContractCounterfactual.allTokens = 1461;

  expect({
    tokenizerMatches: tokenizerDrift.budgets.tokenizerMatches,
    methodMatches: methodDrift.budgets.methodMatches,
    allSurfacesSmaller: artifact(surfaceDrift).budgets.allSurfacesSmaller,
    allRequiredCallsCovered: artifact(requiredCallDrift).budgets.allRequiredCallsCovered,
    zeroDomainProfilesHaveZeroDomainSchemaTokens:
      artifact(zeroDomainDrift).budgets.zeroDomainProfilesHaveZeroDomainSchemaTokens,
    g93BelowCorpusMedian: artifact(g93Drift).budgets.g93BelowCorpusMedian,
  }).toEqual({
    tokenizerMatches: false,
    methodMatches: false,
    allSurfacesSmaller: false,
    allRequiredCallsCovered: false,
    zeroDomainProfilesHaveZeroDomainSchemaTokens: false,
    g93BelowCorpusMedian: false,
  });
  // The profiler's synchronous work must yield for Bun to observe this timeout.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}, T1331_COUNTERFACTUAL_TIMEOUT_MS);
