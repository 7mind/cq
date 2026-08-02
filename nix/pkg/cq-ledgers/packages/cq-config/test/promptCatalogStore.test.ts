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
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
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

const PIN_TABLE_PATH = "nix/pkg/cq-ledgers/packages/cq-config/test/promptCatalogStore.test.ts";
const SIDECAR_SCHEMA_PATHS = [
  "nix/pkg/cq-ledgers/packages/cq-config/src/schemas/plan-advance.ts",
  "nix/pkg/cq-ledgers/packages/cq-config/src/schemas/plan-reviewer.ts",
  "nix/pkg/cq-ledgers/packages/cq-config/src/schemas/implement-worker.ts",
  "nix/pkg/cq-ledgers/packages/cq-config/src/schemas/implement-reviewer.ts",
  "nix/pkg/cq-ledgers/packages/cq-config/src/schemas/implement-conflict-resolver.ts",
  "nix/pkg/cq-ledgers/packages/cq-config/src/schemas/investigate-explorer.ts",
  "nix/pkg/cq-ledgers/packages/cq-config/src/schemas/investigate-prober.ts",
  "nix/pkg/cq-ledgers/packages/cq-config/src/schemas/research-explorer.ts",
  "nix/pkg/cq-ledgers/packages/cq-config/src/schemas/research-experimenter.ts",
] as const;
const PIN_HISTORY_PATHS = [PIN_TABLE_PATH, ...SIDECAR_SCHEMA_PATHS] as const;
const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../../../..");

const SCHEMA_PINS_JSON = String.raw`{
  "plan-advance": {
    "version": 1,
    "digest": "298ce36978c831266000028da6f5ed6fc4df033a6a08716a329905b27bc43aa8"
  },
  "plan-reviewer": {
    "version": 1,
    "digest": "99be6cac6e847fbe1e66dd62ded37beab7890f5963930fa4053da3efb7325b22"
  },
  "implement-worker": {
    "version": 2,
    "digest": "9617b5c67529a7b4e167ff5406c3c00a7e73cbbab1fc9c5e5257cd8f17b0531f"
  },
  "implement-reviewer": {
    "version": 2,
    "digest": "c6119d67521d1b2da62bc0325d1b418723f274f8ee6cf0c32254029d61d77876"
  },
  "implement-conflict-resolver": {
    "version": 1,
    "digest": "3e77b5352e4d7e525ad31ec7eefef28dcd2f3e2f08aeee90efd9d812507c966e"
  },
  "investigate-explorer": {
    "version": 1,
    "digest": "f2ac0996a0ab6fda0f83879a41100a6e19a66c96b598c49aa2378905d18bd2c5"
  },
  "investigate-prober": {
    "version": 1,
    "digest": "000cef13be932fa861d9f5a81cb4ea8889534a94f3f4abdf1e4f2b6297eaae90"
  },
  "research-explorer": {
    "version": 1,
    "digest": "f42f986bd9b0e890c9b46d56b162f595192a4c028dc21f4b42dbe69eb956ea35"
  },
  "research-experimenter": {
    "version": 1,
    "digest": "08daa39c4ad2941d1fbc411bdafcb86c1a6f0b967b13ef7b9720ddf385154224"
  }
}`;

const SCHEMA_PINS: Readonly<Record<string, SchemaPin>> = parseSchemaPins(SCHEMA_PINS_JSON);

function parseSchemaPins(serialized: string): Readonly<Record<string, SchemaPin>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("schema pin table could not be parsed", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("schema pin table must be a JSON object");
  }

  const pins: Record<string, SchemaPin> = {};
  for (const [roleId, value] of Object.entries(parsed)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`schema pin for ${roleId} must be an object`);
    }
    const pin = value as Record<string, unknown>;
    const version = pin.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      throw new TypeError(`schema pin for ${roleId} must have a positive integer version`);
    }
    const digest = pin.digest;
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new TypeError(`schema pin for ${roleId} must have a SHA-256 digest`);
    }
    pins[roleId] = { version, digest };
  }
  return pins;
}

