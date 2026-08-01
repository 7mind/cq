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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
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

function readGitRef(revision: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--verify", revision], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    throw new Error(`required predecessor ${revision} could not be resolved`, { cause: error });
  }
}

function relevantPathsChanged(): boolean {
  const result = spawnSync("git", ["diff", "--quiet", "HEAD", "--", ...PIN_HISTORY_PATHS], {
    cwd: REPOSITORY_ROOT,
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

function selectHistoricalBaselineRef(
  resolveRef: (revision: string) => string,
  hasRelevantChanges: boolean,
): string {
  const head = resolveRef("HEAD");
  const predecessor = resolveRef("HEAD^");
  return hasRelevantChanges ? head : predecessor;
}

function historicalSchemaPins(): Readonly<Record<string, SchemaPin>> {
  const baselineRef = selectHistoricalBaselineRef(readGitRef, relevantPathsChanged());
  let source: string;
  try {
    source = execFileSync("git", ["show", `${baselineRef}:${PIN_TABLE_PATH}`], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    });
  } catch (error) {
    throw new Error(`schema pin table could not be read from ${baselineRef}`, { cause: error });
  }
  return schemaPinsFromSource(source);
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

interface UnrelatedDirtyFixture {
  readonly relativePath: string;
  readonly cleanup: () => void;
}

function createExclusiveFileAtAbsolutePath(absolutePath: string): () => void {
  if (!isAbsolute(absolutePath)) {
    throw new TypeError("exclusive fixture path must be absolute");
  }
  writeFileSync(absolutePath, "unrelated\n", { flag: "wx" });
  return () => unlinkSync(absolutePath);
}

function createUnrelatedDirtyFixture(
  createFixtureFile: (absolutePath: string) => () => void,
  removeDirectory: (absolutePath: string) => void,
): UnrelatedDirtyFixture {
  const fixtureDirectory = mkdtempSync(join(REPOSITORY_ROOT, ".t1579-unrelated-dirty-"));
  const fixtureFile = join(fixtureDirectory, "fixture");
  const relativePath = relative(REPOSITORY_ROOT, fixtureFile);
  if (relativePath === "" || isAbsolute(relativePath) || relativePath.startsWith("..")) {
    rmdirSync(fixtureDirectory);
    throw new Error("repository fixture allocation escaped the repository");
  }
  let removeFixtureFile: () => void;
  try {
    removeFixtureFile = createFixtureFile(fixtureFile);
  } catch (error) {
    try {
      removeDirectory(fixtureDirectory);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "fixture allocation failed and its directory could not be removed",
      );
    }
    throw error;
  }
  return {
    relativePath,
    cleanup: () => {
      removeFixtureFile();
      rmdirSync(fixtureDirectory);
    },
  };
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
    expect(verifySchemaPins(historicalSchemaPins(), DISPATCHED_ROLE_SIDECARS, SCHEMA_PINS)).toEqual(
      [],
    );
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

  test("uses HEAD^ for an unrelated dirty file, preserving the unchanged-version guard", () => {
    const unrelatedFixture = createUnrelatedDirtyFixture(createExclusiveFileAtAbsolutePath, rmdirSync);
    try {
      expect(unrelatedFixture.relativePath).not.toMatch(/^(?:\/|\.\.(?:\/|$))/);
      expect(resolve(REPOSITORY_ROOT, unrelatedFixture.relativePath)).toStartWith(`${REPOSITORY_ROOT}/`);
      expect(
        execFileSync("git", ["status", "--short", "--", unrelatedFixture.relativePath], {
          cwd: REPOSITORY_ROOT,
          encoding: "utf8",
        }).trim(),
      ).not.toBe("");
      expect(relevantPathsChanged()).toBe(false);
      expect(selectHistoricalBaselineRef(readGitRef, relevantPathsChanged())).toBe(readGitRef("HEAD^"));
    } finally {
      unrelatedFixture.cleanup();
    }

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

  // regression: D246 — an unrelated-dirt fixture must not claim or remove a pre-existing file.
  test("rejects an existing unrelated-dirty fixture without modifying its bytes", () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "t1579-unrelated-dirty-"));
    const fixtureFile = join(fixtureDirectory, "fixture");
    const originalContents = "pre-existing\n";
    writeFileSync(fixtureFile, originalContents);
    try {
      expect(() => createExclusiveFileAtAbsolutePath(fixtureFile)).toThrow(/EEXIST/);
      expect(readFileSync(fixtureFile, "utf8")).toBe(originalContents);
    } finally {
      unlinkSync(fixtureFile);
      rmdirSync(fixtureDirectory);
    }
  });

  test("removes its owned directory and preserves the file-creation error", () => {
    const expectedError = new Error("injected fixture creation failure");
    let fixtureDirectory: string | undefined;

    let caught: unknown;
    try {
      createUnrelatedDirtyFixture(
        (fixtureFile) => {
          fixtureDirectory = dirname(fixtureFile);
          throw expectedError;
        },
        rmdirSync,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(expectedError);
    expect(existsSync(fixtureDirectory!)).toBe(false);
  });

  test("reports fixture creation and rollback failures together", () => {
    const expectedCreationError = new Error("injected fixture creation failure");
    const expectedCleanupError = new Error("injected fixture cleanup failure");
    let fixtureDirectory: string | undefined;
    let caught: unknown;

    try {
      createUnrelatedDirtyFixture(
        (fixtureFile) => {
          fixtureDirectory = dirname(fixtureFile);
          throw expectedCreationError;
        },
        () => {
          throw expectedCleanupError;
        },
      );
    } catch (error) {
      caught = error;
    }

    try {
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual([
        expectedCreationError,
        expectedCleanupError,
      ]);
      expect(existsSync(fixtureDirectory!)).toBe(true);
    } finally {
      rmdirSync(fixtureDirectory!);
    }
  });

  test("uses HEAD when the pin table or a sidecar schema has uncommitted changes", () => {
    expect(
      selectHistoricalBaselineRef(
        (revision) => (revision === "HEAD" ? "current" : "predecessor"),
        true,
      ),
    ).toBe("current");
  });

  test("fails closed when a historical pin table cannot be parsed", () => {
    expect(() => schemaPinsFromSource("const SCHEMA_PINS_JSON = String.raw`not json`;\n")).toThrow(
      "schema pin table could not be parsed",
    );
  });
});
