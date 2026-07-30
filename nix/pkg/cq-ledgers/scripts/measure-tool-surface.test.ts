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

test("the profiler matches the deterministic G129 baseline contract", async () => {
  const first = await measureToolSurfaces(PROFILE_NAMES);
  const second = await measureToolSurfaces(PROFILE_NAMES);
  const firstJson = serializeToolSurfaceMeasurement(first);
  const contract = {
    matchesCheckedInBaseline: firstJson === readFileSync(BASELINE_PATH, "utf8"),
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
    matchesCheckedInBaseline: true,
    repeatIsByteIdentical: true,
    profiles: [...PROFILE_NAMES],
    durableDispatchInventory: [...LEDGER_TOOL_NAMES].sort(),
    nonDispatchInventory: [...NON_DISPATCH_LEDGER_TOOL_NAMES].sort(),
    initializeInstructionsIncluded: true,
    toolsListSerializationIncluded: true,
    everyToolDecomposed: true,
  });
});
