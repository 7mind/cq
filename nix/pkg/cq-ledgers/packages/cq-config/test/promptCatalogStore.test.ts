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
import { createHash } from "node:crypto";
// The 2020-12 dialect entrypoint: the catalog schemas declare
// `$schema: …/draft/2020-12/schema`, so they must compile under Ajv's 2020 build.
import Ajv2020 from "ajv/dist/2020";
import {
  AGENT_ROLE_TIERS,
  DISPATCHED_ROLE_SIDECARS,
  DISPATCHED_ROLE_IDS,
  getRoleSidecar,
} from "@cq/config";

interface SidecarContract {
  readonly version: number;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

interface SchemaPin {
  readonly version: number;
  readonly digest: string;
}

const SCHEMA_PINS: Readonly<Record<string, SchemaPin>> = {
  "plan-advance": {
    version: 1,
    digest: "298ce36978c831266000028da6f5ed6fc4df033a6a08716a329905b27bc43aa8",
  },
  "plan-reviewer": {
    version: 1,
    digest: "99be6cac6e847fbe1e66dd62ded37beab7890f5963930fa4053da3efb7325b22",
  },
  "implement-worker": {
    version: 2,
    digest: "9617b5c67529a7b4e167ff5406c3c00a7e73cbbab1fc9c5e5257cd8f17b0531f",
  },
  "implement-reviewer": {
    version: 2,
    digest: "c6119d67521d1b2da62bc0325d1b418723f274f8ee6cf0c32254029d61d77876",
  },
  "implement-conflict-resolver": {
    version: 1,
    digest: "3e77b5352e4d7e525ad31ec7eefef28dcd2f3e2f08aeee90efd9d812507c966e",
  },
  "investigate-explorer": {
    version: 1,
    digest: "f2ac0996a0ab6fda0f83879a41100a6e19a66c96b598c49aa2378905d18bd2c5",
  },
  "investigate-prober": {
    version: 1,
    digest: "000cef13be932fa861d9f5a81cb4ea8889534a94f3f4abdf1e4f2b6297eaae90",
  },
  "research-explorer": {
    version: 1,
    digest: "f42f986bd9b0e890c9b46d56b162f595192a4c028dc21f4b42dbe69eb956ea35",
  },
  "research-experimenter": {
    version: 1,
    digest: "08daa39c4ad2941d1fbc411bdafcb86c1a6f0b967b13ef7b9720ddf385154224",
  },
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("schema pin values must be JSON-serializable");
  }
  return serialized;
}

function schemaDigest(sidecar: SidecarContract): string {
  return createHash("sha256")
    .update(canonicalJson({ inputSchema: sidecar.inputSchema, outputSchema: sidecar.outputSchema }))
    .digest("hex");
}

function verifySchemaPins(
  sidecars: Readonly<Record<string, SidecarContract>>,
  pins: Readonly<Record<string, SchemaPin>>,
): readonly string[] {
  const sidecarIds = Object.keys(sidecars).sort();
  const pinIds = Object.keys(pins).sort();
  const errors: string[] = [];

  if (canonicalJson(sidecarIds) !== canonicalJson(pinIds)) {
    errors.push("pin table keys do not match sidecar keys");
  }

  for (const roleId of sidecarIds) {
    const sidecar = sidecars[roleId]!;
    const pin = pins[roleId];
    if (pin === undefined) {
      errors.push(`missing pin for ${roleId}`);
      continue;
    }
    if (pin.version !== sidecar.version || pin.digest !== schemaDigest(sidecar)) {
      errors.push(`schema pin mismatch for ${roleId}`);
    }
  }

  return errors;
}

function cloneSidecars(): Record<string, SidecarContract> {
  return structuredClone(DISPATCHED_ROLE_SIDECARS);
}

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
  test("the exported role entries reject reassignment at compile time", () => {
    const compileOnly = (): void => {
      const original = DISPATCHED_ROLE_SIDECARS["plan-advance"];
      // @ts-expect-error DISPATCHED_ROLE_SIDECARS is an immutable catalog.
      DISPATCHED_ROLE_SIDECARS["plan-advance"] = original;
    };
    expect(typeof compileOnly).toBe("function");
  });

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

describe("typed prompt-catalog store — sidecar schema pins (T1579)", () => {
  test("the committed pins cover every sidecar and match its versioned schema contract", () => {
    expect(verifySchemaPins(DISPATCHED_ROLE_SIDECARS, SCHEMA_PINS)).toEqual([]);
  });

  // regression: T1579 — a schema mutation without a sidecar version bump escaped the catalog checks.
  test("rejects an implement-worker input-schema mutation at the existing version", () => {
    const sidecars = cloneSidecars();
    const implementWorker = sidecars["implement-worker"]!;
    sidecars["implement-worker"] = {
      ...implementWorker,
      inputSchema: { ...implementWorker.inputSchema, minProperties: 1 },
    };

    expect(verifySchemaPins(sidecars, SCHEMA_PINS)).toEqual([
      "schema pin mismatch for implement-worker",
    ]);
  });

  test("accepts the schema mutation after its version and pin advance together", () => {
    const sidecars = cloneSidecars();
    const implementWorker = sidecars["implement-worker"]!;
    const advancedImplementWorker = {
      ...implementWorker,
      version: implementWorker.version + 1,
      inputSchema: { ...implementWorker.inputSchema, minProperties: 1 },
    };
    sidecars["implement-worker"] = advancedImplementWorker;
    const pins = {
      ...SCHEMA_PINS,
      "implement-worker": {
        version: advancedImplementWorker.version,
        digest: schemaDigest(advancedImplementWorker),
      },
    };

    expect(verifySchemaPins(sidecars, pins)).toEqual([]);
  });
});
