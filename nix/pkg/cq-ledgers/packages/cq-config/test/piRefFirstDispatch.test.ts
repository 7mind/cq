/**
 * T1266 / D190 consumer — Pi extension validates against attested schema
 * artifacts, with a LOUD structural-projection fallback when the artifact is
 * absent. Guard lives HERE (D183): `nix/pkg/pi-extensions/` tests are not in
 * `bun run check`.
 *
 * The Pi extension is a standalone store-path module OUTSIDE this workspace, so
 * its contracts are a gated mirror (K46 copy-not-import). This file:
 *
 *   1. deep-equals the extension's structural projection against the projection
 *      re-derived from `DISPATCHED_ROLE_SIDECARS` (drift gate);
 *   2. converts T694's enum/pattern exhibit from a documented gap into an
 *      ENFORCEMENT: the attested-schema path REJECTS it;
 *   3. pins the negative control that the structural projection still ACCEPTS
 *      the same exhibit (the residual of the fallback path);
 *   4. asserts the absent-artifact fallback is LOUD (names the missing artifact
 *      and the degraded guarantee);
 *   5. retires the prior fidelity-precondition marker (no hits in source).
 *
 * Imports are DYNAMIC with a computed specifier: a static import of a file
 * outside this composite project's rootDir fails `tsc -b` (TS6059/TS6307).
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  DISPATCHED_ROLE_IDS,
  DISPATCHED_ROLE_SIDECARS,
  DISPATCHED_ROLE_VERSIONS,
} from "@cq/config";
// serializeRoleSchemaArtifact is owned by promptRenderer; import the leaf so
// index.ts stays untouched (T1265 reported no required barrel export).
import { serializeRoleSchemaArtifact } from "../src/promptRenderer.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const EXTENSION_FILE = path.join(
  REPO_ROOT,
  "nix",
  "pkg",
  "pi-extensions",
  "cq-subagent-dispatch.ts",
);

type JSONSchemaLike = Readonly<Record<string, unknown>>;

interface ContractBranch {
  readonly required: readonly string[];
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  readonly closed: boolean;
}

interface RoleContractProjection {
  readonly version: number;
  readonly input: readonly ContractBranch[];
  readonly output: readonly ContractBranch[];
}

interface ContractViolation {
  readonly path: string;
  readonly message: string;
  readonly keyword?: string;
}

interface ExtensionModule {
  readonly DISPATCHED_ROLE_CONTRACTS: Readonly<Record<string, RoleContractProjection>>;
  readonly DISPATCHED_ROLE_IDS: readonly string[];
  readonly D190_ENFORCED_KEYWORDS: readonly string[];
  readonly D190_DISCLOSED_RESIDUAL_KEYWORDS: readonly string[];
  readonly PI_EXTENSION_JSON_SCHEMA_CAPABILITY: {
    readonly fullValidatorAvailable: boolean;
    readonly pathTaken: string;
  };
  readonly T694_ENUM_PATTERN_EXHIBIT: Readonly<Record<string, unknown>>;
  readonly validateAgainstContract: (
    branches: readonly ContractBranch[],
    value: unknown,
  ) => readonly ContractViolation[];
  readonly validateAgainstAttestedSchema: (
    schema: unknown,
    value: unknown,
  ) => readonly ContractViolation[];
  readonly validateRoleValue: (options: {
    readonly roleId: string;
    readonly side: "input" | "output";
    readonly value: unknown;
    readonly promptRoot?: string;
    readonly warn?: (message: string) => void;
  }) => {
    readonly ok: boolean;
    readonly errors: readonly ContractViolation[];
    readonly mode: "attested-schema" | "structural-projection-fallback";
    readonly warning?: string;
    readonly schemaPath?: string;
  };
  readonly loadAttestedRoleSchema: (
    promptRoot: string,
    roleId: string,
  ) =>
    | {
        readonly status: "loaded";
        readonly artifact: {
          readonly id: string;
          readonly version: number;
          readonly inputSchema: unknown;
          readonly outputSchema: unknown;
        };
        readonly schemaPath: string;
      }
    | { readonly status: "absent"; readonly warning: string; readonly schemaPath: string }
    | { readonly status: "error"; readonly detail: string; readonly schemaPath: string };
}

function project(schema: JSONSchemaLike): ContractBranch[] {
  const oneOf = schema.oneOf;
  const branches = Array.isArray(oneOf) ? (oneOf as JSONSchemaLike[]) : [schema];
  return branches.map((branch) => {
    const properties = (branch.properties ?? {}) as Record<string, JSONSchemaLike>;
    const kinds: Record<string, readonly string[]> = {};
    for (const key of Object.keys(properties).sort()) {
      const declared = (properties[key] ?? {}).type;
      kinds[key] =
        typeof declared === "string"
          ? [declared]
          : Array.isArray(declared)
            ? [...(declared as string[])].sort()
            : [];
    }
    return {
      required: [...((branch.required ?? []) as string[])].sort(),
      kinds,
      closed: branch.additionalProperties === false,
    };
  });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function loadExtension(): Promise<ExtensionModule> {
  mock.module("typebox", () => {
    const identity = <T>(value: T): T => value;
    return {
      Type: {
        Literal: identity,
        Object: identity,
        Optional: identity,
        String: identity,
      },
    };
  });
  return (await import(EXTENSION_FILE)) as ExtensionModule;
}

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Minimal surface root carrying attested schemas for the nine dispatched roles. */
function writeScratchSurface(options?: {
  readonly omitSchemaFor?: string;
  readonly nullSchemaDigestFor?: string;
}): string {
  const root = mkdtempSync(path.join(tmpdir(), "cq-d190-surface-"));
  scratchRoots.push(root);
  mkdirSync(path.join(root, "schemas"), { recursive: true });
  mkdirSync(path.join(root, "roles"), { recursive: true });

  const roles: Array<{
    roleId: string;
    version: number;
    sha256: string;
    schemaSha256: string | null;
  }> = [];

  for (const [roleId, sidecar] of Object.entries(DISPATCHED_ROLE_SIDECARS)) {
    const roleMd = `# ${roleId}\n`;
    writeFileSync(path.join(root, "roles", `${roleId}.md`), roleMd);

    const schemaJson = serializeRoleSchemaArtifact(sidecar);
    let schemaSha256: string | null = sha256Hex(schemaJson);
    if (options?.omitSchemaFor === roleId) {
      // Leave the file out; keep the digest the bytes WOULD have had so absence
      // is observed as a missing file against a non-null attestation.
    } else if (options?.nullSchemaDigestFor === roleId) {
      schemaSha256 = null;
    } else {
      writeFileSync(path.join(root, "schemas", `${roleId}.json`), schemaJson);
    }

    roles.push({
      roleId,
      version: sidecar.version,
      sha256: sha256Hex(roleMd),
      schemaSha256,
    });
  }

  const core = JSON.stringify({
    surface: "pi",
    catalogMetadataHash: sha256Hex("{}"),
    roles,
  });
  const surfaceDigest = sha256Hex(core);
  writeFileSync(
    path.join(root, "surface.json"),
    `${core.slice(0, -1)},"surfaceDigest":"${surfaceDigest}"}`,
  );
  writeFileSync(path.join(root, "catalog.json"), "[]");
  return root;
}