function schemaPinsFromSource(source: string): Readonly<Record<string, SchemaPin>> {
  const jsonMatch = source.match(/const SCHEMA_PINS_JSON = String\.raw`([\s\S]*?)`;/);
  if (jsonMatch !== null) {
    return parseSchemaPins(jsonMatch[1]!);
  }

  const legacyMatch = source.match(
    /const SCHEMA_PINS: Readonly<Record<string, SchemaPin>> = \{([\s\S]*?)\n\};/,
  );
  if (legacyMatch === null) {
    throw new Error("schema pin table declaration could not be located");
  }
  const legacyBody = legacyMatch[1]!;
  const entryPattern = /\s*"([^"]+)": \{\s*version: (\d+),\s*digest: "([a-f0-9]{64})",?\s*\},?/g;
  const pins: Record<string, SchemaPin> = {};
  for (const entry of legacyBody.matchAll(entryPattern)) {
    pins[entry[1]!] = { version: Number(entry[2]), digest: entry[3]! };
  }
  if (
    Object.keys(pins).length === 0 ||
    legacyBody.replace(entryPattern, "").replace(/[\s,]/g, "") !== ""
  ) {
    throw new Error("schema pin table could not be parsed");
  }
  return pins;
}

function readGitRefs(
  args: readonly string[],
  description: string,
  repositoryRoot: string,
): readonly string[] {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((revision) => revision !== "");
  } catch (error) {
    throw new Error(`${description} could not be inspected`, { cause: error });
  }
}

function relevantPathsChanged(repositoryRoot: string): boolean {
  const result = spawnSync("git", ["diff", "--quiet", "HEAD", "--", ...PIN_HISTORY_PATHS], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status === null) {
    throw new Error("relevant sidecar history could not be inspected", { cause: result.error });
  }
  if (result.status === 0) {
    return false;
  }
  if (result.status === 1) {
    return true;
  }
  throw new Error(`relevant sidecar history inspection failed with exit ${result.status}`);
}

function schemaPinsFromHistorySources(
  sources: readonly (string | undefined)[],
): readonly Readonly<Record<string, SchemaPin>>[] {
  const history: Readonly<Record<string, SchemaPin>>[] = [];
  let pinTableIntroduced = false;

  for (const source of sources) {
    if (source === undefined) {
      if (!pinTableIntroduced) {
        continue;
      }
      throw new Error("schema pin table could not be read after its introduction");
    }
    const hasPinDeclaration = /const SCHEMA_PINS(?:_JSON)?\s*(?::|=)/.test(source);
    if (!pinTableIntroduced && !hasPinDeclaration) {
      continue;
    }
    pinTableIntroduced = true;
    history.push(schemaPinsFromSource(source));
  }

  if (!pinTableIntroduced) {
    throw new Error("schema pin table introduction could not be located");
  }
  return history;
}

function pinTableHistoryArgs(introduction: string): readonly string[] {
  return ["rev-list", "--first-parent", "--reverse", `${introduction}..HEAD`, "--", PIN_TABLE_PATH];
}

function requireCompleteGitHistory(repositoryRoot: string): void {
  const shallowState = readGitRefs(
    ["rev-parse", "--is-shallow-repository"],
    "repository history completeness",
    repositoryRoot,
  );
  if (shallowState.length !== 1 || shallowState[0] !== "false") {
    throw new Error("schema pin history requires a non-shallow repository");
  }
}

function historicalSchemaPinHistory(
  repositoryRoot: string,
): readonly Readonly<Record<string, SchemaPin>>[] {
  requireCompleteGitHistory(repositoryRoot);
  const introduction = readGitRefs(
    [
      "log",
      "--first-parent",
      "--reverse",
      "--format=%H",
      "-G",
      "const SCHEMA_PINS",
      "--",
      PIN_TABLE_PATH,
    ],
    "schema pin table introduction",
    repositoryRoot,
  )[0];
  if (introduction === undefined) {
    throw new Error("schema pin table introduction could not be located");
  }
  const historyRefs = [
    introduction,
    ...readGitRefs(
      pinTableHistoryArgs(introduction),
      "schema pin first-parent history",
      repositoryRoot,
    ),
  ];

  const sources = historyRefs.map((revision) => {
    try {
      return execFileSync("git", ["show", `${revision}:${PIN_TABLE_PATH}`], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });
    } catch (error) {
      throw new Error(`schema pin table could not be read from ${revision}`, { cause: error });
    }
  });
  return schemaPinsFromHistorySources(sources);
}

