import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "bun:test";

import {
  GitCohortLocalRepositoryV1,
  LedgerWorksetCohortAdmissionObservationSourceV1,
  cohortObservationInvalidationsV1,
  constructCohortDecisionsV1,
  produceCohortAdmissionObservationV1,
  type CohortAdmissionPlanV1,
  type CohortLocalRepositoryV1,
  type CohortPrimaryLedgerReaderV1,
  type CohortRepositoryIdentityV1,
  type CohortSourceRelationshipV1,
} from "../src/workCohort.js";
import {
  DEFECTS_SCHEMA,
  GOALS_SCHEMA,
  HYPOTHESIS_SCHEMA,
  REVIEWS_SCHEMA,
  TASKS_SCHEMA,
} from "../src/constants.js";
import { PLAN_FINALIZED_MANIFEST_FIELD } from "../src/planLifecycle.js";
import type { FetchedLedger, Item } from "../src/types.js";
import { commit, observationFor, sha256, snapshotFor } from "./workCohortFixture.js";

const execFileAsync = promisify(execFile);

interface LocalPrimaryFixture {
  readonly ledger: CohortPrimaryLedgerReaderV1;
  readonly workset: { snapshot(): { readonly roots: readonly string[]; readonly epoch: number } };
  readonly plan: CohortAdmissionPlanV1;
  readonly environmentDigest: string;
}

function primaryItem(id: string, status: string, fields: Item["fields"]): Item {
  return {
    id,
    milestoneId: "M1",
    status,
    fields,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    author: "trusted-test-producer",
    session: "trusted-test-session",
  };
}

function fetchedLedger(id: string, schema: FetchedLedger["schema"], items: readonly Item[]): FetchedLedger {
  return {
    id,
    schema,
    counters: { milestone: 2, item: items.length + 1 },
    milestones: [
      {
        id: "M1",
        milestone: { id: "M1", status: "open", title: "fixture", description: "" },
        items: [...items],
      },
    ],
    archivePointers: [],
  };
}

class InMemoryCohortPrimaryLedger implements CohortPrimaryLedgerReaderV1 {
  readonly #ledgers: ReadonlyMap<string, FetchedLedger>;

  constructor(ledgers: readonly FetchedLedger[]) {
    this.#ledgers = new Map(ledgers.map((ledger) => [ledger.id, ledger]));
  }

