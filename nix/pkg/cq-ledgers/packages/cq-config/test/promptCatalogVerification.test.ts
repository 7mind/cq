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
  const catalog = [
    {
      roleId: "worker",
      roleKind: "dispatched-subagent",
      canonicalSource: "agents/worker.md",
      surfaces: SURFACES,
      fragmentBindings: [binding],
      dispatchRelations: [],
      intentionalDifferences: [INVOCATION_DIFFERENCE],
      sidecar: { schemaRoleId: "worker" },
    },
    {
      roleId: "start",
      roleKind: "orchestrator-command",
      canonicalSource: "commands/cq/start.md",
      surfaces: SURFACES,
      fragmentBindings: [binding],
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
    fragmentContracts: [binding],
  };
  const roleBodies: Record<PromptSurface, Readonly<Record<string, string>>> = {
    claude: {
      worker: "worker /cq:advance $ARGUMENTS\n",
      start: "start /cq:advance $ARGUMENTS\n",
    },
    codex: {
      worker: "worker $cq-advance $ARGUMENTS\n",
      start: "start $cq-advance $ARGUMENTS\n",
    },
    pi: {
      worker: "worker CQ::advance $ARGUMENTS\n",
      start: "start CQ::advance $ARGUMENTS\n",
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
    fragmentObservations: [
      { roleId: "worker", fragment: binding.fragment, contents: fragmentContents },
      { roleId: "start", fragment: binding.fragment, contents: fragmentContents },
    ],
    sidecarRoleIds: ["worker"],
  };
}

function mutableFixture(): PromptCatalogVerificationInput {
  return structuredClone(fixture());
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
    expect(() => verifyPromptCatalog(missing)).toThrow("missing difference declaration");

    const stale = mutableFixture();
    const observation = stale.fragmentObservations[0]!;
    (observation.contents as Record<PromptSurface, string>).codex =
      observation.contents.claude;
    (observation.contents as Record<PromptSurface, string>).pi =
      observation.contents.claude;
    expect(() => verifyPromptCatalog(stale)).toThrow("stale difference declaration");

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
});