function schemaPinTransitionErrors(
  previousPins: Readonly<Record<string, SchemaPin>>,
  nextPins: Readonly<Record<string, SchemaPin>>,
  lastObservedPins: Readonly<Record<string, SchemaPin>>,
): readonly string[] {
  const errors: string[] = [];
  for (const roleId of Object.keys(previousPins)) {
    const previousPin = previousPins[roleId]!;
    const nextPin = nextPins[roleId];
    if (nextPin === undefined) {
      continue;
    }
    if (nextPin.version < previousPin.version) {
      errors.push(`schema pin version regressed for ${roleId}`);
    }
    if (nextPin.version === previousPin.version && nextPin.digest !== previousPin.digest) {
      errors.push(`schema pin digest changed without version advance for ${roleId}`);
    }
  }
  for (const roleId of Object.keys(nextPins)) {
    if (previousPins[roleId] !== undefined) {
      continue;
    }
    const nextPin = nextPins[roleId]!;
    const lastObservedPin = lastObservedPins[roleId];
    if (lastObservedPin === undefined && nextPin.version !== 1) {
      errors.push(`new schema pin must start at version 1 for ${roleId}`);
    }
    if (lastObservedPin !== undefined && nextPin.version <= lastObservedPin.version) {
      errors.push(
        `reintroduced schema pin must advance beyond version ${lastObservedPin.version} for ${roleId}`,
      );
    }
  }
  return errors;
}

function schemaPinHistoryErrors(
  history: readonly Readonly<Record<string, SchemaPin>>[],
): readonly string[] {
  if (history.length === 0) {
    throw new Error("schema pin history cannot be empty");
  }
  const errors: string[] = [];
  const lastObservedPins: Record<string, SchemaPin> = { ...history[0]! };
  for (let index = 1; index < history.length; index += 1) {
    const nextPins = history[index]!;
    errors.push(
      ...schemaPinTransitionErrors(history[index - 1]!, nextPins, lastObservedPins),
    );
    Object.assign(lastObservedPins, nextPins);
  }
  return errors;
}