  enumerate(): string[] {
    return [...this.#ledgers.keys()];
  }

  fetch(ledgerId: string): FetchedLedger {
    const ledger = this.#ledgers.get(ledgerId);
    if (ledger === undefined) throw new Error(`missing fixture ledger ${ledgerId}`);
    return ledger;
  }

  async fetchArchive(): Promise<never> {
    throw new Error("fixture has no archives");
  }
}

function localPrimaryFixture(
  nodeIdentity = "shared#CohortContract",
  primaryReferenceChain = false,
): LocalPrimaryFixture {
  const snapshot = snapshotFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }], {});
  const manifest = {
    revision: 1,
    milestones: [],
    tasks: [
      { key: "one", id: "T1" },
      { key: "two", id: "T2" },
    ],
  };
  const goal = primaryItem("G1", "planned", {
    headline: "Cohort goal",
    [PLAN_FINALIZED_MANIFEST_FIELD]: JSON.stringify(manifest),
  });
  const tasks = ["T1", "T2"].map((id) =>
    primaryItem(id, "planned", {
      headline: `Task ${id}`,
      sourceRefs: [
        `src/tasks:${id}.ts`,
        ...(primaryReferenceChain ? ["reviews:R1"] : []),
      ],
      worksetOwnerRef: "goals:G1",
      worksetOwnerEdgeKind: "finalized-manifest",
    }),
  );
  const review = primaryItem("R1", "go-ahead", {
    sourceRefs: [`cq-implementation-adoption:v1:${"a".repeat(64)}`],
    sessionLogs: [".cq/logs/review-R1.md"],
  });
  const members = snapshot.members.map((member) => ({
    memberRef: member.memberRef,
    boundaryCandidates: member.boundaryCandidates.map((candidate) => ({
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
  }));
  return {
    ledger: new InMemoryCohortPrimaryLedger([
      fetchedLedger("goals", GOALS_SCHEMA, [goal]),
      fetchedLedger("tasks", TASKS_SCHEMA, tasks),
      ...(primaryReferenceChain
        ? [fetchedLedger("reviews", REVIEWS_SCHEMA, [review])]
        : []),
    ]),
    workset: { snapshot: () => ({ roots: ["goals:G1"], epoch: 7 }) },
    plan: {
      kind: "cq-cohort-admission-plan",
      version: 1,
      members,
    },
    environmentDigest: snapshot.environment.environmentDigest,
  };
}

function localInvestigationFixture(causeConfirmed: boolean, splitOwner = false): LocalPrimaryFixture {
  const memberSpecs = ["D1", "D2"].map((id) => ({
    ref: `defects:${id}`,
    phase: "investigation" as const,
  }));
  const snapshot = snapshotFor(memberSpecs, {});
  const goals = [
    primaryItem("G1", "planned", { headline: "First investigation goal" }),
    ...(splitOwner
      ? [primaryItem("G2", "planned", { headline: "Second investigation goal" })]
      : []),
  ];
  const defects = ["D1", "D2"].map((id) =>
    primaryItem(id, causeConfirmed ? "root-caused" : "wip", {
      headline: `Defect ${id}`,
      severity: "high",
      rootCause: "shared primary cause",
      sourceRefs: [`src/defects:${id}.ts`],
      worksetOwnerRef: splitOwner && id === "D2" ? "goals:G2" : "goals:G1",
      worksetOwnerEdgeKind: "review-filed-defect",
    }),
  );
  const hypotheses = ["D1", "D2"].map((id, index) =>
    primaryItem(`H${String(index + 1)}`, causeConfirmed ? "confirmed" : "uncertain", {
      headline: `Hypothesis ${id}`,
      evidence: ["same bounded evidence class"],
      worksetOwnerRef: `defects:${id}`,
      worksetOwnerEdgeKind: "hypothesis",
    }),
  );
  const members = snapshot.members.map((member, index) => ({
    memberRef: member.memberRef,
    investigationHypothesisRef: `hypothesis:H${String(index + 1)}`,
    boundaryCandidates: member.boundaryCandidates.map((candidate) => ({
      ...candidate,
      focusedCommand: {
        ...candidate.focusedCommand,
        provenance: {
          ...candidate.focusedCommand.provenance,
          sourceRef: `src/${member.memberRef}.ts`,
        },
      },
    })),
  }));
  return {
    ledger: new InMemoryCohortPrimaryLedger([
      fetchedLedger("goals", GOALS_SCHEMA, goals),
      fetchedLedger("defects", DEFECTS_SCHEMA, defects),
      fetchedLedger("hypothesis", HYPOTHESIS_SCHEMA, hypotheses),
    ]),
    workset: {
      snapshot: () => ({
        roots: splitOwner ? ["goals:G1", "goals:G2"] : ["goals:G1"],
        epoch: 11,
      }),
    },
    plan: {
      kind: "cq-cohort-admission-plan",
      version: 1,
      members,
    },
    environmentDigest: snapshot.environment.environmentDigest,
  };
}

function localRepositoryFiles(_nodeIdentity?: string): ReadonlyMap<string, string> {
  return new Map([
    ["package.json", JSON.stringify({ name: "cohort-source" })],
    [
      "src/tasks:T1.ts",
      'import type { CohortContract } from "./contracts/shared";\nexport const taskOne: CohortContract = { version: 1 };\n',
    ],
    [
      "src/tasks:T2.ts",
      'import type { CohortContract } from "./contracts/shared";\nexport const taskTwo: CohortContract = { version: 1 };\n',
    ],
    [
      "src/defects:D1.ts",
      'import type { CohortContract } from "./contracts/shared";\nexport const defectOne: CohortContract = { version: 1 };\n',
    ],
    [
      "src/defects:D2.ts",
      'import type { CohortContract } from "./contracts/shared";\nexport const defectTwo: CohortContract = { version: 1 };\n',
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
    if (to === "package.json") return "package";
    if (from === "tests/cohort.test.ts" && to === "src/contracts/shared.ts") return "test";
    if (
      (from === "src/tasks:T1.ts" ||
        from === "src/tasks:T2.ts" ||
        from === "src/defects:D1.ts" ||
        from === "src/defects:D2.ts") &&
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
        const local = localPrimaryFixture();
        const source = new LedgerWorksetCohortAdmissionObservationSourceV1({
          repository: recording,
          ledger: local.ledger,
          workset: local.workset,
          plan: local.plan,
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
        expect(observation.producer).toBe("cq-primary-ledger-workset-cohort-producer");
        expect(observation.members.map(({ authorityRef }) => authorityRef)).toEqual([
          "goals:G1",
          "goals:G1",
        ]);
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
        const local = localPrimaryFixture("shared#MissingContract");
        const source = new LedgerWorksetCohortAdmissionObservationSourceV1({
          repository: harness.repository,
          ledger: local.ledger,
          workset: local.workset,
          plan: local.plan,
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
      const local = localPrimaryFixture();
      const source = new LedgerWorksetCohortAdmissionObservationSourceV1({
        repository: harness.repository,
        ledger: local.ledger,
        workset: local.workset,
        plan: local.plan,
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

  test("does not accept implementation authority fabricated outside primary CQ state", async () => {
    const local = localPrimaryFixture();
    const fabricatedPlan = {
      ...local.plan,
      members: local.plan.members.map((member) => ({
        ...member,
        authorityRef: "authority:fabricated",
        authorityRevision: "authority-revision:fabricated",
        authorityBoundaryDigest: sha256("authority:fabricated"),
        implementationAuthority: "implementation-authority:fabricated",
      })),
    };
    const source = new LedgerWorksetCohortAdmissionObservationSourceV1({
      repository: new InMemoryCohortLocalRepository(localRepositoryFiles()),
      ledger: local.ledger,
      workset: local.workset,
      plan: fabricatedPlan,
      environment: { environmentDigest: local.environmentDigest },
    });

    const observation = await produceCohortAdmissionObservationV1(
      { memberRefs: ["tasks:T1", "tasks:T2"] },
      source,
    );

    expect(observation.members.map(({ authorityRef }) => authorityRef)).toEqual([
      "goals:G1",
      "goals:G1",
    ]);
    expect(
      observation.members.map((member) =>
        member.phase === "implementation" ? member.implementationAuthority : null,
      ),
    ).toEqual(["cq-finalized-manifest:goals:G1", "cq-finalized-manifest:goals:G1"]);
  });

  test("resolves primary ledger, opaque authority, and log references without treating them as Git paths", async () => {
    const local = localPrimaryFixture("shared#CohortContract", true);
    const recording = new RecordingCohortLocalRepository(
      new InMemoryCohortLocalRepository(localRepositoryFiles()),
    );
    const source = new LedgerWorksetCohortAdmissionObservationSourceV1({
      repository: recording,
      ledger: local.ledger,
      workset: local.workset,
      plan: local.plan,
      environment: { environmentDigest: local.environmentDigest },
    });

    const observation = await produceCohortAdmissionObservationV1(
      { memberRefs: ["tasks:T1", "tasks:T2"] },
      source,
    );
    const first = observation.members[0] as (typeof observation.members)[number] & {
      readonly sourceReferences: readonly {
        readonly kind: string;
        readonly ref: string;
      }[];
    };

    expect(first.sourceRefs).toEqual(["src/tasks:T1.ts"]);
    expect(first.sourceReferences.map(({ kind, ref }) => ({ kind, ref }))).toEqual([
      { kind: "opaque-authority", ref: `cq-implementation-adoption:v1:${"a".repeat(64)}` },
      { kind: "primary-ledger", ref: "reviews:R1" },
      { kind: "primary-log", ref: ".cq/logs/review-R1.md" },
      { kind: "repository-path", ref: "src/tasks:T1.ts" },
    ]);
    expect(recording.reads).not.toContain("reviews:R1");
    expect(recording.reads).not.toContain(".cq/logs/review-R1.md");
  });

  test.each([
    ["confirmed", true],
    ["unconfirmed", false],
  ] as const)("fuses primary-backed %s investigations through an independent repository witness", async (_label, causeConfirmed) => {
    const local = localInvestigationFixture(causeConfirmed);
    const source = new LedgerWorksetCohortAdmissionObservationSourceV1({
      repository: new InMemoryCohortLocalRepository(localRepositoryFiles()),
      ledger: local.ledger,
      workset: local.workset,
      plan: local.plan,
      environment: { environmentDigest: local.environmentDigest },
    });

    const observation = await produceCohortAdmissionObservationV1(
      { memberRefs: ["defects:D1", "defects:D2"] },
      source,
    );
    const [decision] = constructCohortDecisionsV1(observation);

    expect(decision?.includedMemberRefs).toEqual(["defects:D1", "defects:D2"]);
    expect(new Set(observation.members.map(({ ownershipBoundaryDigest }) => ownershipBoundaryDigest)).size).toBe(1);
    expect(new Set(observation.members.map(({ authorityBoundaryDigest }) => authorityBoundaryDigest)).size).toBe(1);
    if (!causeConfirmed) {
      expect(observation.members.every(({ unavailableFacts }) => unavailableFacts.some(({ fact }) => fact === "confirmed-cause"))).toBe(true);
      expect(observation.members.flatMap(({ attestations }) => attestations).every(({ applicability }) => applicability.kind === "repository-path")).toBe(true);
    }
  });

  test("keeps distinct primary investigation owners outside one cohort", async () => {
    const local = localInvestigationFixture(true, true);
    const source = new LedgerWorksetCohortAdmissionObservationSourceV1({
      repository: new InMemoryCohortLocalRepository(localRepositoryFiles()),
      ledger: local.ledger,
      workset: local.workset,
      plan: local.plan,
      environment: { environmentDigest: local.environmentDigest },
    });

    const observation = await produceCohortAdmissionObservationV1(
      { memberRefs: ["defects:D1", "defects:D2"] },
      source,
    );

    expect(constructCohortDecisionsV1(observation)[0]?.excluded[0]?.reason).toBe(
      "ownership-or-manifest",
    );
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

  test("resolves a TypeScript source through a workspace package export", async () => {
    const harness = await gitRepositoryHarness(
      undefined,
      new Map([
        [
          "package.json",
          JSON.stringify({
            name: "cohort-source",
            exports: { "./contracts": "./src/contracts/shared.js" },
          }),
        ],
        [
          "src/tasks:T1.ts",
          'import type { CohortContract } from "cohort-source/contracts";\nexport const taskOne: CohortContract = { version: 1 };\n',
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
