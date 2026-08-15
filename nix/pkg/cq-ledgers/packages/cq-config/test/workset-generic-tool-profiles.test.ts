/** T1982 confinement of ordinary mutation tools to contextual public profiles. */

import { describe, expect, test } from "bun:test";
import {
  exposedLedgerToolsForRole,
  LEDGER_CAPABILITY_TOOL_NAMES,
  ROLE_TOOL_CAPABILITY_MATRIX,
} from "../src/index.js";

const ORDINARY_MUTATION_TOOLS = [
  "update_item",
  "create_item",
  "create_ledger",
  "archive_milestone",
  "reopen_item",
  "unarchive_item",
] as const;

const INTERNAL_MUTATION_SURFACES = [
  "runAtomicGenericMutation",
  "worksetContext",
  "admission",
  "invocationAuthority",
] as const;

describe("workset generic mutation role profiles", () => {
  test("full-parent profiles expose every contextual ordinary mutation tool", () => {
    for (const profile of Object.values(ROLE_TOOL_CAPABILITY_MATRIX)) {
      if (!profile.capabilities.includes("full-parent-access")) continue;
      const exposed = exposedLedgerToolsForRole(profile.roleId);
      for (const tool of ORDINARY_MUTATION_TOOLS) {
        expect(exposed, `${profile.roleId}:${tool}`).toContain(tool);
      }
    }
  });

  test("child profiles expose no ordinary mutation tool", () => {
    for (const profile of Object.values(ROLE_TOOL_CAPABILITY_MATRIX)) {
      if (profile.capabilities.includes("full-parent-access")) continue;
      const exposed = exposedLedgerToolsForRole(profile.roleId);
      for (const tool of ORDINARY_MUTATION_TOOLS) {
        expect(exposed.includes(tool), `${profile.roleId}:${tool}`).toBe(false);
      }
    }
  });

  test("the public capability inventory contains no raw mutation authority", () => {
    for (const internal of INTERNAL_MUTATION_SURFACES) {
      expect(LEDGER_CAPABILITY_TOOL_NAMES).not.toContain(internal);
    }
  });
});