function currentSchemaPinHistoryErrors(
  repositoryRoot: string,
  currentPins: Readonly<Record<string, SchemaPin>>,
): readonly string[] {
  const history = historicalSchemaPinHistory(repositoryRoot);
  if (relevantPathsChanged(repositoryRoot)) {
    return schemaPinHistoryErrors([...history, currentPins]);
  }
  return schemaPinHistoryErrors(history);
}

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
  baselinePins: Readonly<Record<string, SchemaPin>>,
  sidecars: Readonly<Record<string, SidecarContract>>,
  pins: Readonly<Record<string, SchemaPin>>,
): readonly string[] {
  const sidecarIds = Object.keys(sidecars).sort();
  const baselinePinIds = Object.keys(baselinePins).sort();
  const pinIds = Object.keys(pins).sort();
  const errors: string[] = [];

  if (canonicalJson(sidecarIds) !== canonicalJson(baselinePinIds)) {
    errors.push("baseline pin table keys do not match sidecar keys");
  }

  if (canonicalJson(sidecarIds) !== canonicalJson(pinIds)) {
    errors.push("pin table keys do not match sidecar keys");
  }

  for (const roleId of sidecarIds) {
    const sidecar = sidecars[roleId]!;
    const baselinePin = baselinePins[roleId];
    const pin = pins[roleId];
    if (baselinePin === undefined) {
      errors.push(`missing baseline pin for ${roleId}`);
      continue;
    }
    if (pin === undefined) {
      errors.push(`missing pin for ${roleId}`);
      continue;
    }
    if (pin.version !== sidecar.version || pin.digest !== schemaDigest(sidecar)) {
      errors.push(`schema pin mismatch for ${roleId}`);
    }
    if (pin.version < baselinePin.version) {
      errors.push(`schema pin version regressed for ${roleId}`);
    }
    if (pin.version === baselinePin.version && pin.digest !== baselinePin.digest) {
      errors.push(`schema pin digest changed without version advance for ${roleId}`);
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
const ROSTER_COMMAND_IDS = AGENT_ROLE_TIERS.filter((r) => r.agentTierKey === null).map((r) => r.id);

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
    expect([
      ...currentSchemaPinHistoryErrors(REPOSITORY_ROOT, SCHEMA_PINS),
      ...verifySchemaPins(SCHEMA_PINS, DISPATCHED_ROLE_SIDECARS, SCHEMA_PINS),
    ]).toEqual([]);
  });

  // regression: T1579 — a schema mutation without a sidecar version bump escaped the catalog checks.
  test("rejects an implement-worker input-schema mutation with a refreshed pin at the existing version", () => {
    const sidecars = cloneSidecars();
    const implementWorker = sidecars["implement-worker"]!;
    const changedImplementWorker = {
      ...implementWorker,
      inputSchema: { ...implementWorker.inputSchema, minProperties: 1 },
    };
    sidecars["implement-worker"] = changedImplementWorker;
    const pins = {
      ...SCHEMA_PINS,
      "implement-worker": {
        version: changedImplementWorker.version,
        digest: schemaDigest(changedImplementWorker),
      },
    };

    expect(verifySchemaPins(SCHEMA_PINS, sidecars, pins)).toEqual([
      "schema pin digest changed without version advance for implement-worker",
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

    expect(verifySchemaPins(SCHEMA_PINS, sidecars, pins)).toEqual([]);
  });

  // regression: D242 — a bad refresh followed by a preserving commit must remain observable.
  test("rejects a two-commit same-version refresh that its successor preserves", () => {
    const sidecars = cloneSidecars();
    const implementWorker = sidecars["implement-worker"]!;
    const changedImplementWorker = {
      ...implementWorker,
      inputSchema: { ...implementWorker.inputSchema, minProperties: 1 },
    };
    sidecars["implement-worker"] = changedImplementWorker;
    const refreshedPins = {
      ...SCHEMA_PINS,
      "implement-worker": {
        version: changedImplementWorker.version,
        digest: schemaDigest(changedImplementWorker),
      },
    };

    expect(schemaPinHistoryErrors([SCHEMA_PINS, refreshedPins, refreshedPins])).toEqual([
      "schema pin digest changed without version advance for implement-worker",
    ]);
  });

  test("accepts a multi-commit schema history with a real version advance", () => {
    const sidecars = cloneSidecars();
    const implementWorker = sidecars["implement-worker"]!;
    const advancedImplementWorker = {
      ...implementWorker,
      version: implementWorker.version + 1,
      inputSchema: { ...implementWorker.inputSchema, minProperties: 1 },
    };
    sidecars["implement-worker"] = advancedImplementWorker;
    const advancedPins = {
      ...SCHEMA_PINS,
      "implement-worker": {
        version: advancedImplementWorker.version,
        digest: schemaDigest(advancedImplementWorker),
      },
    };

    expect(schemaPinHistoryErrors([SCHEMA_PINS, advancedPins, advancedPins])).toEqual([]);
  });

  // regression: D245 — a new dispatched role may join the catalog at version 1.
  test("accepts a new role whose initial schema pin starts at version 1", () => {
    const extendedPins = {
      ...SCHEMA_PINS,
      "new-dispatched-role": {
        version: 1,
        digest: "0".repeat(64),
      },
    };

    expect(schemaPinHistoryErrors([SCHEMA_PINS, extendedPins])).toEqual([]);
  });

  test("rejects a new role whose initial schema pin starts above version 1", () => {
    const extendedPins = {
      ...SCHEMA_PINS,
      "new-dispatched-role": {
        version: 2,
        digest: "0".repeat(64),
      },
    };

    expect(schemaPinHistoryErrors([SCHEMA_PINS, extendedPins])).toEqual([
      "new schema pin must start at version 1 for new-dispatched-role",
    ]);
  });

  test("accepts removal of an established role", () => {
    const deletedPins = { ...SCHEMA_PINS };
    delete deletedPins["implement-worker"];

    expect(schemaPinHistoryErrors([SCHEMA_PINS, deletedPins])).toEqual([]);
  });

  test.each([1, 2])(
    "rejects reintroduction at version %i when the last historical version is 2",
    (version) => {
      const implementWorkerPin = SCHEMA_PINS["implement-worker"]!;
      const deletedPins = { ...SCHEMA_PINS };
      delete deletedPins["implement-worker"];
      const reintroducedPins = {
        ...deletedPins,
        "implement-worker": {
          ...implementWorkerPin,
          version,
        },
      };

      expect(schemaPinHistoryErrors([SCHEMA_PINS, deletedPins, reintroducedPins])).toEqual([
        "reintroduced schema pin must advance beyond version 2 for implement-worker",
      ]);
    },
  );

  test("accepts reintroduction above the last historical version", () => {
    const implementWorkerPin = SCHEMA_PINS["implement-worker"]!;
    const deletedPins = { ...SCHEMA_PINS };
    delete deletedPins["implement-worker"];
    const reintroducedPins = {
      ...deletedPins,
      "implement-worker": {
        ...implementWorkerPin,
        version: implementWorkerPin.version + 1,
      },
    };

    expect(schemaPinHistoryErrors([SCHEMA_PINS, deletedPins, reintroducedPins])).toEqual([]);
  });

  test("scopes first-parent pin history to the pin table path", () => {
    expect(pinTableHistoryArgs("0123456789abcdef")).toEqual([
      "rev-list",
      "--first-parent",
      "--reverse",
      "0123456789abcdef..HEAD",
      "--",
      PIN_TABLE_PATH,
    ]);
  });

  // regression: D251 — partial Git history can make a later table rewrite look like its origin.
  test("rejects a real shallow clone before inferring schema pin history", () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "t1579-shallow-clone-"));
    const shallowRepository = join(fixtureDirectory, "repository");
    try {
      execFileSync(
        "git",
        [
          "clone",
          "--quiet",
          "--depth",
          "6",
          "--no-tags",
          pathToFileURL(REPOSITORY_ROOT).href,
          shallowRepository,
        ],
        { encoding: "utf8" },
      );
      expect(
        execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
          cwd: shallowRepository,
          encoding: "utf8",
        }).trim(),
      ).toBe("true");
      expect(() => historicalSchemaPinHistory(shallowRepository)).toThrow(
        "schema pin history requires a non-shallow repository",
      );
    } finally {
      rmSync(fixtureDirectory, { recursive: true });
    }
  });

  // regression: D246 — unrelated working-tree dirt must not select a pin transition edge.
  test("ignores unrelated working-tree dirt in the real history verifier", () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "t1579-unrelated-dirt-"));
    const repository = join(fixtureDirectory, "repository");
    try {
      execFileSync(
        "git",
        ["clone", "--quiet", "--no-tags", pathToFileURL(REPOSITORY_ROOT).href, repository],
        { encoding: "utf8" },
      );
      writeFileSync(join(repository, "unrelated-dirt"), "unrelated\n", { flag: "wx" });
      expect(
        execFileSync("git", ["status", "--short", "--", "unrelated-dirt"], {
          cwd: repository,
          encoding: "utf8",
        }).trim(),
      ).toBe("?? unrelated-dirt");

      const invalidWorkingPins = {
        ...SCHEMA_PINS,
        "implement-worker": {
          ...SCHEMA_PINS["implement-worker"]!,
          digest: "0".repeat(64),
        },
      };
      expect(currentSchemaPinHistoryErrors(repository, invalidWorkingPins)).toEqual([]);
    } finally {
      rmSync(fixtureDirectory, { recursive: true });
    }
  });

  test("treats sources before the pin declaration as the history boundary", () => {
    const pinTableSource = `const SCHEMA_PINS_JSON = String.raw\`${SCHEMA_PINS_JSON}\`;`;
    expect(schemaPinsFromHistorySources(["export {};\n", pinTableSource])).toEqual([SCHEMA_PINS]);
  });

  test("fails closed when a source becomes unreadable after pin-table introduction", () => {
    const pinTableSource = `const SCHEMA_PINS_JSON = String.raw\`${SCHEMA_PINS_JSON}\`;`;
    expect(() => schemaPinsFromHistorySources([pinTableSource, undefined])).toThrow(
      "schema pin table could not be read after its introduction",
    );
  });

  test("fails closed when a historical pin table cannot be parsed", () => {
    expect(() => schemaPinsFromSource("const SCHEMA_PINS_JSON = String.raw`not json`;\n")).toThrow(
      "schema pin table could not be parsed",
    );
  });
});
