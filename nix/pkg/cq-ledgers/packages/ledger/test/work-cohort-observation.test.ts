import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "bun:test";

import {
  GitCohortLocalRepositoryV1,
  LocalCohortAdmissionObservationSourceV1,
  cohortObservationInvalidationsV1,
  constructCohortDecisionsV1,
  produceCohortAdmissionObservationV1,
  type CohortLocalAdmissionDefinitionV1,
  type CohortLocalRepositoryV1,
  type CohortRepositoryIdentityV1,
  type CohortSourceRelationshipV1,
} from "../src/workCohort.js";
import { commit, observationFor, sha256, snapshotFor } from "./workCohortFixture.js";

const execFileAsync = promisify(execFile);
const LOCAL_DEFINITION_PATH = "cohort-definition.json";

function localDefinition(nodeIdentity = "shared#CohortContract"): {
  readonly definition: CohortLocalAdmissionDefinitionV1;
  readonly environmentDigest: string;
} {
  const snapshot = snapshotFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }], {});
  const members = snapshot.members.map((member) => {
    const {
      repository: _repository,
      environment: _environment,
      ...memberWithoutRuntimeIdentity
    } = member;
    return {
      ...memberWithoutRuntimeIdentity,
      boundaryCandidates: memberWithoutRuntimeIdentity.boundaryCandidates.map((candidate) => ({
        ...candidate,
        focusedCommand: {
          ...candidate.focusedCommand,
          provenance: {
            ...candidate.focusedCommand.provenance,
            sourceRef: `src/${member.memberRef}.ts`,
          },
        },
        witness:
          candidate.witness.kind === "repository-node"
            ? { ...candidate.witness, nodeIdentity }
            : candidate.witness,
      })),
    };
  });
  return {
    definition: {
      kind: "cq-local-cohort-admission-definition",
      version: 1,
      workset: snapshot.workset,
      manifest: snapshot.manifest,
      members,
      authenticatedBenefitReceipts: snapshot.authenticatedBenefitReceipts,
      unavailableFacts: snapshot.unavailableFacts,
    },
    environmentDigest: snapshot.environment.environmentDigest,
  };
}

function localRepositoryFiles(nodeIdentity?: string): ReadonlyMap<string, string> {
  const local = localDefinition(nodeIdentity);
  return new Map([
    [LOCAL_DEFINITION_PATH, JSON.stringify(local.definition)],
    ["package.json", JSON.stringify({ name: "cohort-source" })],
    [
      "src/tasks:T1.ts",
      'import type { CohortContract } from "./contracts/shared";\nexport const taskOne: CohortContract = { version: 1 };\n',
    ],
    [
      "src/tasks:T2.ts",
      'import type { CohortContract } from "./contracts/shared";\nexport const taskTwo: CohortContract = { version: 1 };\n',
    ],
    ["src/contracts/shared.ts", "export interface CohortContract { readonly version: 1 }\n"],
    [
      "tests/cohort.test.ts",
      'import type { CohortContract } from "../src/contracts/shared";\nexport type TestContract = CohortContract;\n',
    ],
    ["src/unrelated.ts", "export const unrelated = true;\n"],
  ]);
}

class InMemoryCohortLocalRepository implements CohortLocalRepositoryV1 {
  readonly #files: ReadonlyMap<string, string>;

  constructor(files: ReadonlyMap<string, string>) {
    this.#files = files;
  }

  async resolveIdentity(): Promise<CohortRepositoryIdentityV1> {
    return {
      repositoryId: "repository:test",
      headCommit: commit("local-head"),
      treeOid: commit("local-tree"),
    };
  }

  async readFile(_identity: CohortRepositoryIdentityV1, path: string): Promise<string | null> {
    return this.#files.get(path) ?? null;
  }

  async resolveRelationship(
    _identity: CohortRepositoryIdentityV1,
    from: string,
    to: string,
  ): Promise<CohortSourceRelationshipV1 | null> {
    if (to === "package.json" && from !== LOCAL_DEFINITION_PATH) return "package";
    if (from === "tests/cohort.test.ts" && to === "src/contracts/shared.ts") return "test";
    if (
      (from === "src/tasks:T1.ts" || from === "src/tasks:T2.ts") &&
      to === "src/contracts/shared.ts"
    ) {
      return "import";
    }
    return null;
  }
}

