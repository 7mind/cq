import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
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
    SURFACES.map((surface) => [
      surface,
      {
        surface,
        artifacts: {
          "catalog.json": authoritativeCatalogJson,
          "surface.json": JSON.stringify({ surface }),
          "roles/worker.md": roleBodies[surface].worker!,
          "roles/start.md": roleBodies[surface].start!,
        },
      },
    ]),
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
    expect(() => verifyPromptCatalog(forbidden)).toThrow("forbidden vocabulary");

    const unresolved = mutableFixture();
    (unresolved.packagedRoots.pi.artifacts as Record<string, string>)[
      "roles/start.md"
    ] += "{{cq:fragment:cq-command-invocation}}";
    expect(() => verifyPromptCatalog(unresolved)).toThrow("unresolved slot");

    const placeholder = mutableFixture();
    (placeholder.packagedRoots.claude.artifacts as Record<string, string>)[
      "roles/worker.md"
    ] = "worker /cq:advance\n";
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
    expect(() => verifyPromptCatalog(staleRenderedDifference)).toThrow(
      "stale difference declaration",
    );
  });
});
