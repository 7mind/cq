import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { LEDGER_CAPABILITY_TOOL_NAMES } from "../../cq-config/src/index.js";
import { measureToolSurfaceTarget, serializeToolSurfaceTarget } from "./toolSurfaceTarget.js";

const TARGET_PATH = resolve(
  import.meta.dir,
  "../../../scripts/baselines/t1326-tool-surface-target.json",
);

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

test("the measured breaking-surface target is complete", async () => {
  const targetBytes = readFileSync(TARGET_PATH, "utf8");
  const target = JSON.parse(targetBytes) as Awaited<ReturnType<typeof measureToolSurfaceTarget>>;
  const measured = await measureToolSurfaceTarget();
  const targetInventory = new Set(target.target.publicToolInventory);
  const migrationNames = target.migrationMap.map(({ removedTool }) => removedTool).sort();
  const mappedPathsAreComplete = target.migrationMap.every(({ coverage }) => {
    const categorized = [
      ...coverage.callers,
      ...coverage.documentation,
      ...coverage.contractTests,
      ...coverage.generatedArtifacts,
    ].sort();
    return (
      coverage.callers.length > 0 &&
      coverage.documentation.length > 0 &&
      new Set(categorized).size === categorized.length &&
      JSON.stringify(categorized) === JSON.stringify(coverage.matchedPaths)
    );
  });
  const contract = {
    matchesCheckedInTarget: serializeToolSurfaceTarget(measured) === targetBytes,
    selectedChangesReduceWholeSerializations: target.selected.every(
      ({ measurement }) =>
        measurement.method === "independent whole-value JSON.stringify with o200k_base" &&
        measurement.deltaTokens > 0 &&
        measurement.current.tokens > measurement.counterfactual.tokens,
    ),
    rejectedConsolidationsRecordMeasuredReasons: target.rejected
      .filter(({ kind }) => kind === "consolidation")
      .every(
        ({ measuredReason, measurement }) =>
          measuredReason.length > 0 &&
          measurement.method === "independent whole-value JSON.stringify with o200k_base" &&
          measurement.current.sha256 !== measurement.counterfactual.sha256,
      ),
    roleCapabilityUnionPreserved:
      JSON.stringify(
        sortedUnique(
          Object.values(target.target.roleProfiles).flatMap(
            ({ preservedCapabilities }) => preservedCapabilities,
          ),
        ),
      ) === JSON.stringify([...LEDGER_CAPABILITY_TOOL_NAMES].sort()),
    targetRoleToolUnionMatchesInventory:
      JSON.stringify(
        sortedUnique(Object.values(target.target.roleProfiles).flatMap(({ tools }) => tools)),
      ) === JSON.stringify([...target.target.publicToolInventory].sort()),
    requiredCapabilitiesRemainPublic: Object.values(target.target.requiredCapabilityCoverage)
      .flat()
      .every((tool) => targetInventory.has(tool)),
    everyRemovalHasOneCompleteMigration:
      JSON.stringify(migrationNames) ===
        JSON.stringify([...target.target.removedPublicTools].sort()) &&
      mappedPathsAreComplete &&
      target.migrationMap.every(({ replacement }) => targetInventory.has(replacement)),
    everyRenameHasOneCompleteMigration: target.target.renamedPublicTools.length === 0,
    combinedTargetReducesWholeSurface:
      target.target.fullToolsListMeasurement.deltaTokens > 0 &&
      target.target.completeRoleContextMeasurement.deltaTokens > 0,
  };

  expect(contract).toEqual({
    matchesCheckedInTarget: true,
    selectedChangesReduceWholeSerializations: true,
    rejectedConsolidationsRecordMeasuredReasons: true,
    roleCapabilityUnionPreserved: true,
    targetRoleToolUnionMatchesInventory: true,
    requiredCapabilitiesRemainPublic: true,
    everyRemovalHasOneCompleteMigration: true,
    everyRenameHasOneCompleteMigration: true,
    combinedTargetReducesWholeSurface: true,
  });
});