class RecordingCohortLocalRepository implements CohortLocalRepositoryV1 {
  readonly reads: string[] = [];
  readonly #delegate: CohortLocalRepositoryV1;

  constructor(delegate: CohortLocalRepositoryV1) {
    this.#delegate = delegate;
  }

  async resolveIdentity(): Promise<CohortRepositoryIdentityV1> {
    return await this.#delegate.resolveIdentity();
  }

  async readFile(identity: CohortRepositoryIdentityV1, path: string): Promise<string | null> {
    this.reads.push(path);
    return await this.#delegate.readFile(identity, path);
  }

  async resolveRelationship(
    identity: CohortRepositoryIdentityV1,
    from: string,
    to: string,
  ): Promise<CohortSourceRelationshipV1 | null> {
    return await this.#delegate.resolveRelationship(identity, from, to);
  }
}

interface LocalRepositoryHarness {
  readonly repository: CohortLocalRepositoryV1;
  close(): Promise<void>;
}

async function inMemoryRepositoryHarness(nodeIdentity?: string): Promise<LocalRepositoryHarness> {
  return {
    repository: new InMemoryCohortLocalRepository(localRepositoryFiles(nodeIdentity)),
    close: async () => undefined,
  };
}

async function gitRepositoryHarness(
  nodeIdentity?: string,
  overrides: ReadonlyMap<string, string> = new Map(),
): Promise<LocalRepositoryHarness> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "cq-cohort-source-"));
  const files = new Map(localRepositoryFiles(nodeIdentity));
  for (const [path, bytes] of overrides) files.set(path, bytes);
  for (const [path, bytes] of files) {
    const absolute = join(repositoryRoot, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  const git = async (args: readonly string[]): Promise<void> => {
    await execFileAsync("git", [...args], { cwd: repositoryRoot });
  };
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "cq-test"]);
  await git(["config", "user.email", "cq-test@localhost"]);
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "cohort source fixture"]);
  return {
    repository: new GitCohortLocalRepositoryV1({
      repositoryRoot,
      repositoryId: "repository:test",
    }),
    close: async () => await rm(repositoryRoot, { recursive: true, force: true }),
  };
}

const LOCAL_REPOSITORY_FACTORIES = [
  ["manual in-memory", inMemoryRepositoryHarness],
  ["production Git", gitRepositoryHarness],
] as const;

