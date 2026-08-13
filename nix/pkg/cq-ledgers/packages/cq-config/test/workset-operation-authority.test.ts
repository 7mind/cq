/** T1980 role-profile confinement for the workset operation surface. */

import { describe, expect, test } from "bun:test";
import {
  exposedLedgerToolsForRole,
  ROLE_TOOL_CAPABILITY_MATRIX,
} from "../src/index.js";

describe("workset operation role authority", () => {
  test("exposes workset only through full-parent profiles", () => {
    const profiles = Object.values(ROLE_TOOL_CAPABILITY_MATRIX);
    const fullParents = profiles.filter((profile) =>
      profile.capabilities.includes("full-parent-access"),
    );
    expect(fullParents.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      expect(exposedLedgerToolsForRole(profile.roleId).includes("workset")).toBe(
        profile.capabilities.includes("full-parent-access"),
      );
    }
  });
});
