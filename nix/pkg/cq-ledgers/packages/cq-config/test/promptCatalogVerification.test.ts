import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  PROMPT_SURFACE_MANIFEST_FIELDS,
  PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS,
  serializePromptSurfaceManifest,
  verifyPromptCatalog,
  type PromptCatalogVerificationInput,
  type PromptSurface,
} from "@cq/config";

const SURFACES = ["claude", "codex", "pi"] as const;
const INVOCATION_DIFFERENCE = {
  kind: "invocation-syntax",
  reason: "Each surface invokes the workflow through its native syntax.",
  surfaces: SURFACES,
} as const;

/** Lowercase hex SHA-256 of the UTF-8 encoding of `value`. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The fixture's schema-sidecar versions (worker is the dispatched role). */
const FIXTURE_ROLE_VERSIONS: Readonly<Record<string, number>> = { worker: 1 };

/**
 * Serialize the attested surface manifest (T683 canonical byte shape) for one
 * fixture root from its current artifact bytes.
 */
function stampSurfaceManifest(
  surface: PromptSurface,
  catalogJson: string,
  artifacts: Readonly<Record<string, string>>,
): string {
  const roleIds = Object.keys(artifacts)
    .filter((artifactPath) => artifactPath.startsWith("roles/") && artifactPath.endsWith(".md"))
    .map((artifactPath) => artifactPath.slice("roles/".length, -".md".length));
  const catalog = JSON.parse(catalogJson) as readonly {
    readonly roleId: string;
    readonly sidecar: unknown;
  }[];
  const roles = catalog.map(({ roleId, sidecar }) => {
    const content = artifacts[`roles/${roleId}.md`];
    if (content === undefined) {
      throw new Error(`fixture root has no rendered bytes for role "${roleId}"`);
    }
    if (sidecar === null) {
      return {
        roleId,
        version: null,
        sha256: sha256Hex(content),
        schemaSha256: null,
      };
    }
    const schemaContent = artifacts[`schemas/${roleId}.json`];
    if (schemaContent === undefined) {
      throw new Error(`fixture root has no schema bytes for role "${roleId}"`);
    }
    return {
      roleId,
      version: FIXTURE_ROLE_VERSIONS[roleId] ?? 1,
      sha256: sha256Hex(content),
      schemaSha256: sha256Hex(schemaContent),
    };
  });
  if (roles.length !== roleIds.length) {
    throw new Error("fixture root role artifacts do not cover the catalog");
  }
  return serializePromptSurfaceManifest(surface, sha256Hex(catalogJson), roles);
}

/** Recompute every packaged (and local Claude) surface manifest after a byte mutation. */
function restampSurfaceManifests(input: PromptCatalogVerificationInput): void {
  for (const surface of SURFACES) {
    const packaged = input.packagedRoots[surface].artifacts as Record<string, string>;
    packaged["surface.json"] = stampSurfaceManifest(
      surface,
      input.authoritativeCatalogJson,
      packaged,
    );
    const expected = input.expectedRoots[surface].artifacts as Record<string, string>;
    expected["surface.json"] = stampSurfaceManifest(
      surface,
      input.authoritativeCatalogJson,
      expected,
    );
  }
  const local = input.localClaudeRoot.artifacts as Record<string, string>;
  local["surface.json"] = stampSurfaceManifest("claude", input.authoritativeCatalogJson, local);
}