describe("cohort admission observation", () => {
  test("freezes distinct focused plans under one correlated common atom", async () => {
    const observation = await observationFor([
      { ref: "tasks:T1", atoms: [{ command: "focused-one" }] },
      { ref: "tasks:T2", atoms: [{ command: "focused-two" }] },
    ]);
    const [decision] = constructCohortDecisionsV1(observation);

    expect(decision?.includedMemberRefs).toEqual(["tasks:T1", "tasks:T2"]);
    expect(decision?.matrix.members.map((member) => member.focusedPlanDigest)).toHaveLength(2);
    expect(new Set(decision?.matrix.members.map((member) => member.focusedPlanDigest)).size).toBe(2);
    expect(decision?.matrix.normalizedCommandClasses).toHaveLength(2);
    expect(decision?.benefit.unknownBoundaryDigests).toHaveLength(3);
  });

  test("deduplicates equal normalized commands without collapsing member plans", async () => {
    const observation = await observationFor([
      { ref: "tasks:T1", atoms: [{ command: "same-focused" }] },
      { ref: "tasks:T2", atoms: [{ command: "same-focused" }] },
    ]);
    const [decision] = constructCohortDecisionsV1(observation);

    expect(decision?.matrix.normalizedCommandClasses).toHaveLength(1);
    expect(decision?.matrix.normalizedCommandClasses[0]?.memberRefs).toEqual([
      "tasks:T1",
      "tasks:T2",
    ]);
    expect(new Set(decision?.matrix.members.map((member) => member.focusedPlanDigest)).size).toBe(2);
  });

  test("changed command, manifest, HEAD, source graph, environment, and authority invalidate", async () => {
    const specs = [
      { ref: "tasks:T1", atoms: [{ command: "one" }] },
      { ref: "tasks:T2", atoms: [{ command: "two" }] },
    ] as const;
    const prior = await observationFor(specs);
    const command = await observationFor([
      specs[0],
      { ref: "tasks:T2", atoms: [{ command: "changed" }] },
    ]);
    const manifest = await observationFor(specs, { manifestRevision: "manifest:2" });
    const head = await observationFor(specs, {
      repository: {
        repositoryId: "repository:test",
        headCommit: commit("changed-head"),
        treeOid: commit("changed-tree"),
      },
    });
    const source = await observationFor(specs, { sourceSalt: "changed" });
    const environment = await observationFor(specs, { environment: "changed" });
    const authority = await observationFor([specs[0], { ...specs[1], authority: "changed" }]);
    const workset = await observationFor(specs, { worksetRevision: "workset:2" });

    expect(cohortObservationInvalidationsV1(prior, command)).toContain("command");
    expect(cohortObservationInvalidationsV1(prior, manifest)).toContain("manifest");
    expect(cohortObservationInvalidationsV1(prior, head)).toContain("source-or-tree");
    expect(cohortObservationInvalidationsV1(prior, source)).toContain("source-or-tree");
    expect(cohortObservationInvalidationsV1(prior, environment)).toContain("environment");
    expect(cohortObservationInvalidationsV1(prior, authority)).toContain("authority");
    expect(cohortObservationInvalidationsV1(prior, workset)).toContain("workset");
    expect(constructCohortDecisionsV1(command)[0]?.matrix.matrixDigest).not.toBe(
      constructCohortDecisionsV1(prior)[0]?.matrix.matrixDigest,
    );
  });

  test("caller prose cannot create admission evidence", async () => {
    const specs = [{ ref: "tasks:T1" }, { ref: "tasks:T2" }] as const;
    const snapshot = snapshotFor(specs, {});
    const source = { resolveExactSnapshot: async () => snapshot };
    const plain = await produceCohortAdmissionObservationV1(
      { memberRefs: ["tasks:T1", "tasks:T2"] },
      source,
    );
    const prose = await produceCohortAdmissionObservationV1(
      { memberRefs: ["tasks:T1", "tasks:T2"], assertion: "same package" } as {
        memberRefs: readonly string[];
      },
      source,
    );

    expect(prose.observationDigest).toBe(plain.observationDigest);
  });

  for (const [adapterName, makeRepository] of LOCAL_REPOSITORY_FACTORIES) {
    test(`${adapterName} source resolves one bounded committed observation`, async () => {
      const harness = await makeRepository();
      try {
        const recording = new RecordingCohortLocalRepository(harness.repository);
        const local = localDefinition();
        const source = new LocalCohortAdmissionObservationSourceV1({
          repository: recording,
          definitionPath: LOCAL_DEFINITION_PATH,
          environment: { environmentDigest: local.environmentDigest },
        });
        const request = { memberRefs: ["tasks:T1", "tasks:T2"] } as const;
        const observation = await produceCohortAdmissionObservationV1(request, source);
        const prose = await produceCohortAdmissionObservationV1(
          { ...request, assertion: "same file" } as typeof request,
          source,
        );

        expect(constructCohortDecisionsV1(observation)[0]?.includedMemberRefs).toEqual([
          "tasks:T1",
          "tasks:T2",
        ]);
        expect(observation.producer).toBe("cq-local-repository-cohort-producer");
        expect(prose.observationDigest).toBe(observation.observationDigest);
        expect(
          observation.members[0]?.attestations[0]?.acceptancePlan.provenance.sourceRevision,
        ).toBe(sha256(localRepositoryFiles().get("src/tasks:T1.ts")));
        expect(recording.reads).not.toContain("src/unrelated.ts");
        const repositoryIdentity = await recording.resolveIdentity();
        expect(
          await recording.resolveRelationship(
            repositoryIdentity,
            "src/tasks:T1.ts",
            "src/contracts/shared.ts",
          ),
        ).toBe("import");
        expect(
          await recording.resolveRelationship(
            repositoryIdentity,
            "tests/cohort.test.ts",
            "src/contracts/shared.ts",
          ),
        ).toBe("test");
        expect(
          await recording.resolveRelationship(
            repositoryIdentity,
            "src/tasks:T1.ts",
            "package.json",
          ),
        ).toBe("package");
      } finally {
        await harness.close();
      }
    });

    test(`${adapterName} source rejects a same-file different-symbol witness`, async () => {
      const harness = await makeRepository("shared#MissingContract");
      try {
        const local = localDefinition("shared#MissingContract");
        const source = new LocalCohortAdmissionObservationSourceV1({
          repository: harness.repository,
          definitionPath: LOCAL_DEFINITION_PATH,
          environment: { environmentDigest: local.environmentDigest },
        });
        await expect(
          produceCohortAdmissionObservationV1(
            { memberRefs: ["tasks:T1", "tasks:T2"] },
            source,
          ),
        ).rejects.toThrow("does not export the named repository witness");
      } finally {
        await harness.close();
      }
    });
  }

  test("rejects a singleton absent from the exact workset snapshot", async () => {
    const snapshot = snapshotFor([{ ref: "tasks:T1" }], {});
    await expect(
      produceCohortAdmissionObservationV1(
        { memberRefs: ["tasks:T1"] },
        {
          resolveExactSnapshot: async () => ({
            ...snapshot,
            workset: { ...snapshot.workset, orderedMemberRefs: [] },
          }),
        },
      ),
    ).rejects.toThrow("every cohort member must belong to the exact workset snapshot");
  });

  test("rejects repository witness paths not derived through the bounded graph", async () => {
    const snapshot = snapshotFor([{ ref: "tasks:T1" }], {});
    const member = snapshot.members[0]!;
    const malformed = {
      ...snapshot,
      members: [
        {
          ...member,
          boundaryCandidates: [
            {
              ...member.boundaryCandidates[0]!,
              witness: {
                ...member.boundaryCandidates[0]!.witness,
                memberPath: ["src/tasks:T1.ts", "src/not-inspected.ts"],
              },
            },
          ],
        },
      ],
    };
    await expect(
      produceCohortAdmissionObservationV1(
        { memberRefs: ["tasks:T1"] },
        { resolveExactSnapshot: async () => malformed as typeof snapshot },
      ),
    ).rejects.toThrow("does not end at its source node");
  });

  test("rejects a repository witness exported only inside a comment", async () => {
    const harness = await gitRepositoryHarness(
      undefined,
      new Map([
        [
          "src/contracts/shared.ts",
          "// export interface CohortContract { readonly version: 1 }\nexport const actual = true;\n",
        ],
      ]),
    );
    try {
      const local = localDefinition();
      const source = new LocalCohortAdmissionObservationSourceV1({
        repository: harness.repository,
        definitionPath: LOCAL_DEFINITION_PATH,
        environment: { environmentDigest: local.environmentDigest },
      });

      await expect(
        produceCohortAdmissionObservationV1(
          { memberRefs: ["tasks:T1", "tasks:T2"] },
          source,
        ),
      ).rejects.toThrow("does not export the named repository witness");
    } finally {
      await harness.close();
    }
  });

  test("rejects implementation authority fabricated in the cohort definition", async () => {
    const local = localDefinition();
    const fabricated = {
      ...local.definition,
      members: local.definition.members.map((member) => ({
        ...member,
        authorityRef: "authority:fabricated",
        authorityRevision: "authority-revision:fabricated",
        authorityBoundaryDigest: sha256("authority:fabricated"),
        ...(member.phase === "implementation"
          ? { implementationAuthority: "implementation-authority:fabricated" }
          : {}),
      })),
    };
    const files = new Map(localRepositoryFiles());
    files.set(LOCAL_DEFINITION_PATH, JSON.stringify(fabricated));
    const source = new LocalCohortAdmissionObservationSourceV1({
      repository: new InMemoryCohortLocalRepository(files),
      definitionPath: LOCAL_DEFINITION_PATH,
      environment: { environmentDigest: local.environmentDigest },
    });

    await expect(
      produceCohortAdmissionObservationV1(
        { memberRefs: ["tasks:T1", "tasks:T2"] },
        source,
      ),
    ).rejects.toThrow("implementation authority is not derived from trusted CQ state");
  });

  test("resolves a TypeScript source behind a JavaScript import specifier", async () => {
    const harness = await gitRepositoryHarness(
      undefined,
      new Map([
        [
          "src/tasks:T1.ts",
          'import type { CohortContract } from "./contracts/shared.js";\nexport const taskOne: CohortContract = { version: 1 };\n',
        ],
      ]),
    );
    try {
      const repositoryIdentity = await harness.repository.resolveIdentity();
      expect(
        await harness.repository.resolveRelationship(
          repositoryIdentity,
          "src/tasks:T1.ts",
          "src/contracts/shared.ts",
        ),
      ).toBe("import");
    } finally {
      await harness.close();
    }
  });
});
