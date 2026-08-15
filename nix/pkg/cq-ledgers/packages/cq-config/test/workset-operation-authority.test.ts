/** T1980 role-profile confinement for the workset operation surface. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("keeps management and internal admission capabilities out of every child profile", () => {
    for (const profile of Object.values(ROLE_TOOL_CAPABILITY_MATRIX)) {
      const exposed = exposedLedgerToolsForRole(profile.roleId);
      if (profile.capabilities.includes("full-parent-access")) {
        expect(exposed, profile.roleId).toContain("workset");
        expect(exposed, profile.roleId).toContain("create_item");
        continue;
      }
      expect(exposed, profile.roleId).not.toContain("workset");
      expect(exposed, profile.roleId).not.toContain("create_ledger");
      expect(profile.capabilities, profile.roleId).not.toContain("full-parent-access");
    }
  });

  test("administrative CLI paths construct trusted stores and enter exclusive admission", () => {
    const cliMain = readFileSync(
      join(import.meta.dir, "..", "..", "cq-cli", "src", "main.ts"),
      "utf8",
    );
    const migrate = readFileSync(
      join(import.meta.dir, "..", "..", "cq-cli", "src", "migrate.ts"),
      "utf8",
    );
    expect(cliMain).toContain("createManagementLedgerStore");
    expect(cliMain).toContain("workset.runAdministrative");
    expect(migrate).toContain("createManagementLedgerStore");
    expect(migrate).toContain("workset.runAdministrative");
  });
});