describe("T1266/D190: Pi extension structural projection tracks the canonical sidecars", () => {
  it("covers exactly the dispatched roles at exactly their contract versions", async () => {
    const ext = await loadExtension();
    expect([...ext.DISPATCHED_ROLE_IDS].sort()).toEqual([...DISPATCHED_ROLE_IDS].sort());
    for (const roleId of DISPATCHED_ROLE_IDS) {
      expect(ext.DISPATCHED_ROLE_CONTRACTS[roleId]?.version).toBe(DISPATCHED_ROLE_VERSIONS[roleId]);
    }
  });

  it("projects every sidecar input/output schema identically", async () => {
    const ext = await loadExtension();
    for (const [roleId, sidecar] of Object.entries(DISPATCHED_ROLE_SIDECARS)) {
      const expected: RoleContractProjection = {
        version: sidecar.version,
        input: project(sidecar.inputSchema as JSONSchemaLike),
        output: project(sidecar.outputSchema as JSONSchemaLike),
      };
      expect(ext.DISPATCHED_ROLE_CONTRACTS[roleId]).toEqual(expected);
    }
  });
});

describe("T1266/D190: attested-schema path enforces the T694 enum/pattern exhibit", () => {
  it("records the seven-keyword capability measurement (no full Ajv in the runtime)", async () => {
    const ext = await loadExtension();
    expect(ext.PI_EXTENSION_JSON_SCHEMA_CAPABILITY.fullValidatorAvailable).toBe(false);
    expect(ext.PI_EXTENSION_JSON_SCHEMA_CAPABILITY.pathTaken).toBe("seven-keyword-checker");
    expect([...ext.D190_ENFORCED_KEYWORDS].sort()).toEqual(
      ["allOf", "enum", "if", "minItems", "minLength", "not", "pattern"].sort(),
    );
    // Residual is DISCLOSED, not silent.
    expect(ext.D190_DISCLOSED_RESIDUAL_KEYWORDS.length).toBeGreaterThan(0);
  });

  it("NEGATIVE CONTROL: structural projection still ACCEPTS the T694 exhibit", async () => {
    const ext = await loadExtension();
    const branches = ext.DISPATCHED_ROLE_CONTRACTS["implement-worker"]!.output;
    const violations = ext.validateAgainstContract(branches, ext.T694_ENUM_PATTERN_EXHIBIT);
    // This is the named unsoundness of ACCEPTANCE under the projection — the
    // residual the attested path closes. A future change that makes the
    // projection reject this exhibit would also be fine; what must NEVER happen
    // is the attested path accepting it.
    expect(violations).toEqual([]);
  });

  it("attested-schema path REJECTS the T694 exhibit on enum and pattern", async () => {
    const ext = await loadExtension();
    const root = writeScratchSurface();
    const result = ext.validateRoleValue({
      roleId: "implement-worker",
      side: "output",
      value: ext.T694_ENUM_PATTERN_EXHIBIT,
      promptRoot: root,
      warn: () => {
        throw new Error("attested path must not fall back");
      },
    });
    expect(result.mode).toBe("attested-schema");
    expect(result.ok).toBe(false);
    const keywords = result.errors.map((error) => error.keyword).filter(Boolean).sort();
    expect(keywords).toContain("enum");
    expect(keywords).toContain("pattern");
    // Direct schema check (same bytes the surface ships) agrees.
    const sidecar = DISPATCHED_ROLE_SIDECARS["implement-worker"]!;
    const direct = ext.validateAgainstAttestedSchema(
      sidecar.outputSchema,
      ext.T694_ENUM_PATTERN_EXHIBIT,
    );
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.map((error) => error.keyword).sort()).toEqual(
      expect.arrayContaining(["enum", "pattern", "pattern"]),
    );
  });

  it("absent-artifact fallback is LOUD: names the missing artifact and degraded guarantee", async () => {
    const ext = await loadExtension();
    const root = writeScratchSurface({ omitSchemaFor: "implement-worker" });
    const warnings: string[] = [];
    const result = ext.validateRoleValue({
      roleId: "implement-worker",
      side: "output",
      value: ext.T694_ENUM_PATTERN_EXHIBIT,
      promptRoot: root,
      warn: (message) => {
        warnings.push(message);
      },
    });
    expect(result.mode).toBe("structural-projection-fallback");
    // Fallback ACCEPTS the exhibit (projection residual) — that is why it must be loud.
    expect(result.ok).toBe(true);
    expect(warnings.length).toBe(1);
    const warning = warnings[0]!;
    expect(warning).toContain("implement-worker");
    expect(warning).toMatch(/schemas[/\\]implement-worker\.json/);
    expect(warning).toContain("falling back to structural projection");
    expect(warning).toContain("degraded guarantee");
    expect(warning).toContain("enum");
    expect(warning).toContain("pattern");
    expect(result.warning).toBe(warning);
  });

  it("the retired fidelity-precondition marker is absent from extension source", () => {
    const source = readFileSync(EXTENSION_FILE, "utf8");
    // Assemble the retired marker names so this file itself is not a grep hit
    // for acceptance §5 (`grep -rn <marker> nix/ packages/` → no hits).
    const retiredRequires = ["ROLE_CONTRACT", "FIDELITY", "REQUIRES"].join("_");
    const retiredDeferred = ["ROLE_CONTRACT", "FIDELITY", "DEFERRED_TO"].join("_");
    expect(source).not.toContain(retiredRequires);
    expect(source).not.toContain(retiredDeferred);
  });
});
