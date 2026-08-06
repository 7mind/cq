import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  PackagedPromptSurfaceError,
  validatePackagedPromptSurface,
  validatePackagedPromptSurfaceRoot,
  type PackagedPromptSurfaceInput,
  type PackagedPromptSurfaceRoleArtifact,
} from "../src/packagedPromptSurface.js";
import {
  PROMPT_SURFACE_MANIFEST_FIELDS,
  PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS,
  serializePromptSurfaceManifest,
  type PromptSurfaceRoleAttestation,
} from "../src/promptRenderer.js";

const roots: string[] = [];
const VALIDATE_SCRIPT = path.resolve(
  import.meta.dir,
  "..",
  "scripts",
  "validate-prompt-surface-attestation.ts",
);

interface Fixture {
  readonly expectedSurface: "codex";
  catalogJson: string;
  surfaceJson: string;
  roleArtifacts: PackagedPromptSurfaceRoleArtifact[];
  schemaArtifacts: PackagedPromptSurfaceRoleArtifact[];
}

interface ValidatorAdapter {
  readonly name: string;
  readonly validate: (fixture: Fixture) => void;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeFixture(): Fixture {
  const catalogJson = JSON.stringify([
    { roleId: "implement-worker", sidecar: { schemaRoleId: "implement-worker" } },
    { roleId: "plan/advance", sidecar: null },
  ]);
  const roleArtifacts = [
    { path: "implement-worker.md", content: "worker prompt\n" },
    { path: "plan/advance.md", content: "advance prompt\n" },
  ];
  const schemaJson = JSON.stringify({
    id: "implement-worker",
    version: 3,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  });
  const schemaArtifacts = [{ path: "implement-worker.json", content: schemaJson }];
  const roles: readonly PromptSurfaceRoleAttestation[] = [
    {
      roleId: "implement-worker",
      version: 3,
      sha256: sha256(roleArtifacts[0]!.content),
      schemaSha256: sha256(schemaJson),
    },
    {
      roleId: "plan/advance",
      version: null,
      sha256: sha256(roleArtifacts[1]!.content),
      schemaSha256: null,
    },
  ];
  return {
    expectedSurface: "codex",
    catalogJson,
    surfaceJson: serializePromptSurfaceManifest("codex", sha256(catalogJson), roles),
    roleArtifacts,
    schemaArtifacts,
  };
}

function materialize(fixture: Fixture): string {
  const root = mkdtempSync(path.join(tmpdir(), "cq-packaged-prompt-surface-"));
  roots.push(root);
  writeFileSync(path.join(root, "catalog.json"), fixture.catalogJson);
  writeFileSync(path.join(root, "surface.json"), fixture.surfaceJson);
  for (const artifact of fixture.roleArtifacts) {
    const destination = path.join(root, "roles", artifact.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, artifact.content);
  }
  for (const artifact of fixture.schemaArtifacts) {
    const destination = path.join(root, "schemas", artifact.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, artifact.content);
  }
  return root;
}

function asInput(fixture: Fixture): PackagedPromptSurfaceInput {
  return {
    expectedSurface: fixture.expectedSurface,
    catalogJson: fixture.catalogJson,
    surfaceJson: fixture.surfaceJson,
    roleArtifacts: fixture.roleArtifacts,
    schemaArtifacts: fixture.schemaArtifacts,
  };
}

function mutateTupleField(
  tuple: Record<string, unknown>,
  field: string,
  mutation: "missing" | "renamed",
): void {
  const value = tuple[field];
  delete tuple[field];
  if (mutation === "renamed") {
    tuple[`renamed-${field}`] = value;
  }
}

const validators: readonly ValidatorAdapter[] = [
  {
    name: "pure input",
    validate: (fixture) => validatePackagedPromptSurface(asInput(fixture)),
  },
  {
    name: "real filesystem root",
    validate: (fixture) =>
      validatePackagedPromptSurfaceRoot(fixture.expectedSurface, materialize(fixture)),
  },
];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const validator of validators) {
  describe(`packaged prompt surface contract: ${validator.name}`, () => {
    test("accepts a canonical manifest and exact catalog-derived role closure", () => {
      const fixture = makeFixture();
      const manifest = JSON.parse(fixture.surfaceJson) as {
        roles: Array<Record<string, unknown>>;
      };
      expect(Object.keys(manifest)).toEqual([...PROMPT_SURFACE_MANIFEST_FIELDS]);
      expect(Object.keys(manifest.roles[0]!)).toEqual([
        ...PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS,
      ]);
      expect(() => validator.validate(fixture)).not.toThrow();
    });

    test("rejects an unexpected surface", () => {
      const fixture = makeFixture();
      fixture.surfaceJson = fixture.surfaceJson.replace('"surface":"codex"', '"surface":"pi"');
      expect(() => validator.validate(fixture)).toThrow(
        new PackagedPromptSurfaceError("surface.json.surface", 'expected "codex"'),
      );
    });

    test("rejects catalog byte drift", () => {
      const fixture = makeFixture();
      fixture.catalogJson += "\n";
      expect(() => validator.validate(fixture)).toThrow(
        new PackagedPromptSurfaceError(
          "surface.json.catalogMetadataHash",
          "does not match the installed catalog.json bytes",
        ),
      );
    });

    test("rejects non-canonical catalog sidecar shape", () => {
      const fixture = makeFixture();
      const catalog = JSON.parse(fixture.catalogJson) as Array<{
        sidecar: Record<string, unknown> | null;
      }>;
      catalog[0]!.sidecar!.unexpected = true;
      fixture.catalogJson = JSON.stringify(catalog);
      expect(() => validator.validate(fixture)).toThrow(
        new PackagedPromptSurfaceError(
          "catalog.json[0].sidecar",
          'expected exactly schemaRoleId "implement-worker"',
        ),
      );
    });

    test("rejects extended manifest and role-attestation tuple fields", () => {
      const extendedManifest = makeFixture();
      const manifest = JSON.parse(extendedManifest.surfaceJson) as Record<string, unknown>;
      manifest.unexpected = true;
      extendedManifest.surfaceJson = JSON.stringify(manifest);
      expect(() => validator.validate(extendedManifest)).toThrow(
        new PackagedPromptSurfaceError(
          "surface.json",
          "expected exactly surface, catalogMetadataHash, roles, and surfaceDigest",
        ),
      );

      const extendedRole = makeFixture();
      const roleManifest = JSON.parse(extendedRole.surfaceJson) as {
        roles: Array<Record<string, unknown>>;
      };
      roleManifest.roles[0]!.unexpected = true;
      extendedRole.surfaceJson = JSON.stringify(roleManifest);
      expect(() => validator.validate(extendedRole)).toThrow(
        new PackagedPromptSurfaceError(
          "surface.json.roles[0]",
          "expected exactly roleId, version, sha256, and schemaSha256",
        ),
      );
    });

    test("rejects every missing and renamed surface-manifest tuple field", () => {
      for (const field of PROMPT_SURFACE_MANIFEST_FIELDS) {
        for (const mutation of ["missing", "renamed"] as const) {
          const fixture = makeFixture();
          const manifest = JSON.parse(fixture.surfaceJson) as Record<string, unknown>;
          mutateTupleField(manifest, field, mutation);
          fixture.surfaceJson = JSON.stringify(manifest);
          expect(() => validator.validate(fixture)).toThrow(
            new PackagedPromptSurfaceError(
              "surface.json",
              "expected exactly surface, catalogMetadataHash, roles, and surfaceDigest",
            ),
          );
        }
      }
    });

    test("rejects every missing and renamed role-attestation tuple field", () => {
      for (const field of PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS) {
        for (const mutation of ["missing", "renamed"] as const) {
          const fixture = makeFixture();
          const manifest = JSON.parse(fixture.surfaceJson) as {
            roles: Array<Record<string, unknown>>;
          };
          mutateTupleField(manifest.roles[0]!, field, mutation);
          fixture.surfaceJson = JSON.stringify(manifest);
          expect(() => validator.validate(fixture)).toThrow(
            new PackagedPromptSurfaceError(
              "surface.json.roles[0]",
              "expected exactly roleId, version, sha256, and schemaSha256",
            ),
          );
        }
      }
    });

    test("rejects non-canonical manifest byte serialization", () => {
      const fixture = makeFixture();
      fixture.surfaceJson = JSON.stringify(JSON.parse(fixture.surfaceJson), null, 2);
      expect(() => validator.validate(fixture)).toThrow(
        new PackagedPromptSurfaceError(
          "surface.json",
          "does not use the canonical prompt-surface serialization",
        ),
      );
    });

    test("rejects dispatched and orchestrator version-pairing drift", () => {
      const fixture = makeFixture();
      const manifest = JSON.parse(fixture.surfaceJson) as {
        roles: Array<{ version: number | null }>;
      };
      manifest.roles[0]!.version = null;
      fixture.surfaceJson = JSON.stringify(manifest);
      expect(() => validator.validate(fixture)).toThrow(
        new PackagedPromptSurfaceError(
          "surface.json.roles[0].version",
          "expected a positive integer schema-sidecar version",
        ),
      );

      const second = makeFixture();
      const secondManifest = JSON.parse(second.surfaceJson) as {
        roles: Array<{ version: number | null }>;
      };
      secondManifest.roles[1]!.version = 1;
      second.surfaceJson = JSON.stringify(secondManifest);
      expect(() => validator.validate(second)).toThrow(
        new PackagedPromptSurfaceError(
          "surface.json.roles[1].version",
          "roles without schema sidecars must carry null",
        ),
      );
    });

    test("rejects missing, renamed, and extra role artifacts", () => {
      const missing = makeFixture();
      missing.roleArtifacts.pop();
      expect(() => validator.validate(missing)).toThrow(
        new PackagedPromptSurfaceError(
          "roles",
          'missing role artifact "plan/advance.md"',
        ),
      );

      const renamed = makeFixture();
      renamed.roleArtifacts[1] = {
        ...renamed.roleArtifacts[1]!,
        path: "plan/renamed.md",
      };
      expect(() => validator.validate(renamed)).toThrow(
        new PackagedPromptSurfaceError(
          "roles",
          'missing role artifact "plan/advance.md"',
        ),
      );

      const extra = makeFixture();
      extra.roleArtifacts.push({ path: "extra.md", content: "extra prompt\n" });
      expect(() => validator.validate(extra)).toThrow(
        new PackagedPromptSurfaceError("roles", 'undeclared role artifact "extra.md"'),
      );
    });

    test("rejects role-byte and aggregate-digest tampering", () => {
      const roleTamper = makeFixture();
      roleTamper.roleArtifacts[0] = {
        ...roleTamper.roleArtifacts[0]!,
        content: "tampered worker prompt\n",
      };
      expect(() => validator.validate(roleTamper)).toThrow(
        new PackagedPromptSurfaceError(
          "surface.json.roles[0].sha256",
          "does not match the installed role artifact bytes",
        ),
      );

      const schemaTamper = makeFixture();
      schemaTamper.schemaArtifacts[0] = {
        ...schemaTamper.schemaArtifacts[0]!,
        content: `${schemaTamper.schemaArtifacts[0]!.content} `,
      };
      expect(() => validator.validate(schemaTamper)).toThrow(
        new PackagedPromptSurfaceError(
          "surface.json.roles[0].schemaSha256",
          "does not match the installed schema artifact bytes",
        ),
      );

      const missingSchema = makeFixture();
      missingSchema.schemaArtifacts = [];
      expect(() => validator.validate(missingSchema)).toThrow(
        new PackagedPromptSurfaceError(
          "schemas",
          'missing schema artifact "implement-worker.json"',
        ),
      );

      const orchestratorSchema = makeFixture();
      orchestratorSchema.schemaArtifacts = [
        ...orchestratorSchema.schemaArtifacts,
        { path: "plan/advance.json", content: "{}" },
      ];
      expect(() => validator.validate(orchestratorSchema)).toThrow(
        new PackagedPromptSurfaceError(
          "schemas",
          'undeclared schema artifact "plan/advance.json"',
        ),
      );

      const digestTamper = makeFixture();
      const manifest = JSON.parse(digestTamper.surfaceJson) as { surfaceDigest: string };
      manifest.surfaceDigest = "0".repeat(64);
      digestTamper.surfaceJson = JSON.stringify(manifest);
      expect(() => validator.validate(digestTamper)).toThrow(
        new PackagedPromptSurfaceError(
          "surface.json.surfaceDigest",
          "does not match the canonical manifest core",
        ),
      );
    });
  });
}

describe("validate-prompt-surface-attestation CLI", () => {
  test("accepts a valid root and rejects a tampered role", () => {
    const fixture = makeFixture();
    const root = materialize(fixture);
    const accepted = Bun.spawnSync(
      ["bun", "run", VALIDATE_SCRIPT, fixture.expectedSurface, root],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(new TextDecoder().decode(accepted.stderr)).toBe("");
    expect(accepted.exitCode).toBe(0);

    writeFileSync(path.join(root, "roles", "implement-worker.md"), "tampered\n");
    const rejected = Bun.spawnSync(
      ["bun", "run", VALIDATE_SCRIPT, fixture.expectedSurface, root],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(rejected.exitCode).toBe(1);
    expect(new TextDecoder().decode(rejected.stderr)).toContain(
      "surface.json.roles[0].sha256: does not match the installed role artifact bytes",
    );
  });
});
