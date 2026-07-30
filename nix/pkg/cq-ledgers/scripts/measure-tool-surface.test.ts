import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { LEDGER_TOOL_NAMES, NON_DISPATCH_LEDGER_TOOL_NAMES } from "../packages/ledger/src/index.js";
import {
  PROFILE_NAMES,
  measureToolSurfaces,
  serializeToolSurfaceMeasurement,
} from "./measure-tool-surface.js";

const BASELINE_PATH = resolve(import.meta.dir, "baselines/g129-tool-surface.json");
const TARGET_PATH = resolve(import.meta.dir, "baselines/t1326-tool-surface-target.json");

test("the profiler preserves G129 evidence and matches the T1326 target", async () => {
  const baseline = readFileSync(BASELINE_PATH);
  const target = JSON.parse(readFileSync(TARGET_PATH, "utf8")) as {
    basedOn: { baselineSha256: string };
    target: { publicToolInventory: string[]; publicToolCount: number };
  };
  const first = await measureToolSurfaces(PROFILE_NAMES);
  const second = await measureToolSurfaces(PROFILE_NAMES);
  const firstJson = serializeToolSurfaceMeasurement(first);
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
      (profile) => profile.toolsList.serialization.length > 2,
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
  });
  expect(first.profiles.full.toolCount).toBe(target.target.publicToolCount);
  expect(LEDGER_TOOL_NAMES).toHaveLength(target.target.publicToolCount);
});