function fixture(): PromptCatalogVerificationInput {
  const binding = {
    fragment: "cq-command-invocation",
    supportedSurfaces: SURFACES,
    forbiddenVocabulary: {
      claude: ["$cq-"],
      codex: ["/cq:"],
      pi: ["$cq-"],
    },
    intentionalDifference: INVOCATION_DIFFERENCE,
  };
  const policyBinding = {
    fragment: "policy",
    supportedSurfaces: SURFACES,
    forbiddenVocabulary: {
      claude: [],
      codex: [],
      pi: [],
    },
    intentionalDifference: {
      kind: "tool-vocabulary",
      reason: "A policy fragment may vary when a surface requires it.",
      surfaces: SURFACES,
    },
  } as const;
  const catalog = [
    {
      roleId: "worker",
      roleKind: "dispatched-subagent",
      canonicalSource: "agents/worker.md",
      surfaces: SURFACES,
      fragmentBindings: [binding, policyBinding],
      dispatchRelations: [],
      intentionalDifferences: [INVOCATION_DIFFERENCE],
      sidecar: { schemaRoleId: "worker" },
    },
    {
      roleId: "start",
      roleKind: "orchestrator-command",
      canonicalSource: "commands/cq/start.md",
      surfaces: SURFACES,
      fragmentBindings: [binding, policyBinding],
      dispatchRelations: [
        { kind: "dispatch", targetRoleId: "worker" },
        { kind: "recursion", targetRoleId: "start" },
      ],
      intentionalDifferences: [INVOCATION_DIFFERENCE],
      sidecar: null,
    },
  ];
  const authoritativeCatalogJson = JSON.stringify(catalog);
  const catalogMetadataHash = createHash("sha256")
    .update(authoritativeCatalogJson)
    .digest("hex");
  const projection = {
    schemaVersion: 1,
    catalog,
    catalogMetadataHash,
    fragmentContracts: [binding, policyBinding],
  };
  const roleBodies: Record<PromptSurface, Readonly<Record<string, string>>> = {
    claude: {
      worker: "worker /cq:advance $ARGUMENTS policy common\n",
      start: "start /cq:advance $ARGUMENTS policy common\n",
    },
    codex: {
      worker: "worker $cq-advance $ARGUMENTS policy common\n",
      start: "start $cq-advance $ARGUMENTS policy common\n",
    },
    pi: {
      worker: "worker CQ::advance $ARGUMENTS policy common\n",
      start: "start CQ::advance $ARGUMENTS policy common\n",
    },
  };
  const roots = Object.fromEntries(
    SURFACES.map((surface) => {
      const artifacts: Record<string, string> = {
        "catalog.json": authoritativeCatalogJson,
        "schemas/worker.json": JSON.stringify({
          id: "worker",
          version: 1,
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        }),
        "roles/worker.md": roleBodies[surface].worker!,
        "roles/start.md": roleBodies[surface].start!,
      };
      artifacts["surface.json"] = stampSurfaceManifest(
        surface,
        authoritativeCatalogJson,
        artifacts,
      );
      return [surface, { surface, artifacts }];
    }),
  ) as unknown as Record<
    PromptSurface,
    PromptCatalogVerificationInput["expectedRoots"][PromptSurface]
  >;
  const fragmentContents = {
    claude: "/cq:advance $ARGUMENTS",
    codex: "$cq-advance $ARGUMENTS",
    pi: "CQ::advance $ARGUMENTS",
  };
  return {
    authoritativeCatalogJson,
    authoritativeProjection: structuredClone(projection),
    generatedProjection: structuredClone(projection),
    expectedRoots: structuredClone(roots),
    packagedRoots: structuredClone(roots),
    localClaudeRoot: structuredClone(roots.claude),
    canonicalSources: {
      "agents/worker.md":
        "worker {{cq:fragment:cq-command-invocation}} policy {{cq:fragment:policy}}\n",
      "commands/cq/start.md":
        "start {{cq:fragment:cq-command-invocation}} policy {{cq:fragment:policy}}\n",
    },
    fragmentObservations: [
      { roleId: "worker", fragment: binding.fragment, contents: fragmentContents },
      { roleId: "start", fragment: binding.fragment, contents: fragmentContents },
      {
        roleId: "worker",
        fragment: policyBinding.fragment,
        contents: { claude: "common", codex: "common", pi: "common" },
      },
      {
        roleId: "start",
        fragment: policyBinding.fragment,
        contents: { claude: "common", codex: "common", pi: "common" },
      },
    ],
    sidecarRoleIds: ["worker"],
  };
}

function mutableFixture(): PromptCatalogVerificationInput {
  return structuredClone(fixture());
}

