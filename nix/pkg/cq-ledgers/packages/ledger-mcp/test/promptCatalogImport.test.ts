/**
 * T341 — the node-free typed prompt catalog is importable by ledger-mcp DIRECTLY.
 *
 * Acceptance requires the typed catalog (in `@cq/config`) be importable by
 * ledger-mcp with no duplicate copy. ledger-mcp already declares `@cq/config` as
 * a dependency (for `loadConfig`/`AGENT_ROLE_TIERS`); this test imports the typed
 * catalog STORE from the SAME package and asserts the sidecars are usable here —
 * if the import did not resolve/compile, this test file would not typecheck or
 * run, proving importability. The validate-in/out flow (later chain tasks) lives
 * server-side, so this is exactly where importability matters.
 *
 * The schemas are PLAIN JSON Schema data (draft 2020-12); compiling them with a
 * validator is exercised in the `@cq/config` test (where Ajv is a direct dep).
 * Here we only need to prove the typed catalog RESOLVES and carries the contract
 * — so this test does NOT pull Ajv into ledger-mcp (which is not, and need not
 * be, an ledger-mcp dependency).
 */

import { describe, it, expect } from "bun:test";
import {
  AGENT_ROLE_TIERS,
  DISPATCHED_ROLE_SIDECARS,
  getRoleSidecar,
  type RoleSchemaSidecar,
  type JSONSchema,
} from "@cq/config";

/** Minimal structural check that a value is a JSON-Schema object (draft 2020-12). */
function looksLikeSchema(schema: JSONSchema): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    schema.$schema === "https://json-schema.org/draft/2020-12/schema"
  );
}

describe("typed prompt catalog is importable by ledger-mcp (T341)", () => {
  it("imports the dispatched-role sidecar store from @cq/config", () => {
    expect(Object.keys(DISPATCHED_ROLE_SIDECARS).length).toBe(9);
  });

  it("every dispatched-subagent role in the shared roster resolves a sidecar here", () => {
    for (const role of AGENT_ROLE_TIERS) {
      const sidecar = getRoleSidecar(role.id);
      if (role.agentTierKey === null) {
        expect(sidecar).toBeUndefined();
      } else {
        expect(sidecar).toBeDefined();
      }
    }
  });

  it("an imported sidecar carries a draft-2020-12 input + output schema", () => {
    const sidecar: RoleSchemaSidecar | undefined = getRoleSidecar("implement-worker");
    expect(sidecar).toBeDefined();
    expect(sidecar!.id).toBe("implement-worker");
    expect(looksLikeSchema(sidecar!.inputSchema)).toBe(true);
    expect(looksLikeSchema(sidecar!.outputSchema)).toBe(true);
  });
});
