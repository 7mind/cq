/**
 * T341 — the typed prompt-catalog STORE over the full dispatched-subagent roster.
 *
 * Generalises the T336 one-role proof (plan-advance) across ALL dispatched roles:
 *  - every dispatched role's input + output JSON Schemas COMPILE under Ajv2020
 *    (the chosen validator) — i.e. they are valid JSON Schema (draft 2020-12);
 *  - the store's key set EXACTLY equals the dispatched-subagent subset of the
 *    shared roster (AGENT_ROLE_TIERS, non-null agentTierKey) — the roster
 *    cross-check that keeps the typed catalog from drifting from the roster;
 *  - orchestrator-command roles have NO sidecar (role-scope decision 1).
 */

import { describe, expect, test } from "bun:test";
// The 2020-12 dialect entrypoint: the catalog schemas declare
// `$schema: …/draft/2020-12/schema`, so they must compile under Ajv's 2020 build.
import Ajv2020 from "ajv/dist/2020";
import {
  AGENT_ROLE_TIERS,
  DISPATCHED_ROLE_SIDECARS,
  DISPATCHED_ROLE_IDS,
  getRoleSidecar,
} from "@cq/config";

/** A fresh Ajv compiling draft 2020-12 schemas; `strict:false` allows annotations. */
function newAjv(): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true });
}

/** The dispatched-subagent role ids derived directly from the shared roster. */
const ROSTER_DISPATCHED_IDS = AGENT_ROLE_TIERS.filter((r) => r.agentTierKey !== null).map(
  (r) => r.id,
);
/** The orchestrator-command role ids (null agentTierKey) — must have NO sidecar. */
const ROSTER_COMMAND_IDS = AGENT_ROLE_TIERS.filter((r) => r.agentTierKey === null).map(
  (r) => r.id,
);

describe("typed prompt-catalog store — roster cross-check (T341)", () => {
  test("the store covers EXACTLY the dispatched-subagent roster subset, in order", () => {
    expect([...DISPATCHED_ROLE_IDS]).toEqual(ROSTER_DISPATCHED_IDS);
    expect(Object.keys(DISPATCHED_ROLE_SIDECARS)).toEqual(ROSTER_DISPATCHED_IDS);
  });

  test("there are exactly 9 dispatched-subagent roles", () => {
    expect(ROSTER_DISPATCHED_IDS.length).toBe(9);
  });

  test("every orchestrator-command role has NO sidecar", () => {
    for (const id of ROSTER_COMMAND_IDS) {
      expect(getRoleSidecar(id)).toBeUndefined();
    }
  });

  test("each sidecar's id matches its store key", () => {
    for (const [key, sidecar] of Object.entries(DISPATCHED_ROLE_SIDECARS)) {
      expect(sidecar.id).toBe(key);
    }
  });
});

describe("typed prompt-catalog store — schemas validate as JSON Schema (T341)", () => {
  for (const id of ROSTER_DISPATCHED_IDS) {
    test(`role "${id}": inputSchema + outputSchema compile under Ajv2020`, () => {
      const sidecar = getRoleSidecar(id);
      expect(sidecar).toBeDefined();
      const ajv = newAjv();
      // Ajv.compile throws on an invalid schema; a successful compile is the proof.
      expect(typeof ajv.compile(sidecar!.inputSchema)).toBe("function");
      expect(typeof ajv.compile(sidecar!.outputSchema)).toBe("function");
    });
  }
});