function mutateRenderedRole(
  input: PromptCatalogVerificationInput,
  roleId: string,
  mutate: (surface: PromptSurface, content: string) => string,
): void {
  const artifactPath = `roles/${roleId}.md`;
  for (const surface of SURFACES) {
    const expected = input.expectedRoots[surface].artifacts as Record<string, string>;
    const packaged = input.packagedRoots[surface].artifacts as Record<string, string>;
    expected[artifactPath] = mutate(surface, expected[artifactPath]!);
    packaged[artifactPath] = mutate(surface, packaged[artifactPath]!);
    if (surface === "claude") {
      const local = input.localClaudeRoot.artifacts as Record<string, string>;
      local[artifactPath] = mutate(surface, local[artifactPath]!);
    }
  }
}

describe("prompt-catalog centralized verification mutation fixtures", () => {
  test("accepts the independently assembled closed fixture", () => {
    expect(() => verifyPromptCatalog(fixture())).not.toThrow();
  });

  test("rejects ordered projection and metadata-hash drift", () => {
    const input = mutableFixture();
    const generated = input.generatedProjection as { catalog: unknown[] };
    generated.catalog.reverse();
    expect(() => verifyPromptCatalog(input)).toThrow("ordered role catalog");
  });

  test("rejects role/artifact closure drift", () => {
    const input = mutableFixture();
    delete (input.packagedRoots.pi.artifacts as Record<string, string>)["roles/worker.md"];
    expect(() => verifyPromptCatalog(input)).toThrow("missing role artifact");
  });

  test("accepts a declared surface-specific artifact and rejects byte drift", () => {
    // Regression origin: T1329 added an authoritative Pi-only tool-profile artifact.
    const input = mutableFixture();
    const artifactPath = "role-tool-profiles.json";
    (input.expectedRoots.pi.artifacts as Record<string, string>)[artifactPath] =
      '{"schemaVersion":1}';
    (input.packagedRoots.pi.artifacts as Record<string, string>)[artifactPath] =
      '{"schemaVersion":1}';
    expect(() => verifyPromptCatalog(input)).not.toThrow();

    (input.packagedRoots.pi.artifacts as Record<string, string>)[artifactPath] =
      '{"schemaVersion":2}';
    expect(() => verifyPromptCatalog(input)).toThrow(
      `${artifactPath}: source drift from deterministic rendering`,
    );
  });

  test("rejects unsupported surfaces, source drift, and sidecar drift", () => {
    const unsupported = mutableFixture();
    const catalog = (
      unsupported.authoritativeProjection as {
        catalog: Array<{ surfaces: string[] }>;
      }
    ).catalog;
    catalog[0]!.surfaces = ["claude", "codex"];
    expect(() => verifyPromptCatalog(unsupported)).toThrow("supported surfaces");

    const sourceDrift = mutableFixture();
    (sourceDrift.packagedRoots.codex.artifacts as Record<string, string>)[
      "roles/worker.md"
    ] = "drifted $ARGUMENTS\n";
    restampSurfaceManifests(sourceDrift);
    expect(() => verifyPromptCatalog(sourceDrift)).toThrow("source drift");

    const sidecarDrift = mutableFixture();
    (sidecarDrift.sidecarRoleIds as string[]).push("start");
    expect(() => verifyPromptCatalog(sidecarDrift)).toThrow("sidecar closure");
  });

  test("rejects dangling dispatch edges and rendered semantic hazards", () => {
    const dispatch = mutableFixture();
    const catalog = (
      dispatch.authoritativeProjection as {
        catalog: Array<{ dispatchRelations: Array<{ targetRoleId: string }> }>;
      }
    ).catalog;
    catalog[1]!.dispatchRelations[0]!.targetRoleId = "missing";
    expect(() => verifyPromptCatalog(dispatch)).toThrow("unknown dispatch target");

    const forbidden = mutableFixture();
    (forbidden.packagedRoots.codex.artifacts as Record<string, string>)[
      "roles/worker.md"
    ] += "/cq:";
    restampSurfaceManifests(forbidden);
    expect(() => verifyPromptCatalog(forbidden)).toThrow("forbidden vocabulary");

    const unresolved = mutableFixture();
    (unresolved.packagedRoots.pi.artifacts as Record<string, string>)[
      "roles/start.md"
    ] += "{{cq:fragment:cq-command-invocation}}";
    restampSurfaceManifests(unresolved);
    expect(() => verifyPromptCatalog(unresolved)).toThrow("unresolved slot");

    const placeholder = mutableFixture();
    (placeholder.packagedRoots.claude.artifacts as Record<string, string>)[
      "roles/worker.md"
    ] = "worker /cq:advance\n";
    restampSurfaceManifests(placeholder);
    expect(() => verifyPromptCatalog(placeholder)).toThrow("runtime placeholder");
  });

  test("adjudicates missing, stale, unknown, and duplicate difference declarations", () => {
    const missing = mutableFixture();
    const missingCatalog = (
      missing.authoritativeProjection as {
        catalog: Array<{ intentionalDifferences: unknown[] }>;
      }
    ).catalog;
    missingCatalog[0]!.intentionalDifferences = [];
    const missingGeneratedCatalog = (
      missing.generatedProjection as {
        catalog: Array<{ intentionalDifferences: unknown[] }>;
      }
    ).catalog;
    missingGeneratedCatalog[0]!.intentionalDifferences = [];
    expect(() => verifyPromptCatalog(missing)).toThrow("missing difference declaration");

    const stale = mutableFixture();
    const observation = stale.fragmentObservations[0]!;
    (observation.contents as Record<PromptSurface, string>).codex =
      observation.contents.claude;
    (observation.contents as Record<PromptSurface, string>).pi =
      observation.contents.claude;
    expect(() => verifyPromptCatalog(stale)).toThrow(
      "source drift from authoritative fragment input",
    );

    const unknown = mutableFixture();
    const unknownCatalog = (
      unknown.authoritativeProjection as {
        catalog: Array<{ intentionalDifferences: unknown[] }>;
      }
    ).catalog;
    unknownCatalog[0]!.intentionalDifferences.push({
      kind: "tool-vocabulary",
      reason: "No bound fragment declares this difference.",
      surfaces: SURFACES,
    });
    expect(() => verifyPromptCatalog(unknown)).toThrow("unknown difference declaration");

    const duplicate = mutableFixture();
    const duplicateCatalog = (
      duplicate.authoritativeProjection as {
        catalog: Array<{ intentionalDifferences: unknown[] }>;
      }
    ).catalog;
    duplicateCatalog[0]!.intentionalDifferences.push(INVOCATION_DIFFERENCE);
    expect(() => verifyPromptCatalog(duplicate)).toThrow(
      "duplicate difference declaration",
    );
  });

  test("rejects an undeclared difference observed only in a rendered slot segment", () => {
    const undeclaredRenderedDifference = mutableFixture();
    mutateRenderedRole(
      undeclaredRenderedDifference,
      "worker",
      (surface, content) => content.replace("policy common", `policy ${surface}`),
    );
    restampSurfaceManifests(undeclaredRenderedDifference);
    expect(() => verifyPromptCatalog(undeclaredRenderedDifference)).toThrow(
      "missing difference declaration",
    );
  });

  test("rejects a stale declaration whose rendered slot segment is identical", () => {
    const staleRenderedDifference = mutableFixture();
    mutateRenderedRole(staleRenderedDifference, "worker", (_surface, content) =>
      content.replace(
        /(?:\/cq:advance|\$cq-advance|CQ::advance) \$ARGUMENTS/,
        "same-invocation $ARGUMENTS",
      ),
    );
    restampSurfaceManifests(staleRenderedDifference);
    expect(() => verifyPromptCatalog(staleRenderedDifference)).toThrow(
      "stale difference declaration",
    );
  });

  test("fails closed on a stale per-role digest (T683)", () => {
    const staleDigest = mutableFixture();
    (staleDigest.packagedRoots.codex.artifacts as Record<string, string>)[
      "roles/worker.md"
    ] = "tampered bytes\n";
    expect(() => verifyPromptCatalog(staleDigest)).toThrow(
      "does not match the installed role artifact bytes",
    );
  });

  // Behavioral-Active Blackbox-Group: catalog verification follows the exported shape.
  test("surface validation accepts exactly the canonical exported field sets", () => {
    const exact = mutableFixture();
    const exactArtifacts = exact.packagedRoots.claude.artifacts as Record<string, string>;
    const manifest = JSON.parse(exactArtifacts["surface.json"]!) as Record<string, unknown>;
    const roles = manifest.roles as Array<Record<string, unknown>>;
    expect(Object.keys(manifest)).toEqual([...PROMPT_SURFACE_MANIFEST_FIELDS]);
    expect(Object.keys(roles[0]!)).toEqual([...PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS]);
    expect(() => verifyPromptCatalog(exact)).not.toThrow();

    const expectRejected = (mutate: (candidate: Record<string, unknown>) => void): void => {
      const input = mutableFixture();
      const artifacts = input.packagedRoots.claude.artifacts as Record<string, string>;
      const candidate = JSON.parse(artifacts["surface.json"]!) as Record<string, unknown>;
      mutate(candidate);
      artifacts["surface.json"] = JSON.stringify(candidate);
      expect(() => verifyPromptCatalog(input)).toThrow();
    };

    for (const field of PROMPT_SURFACE_MANIFEST_FIELDS) {
      expectRejected((candidate) => {
        delete candidate[field];
      });
      expectRejected((candidate) => {
        candidate[`${field}Renamed`] = candidate[field];
        delete candidate[field];
      });
    }
    expectRejected((candidate) => {
      candidate.extra = true;
    });

    for (const field of PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS) {
      expectRejected((candidate) => {
        delete (candidate.roles as Array<Record<string, unknown>>)[0]![field];
      });
      expectRejected((candidate) => {
        const role = (candidate.roles as Array<Record<string, unknown>>)[0]!;
        role[`${field}Renamed`] = role[field];
        delete role[field];
      });
    }
    expectRejected((candidate) => {
      (candidate.roles as Array<Record<string, unknown>>)[0]!.extra = true;
    });
  });

  test("fails closed on stale catalog, aggregate, version, and roster attestation drift", () => {
    const tamper = (
      mutate: (manifest: {
        catalogMetadataHash: string;
        roles: { roleId: string; version: number | null; sha256: string; schemaSha256: string | null}[];
        surfaceDigest: string;
      }) => void,
    ): PromptCatalogVerificationInput => {
      const input = mutableFixture();
      const artifacts = input.packagedRoots.pi.artifacts as Record<string, string>;
      const manifest = JSON.parse(artifacts["surface.json"]!) as {
        catalogMetadataHash: string;
        roles: { roleId: string; version: number | null; sha256: string; schemaSha256: string | null}[];
        surfaceDigest: string;
      };
      mutate(manifest);
      artifacts["surface.json"] = JSON.stringify(manifest);
      return input;
    };

    expect(() =>
      verifyPromptCatalog(
        tamper((manifest) => {
          manifest.catalogMetadataHash = "0".repeat(64);
        }),
      ),
    ).toThrow("does not match the installed catalog.json bytes");

    expect(() =>
      verifyPromptCatalog(
        tamper((manifest) => {
          manifest.roles = manifest.roles.filter((entry) => entry.roleId !== "start");
        }),
      ),
    ).toThrow("expected 2 role attestations");

    expect(() =>
      verifyPromptCatalog(
        tamper((manifest) => {
          manifest.roles[0]!.version = null;
        }),
      ),
    ).toThrow("expected a positive integer schema-sidecar version");

    expect(() =>
      verifyPromptCatalog(
        tamper((manifest) => {
          manifest.roles[1]!.version = 2;
        }),
      ),
    ).toThrow("orchestrator-command roles must carry null");

    expect(() =>
      verifyPromptCatalog(
        tamper((manifest) => {
          manifest.roles.reverse();
        }),
      ),
    ).toThrow("in canonical catalog order");

    expect(() =>
      verifyPromptCatalog(
        tamper((manifest) => {
          manifest.surfaceDigest = "f".repeat(64);
        }),
      ),
    ).toThrow("surface aggregate digest does not match");
  });
});
