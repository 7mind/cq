import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  SqliteAttestationBackend,
  sequentialDispatchRandomBytes,
  type AttestationBackend,
  type DispatchJSONValue,
} from "@cq/config";
import { createInMemoryWorkCohortStore, type InvestigationPreparedDispatchV1 } from "@cq/ledger";
import {
  ManualInvestigationHost,
  INVESTIGATION_NOW,
  investigationPlanFixture,
  investigationRole,
} from "../../ledger/test/workCohortInvestigationFixture.js";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import {
  createInvestigationCohortRuntimeV1,
  createRepositoryInvestigationCitationResolverV1,
} from "../src/workCohortInvestigationRuntime.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

function artifacts(): PromptArtifactStore {
  const roles = ["investigate-explorer", "investigate-prober"].map((roleId) => {
    const role = investigationRole(roleId as "investigate-explorer" | "investigate-prober");
    return {
      roleId,
      roleKind: "dispatched-subagent" as const,
      artifactPath: `roles/${roleId}.md`,
      sidecarSchemaRoleId: roleId,
      promptSurface: role.surface,
      promptDigest: role.promptDigest,
      schemaVersion: role.version,
      schemaDigest: role.schemaDigest,
    };
  });
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles,
      promptSurface: "claude",
      catalogHash: investigationRole("investigate-explorer").catalogHash,
    }),
    readRole: (roleId) => {
      const metadata = roles.find((role) => role.roleId === roleId);
      if (metadata === undefined) throw new Error("fixture role unavailable");
      return { metadata, bytes: new Uint8Array([1]) };
    },
  };
}

for (const adapter of ["memory", "SQLite"] as const) {
  describe(`existing-role cohort dispatch ${adapter} [Behavioral-Active Blackbox-${adapter === "memory" ? "Group" : "GoodCommunication"}]`, () => {
    test("production adapter runs two explorers and two probers through existing prepare/store/confirm", async () => {
      const directory = await mkdtemp(join(tmpdir(), "cq-investigation-dispatch-"));
      const namespace = { backend: "xdg" as const, projectKey: "investigation-runtime" };
      const backend: AttestationBackend =
        adapter === "memory"
          ? new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace))
          : new SqliteAttestationBackend({ namespace, dbPath: join(directory, "attestations.db") });
      try {
        const store = createInMemoryWorkCohortStore();
        const { plan, source } = await investigationPlanFixture(store);
        const dispatch = createDispatchCapability({
          backend,
          promptArtifactStore: artifacts(),
          now: () => INVESTIGATION_NOW,
          randomBytes: sequentialDispatchRandomBytes(),
        });
        const manual = new ManualInvestigationHost();
        manual.probe = true;
        const launches: string[] = [];
        const runtime = createInvestigationCohortRuntimeV1({
          store,
          dispatch,
          backend,
          promptArtifacts: artifacts(),
          observationSource: source,
          timeoutMs: 60_000,
          resolveCitation: (prepared, evidence) => manual.resolveCitation(prepared, evidence),
          adjudicate: (member) => manual.adjudicate(member),
          validateCorrectionBoundary: (plan, causes, atom) =>
            manual.validateCorrectionBoundary(plan, causes, atom),
          launcher: {
            launch: async ({ prepared, binding, expectedChild }) => {
              launches.push(`${binding.member.defectRef}:${binding.role.roleId}`);
              const materialized = await dispatch.fetchInput({
                attestationId: prepared.attestationId,
                generation: prepared.generation,
                inputCapability: prepared.inputCapability,
              });
              expect(materialized.input).toEqual(binding.input);
              await dispatch.storeResult({
                resultCapability: prepared.resultCapability,
                output: manual.output(binding) as unknown as DispatchJSONValue,
              });
              return {
                kind: "native-completion",
                actor: "trusted-parent",
                ...expectedChild,
                completedAt: INVESTIGATION_NOW,
              };
            },
          },
        });
        const lease = await store.acquireLease({
          holderId: "runtime",
          semanticSubject: plan.planDigest,
        });
        const result = await runtime.runner.run(lease, plan);
        expect(result.state).toBe("correction-ready");
        expect(launches).toEqual([
          "defects:D1:investigate-explorer",
          "defects:D1:investigate-prober",
          "defects:D2:investigate-explorer",
          "defects:D2:investigate-prober",
        ]);
        expect((await runtime.runner.run(lease, plan)).runDigest).toBe(result.runDigest);
        expect(launches.length).toBe(4);
      } finally {
        await backend.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
}

test("repository citation resolver reopens exact lines and rejects symlink escapes [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cq-investigation-citation-"));
  const outside = await mkdtemp(join(tmpdir(), "cq-investigation-outside-"));
  try {
    await writeFile(join(directory, "source.ts"), "zero\nfirst\nsecond\nthird\nlast\n");
    await writeFile(join(outside, "foreign.ts"), "not scoped");
    await symlink(join(outside, "foreign.ts"), join(directory, "escape.ts"));
    const resolver = createRepositoryInvestigationCitationResolverV1(directory, {
      read: async () => {
        throw new Error("no retained command evidence");
      },
    });
    const prepared = {
      binding: { role: { roleId: "investigate-explorer" } },
    } as InvestigationPreparedDispatchV1;
    const evidence = {
      n: 1,
      citation: "source.ts:2-4",
      excerpt: "first\nsecond\nthird",
      relevance: "exact source",
    };
    expect((await resolver(prepared, evidence)).text).toBe(evidence.excerpt);
    await expect(resolver(prepared, { ...evidence, citation: "escape.ts:1" })).rejects.toThrow(
      "escapes",
    );
    await expect(
      resolver(prepared, { ...evidence, citation: "https://example.invalid/source" }),
    ).rejects.toThrow("local source range");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
