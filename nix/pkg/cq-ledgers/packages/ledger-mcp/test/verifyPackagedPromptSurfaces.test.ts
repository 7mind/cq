import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { PROMPT_CATALOG_PROJECTION } from "../../cq-config/src/promptCatalog.gen.js";
import { assertPackagedRoleClosure } from "../src/packagedPromptRoleClosure.js";

const SURFACES = ["claude", "codex", "pi"] as const;

describe("packaged prompt role closure", () => {
  for (const surface of SURFACES) {
    test(`${surface} accepts the exact catalog set and rejects a same-cardinality substitution`, () => {
      const roleRoot = path.join("packaged", surface, "roles");
      const expectedRoleIds = PROMPT_CATALOG_PROJECTION.catalog.map(({ roleId }) => roleId);
      const expectedRoleFiles = expectedRoleIds.map((roleId) =>
        path.join(roleRoot, `${roleId}.md`),
      );

      expect(() =>
        assertPackagedRoleClosure(surface, roleRoot, expectedRoleIds, expectedRoleFiles),
      ).not.toThrow();

      const substitutedRoleFiles = [
        ...expectedRoleFiles.slice(1),
        path.join(roleRoot, "stale-role.md"),
      ].sort();
      expect(() =>
        assertPackagedRoleClosure(surface, roleRoot, expectedRoleIds, substitutedRoleFiles),
      ).toThrow(/missing .*; unexpected /);
    });
  }
});
