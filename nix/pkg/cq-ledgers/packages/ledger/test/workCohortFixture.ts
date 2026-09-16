import { createHash } from "node:crypto";

import type { ImplementationQueueControl } from "@cq/config";

import {
  produceCohortAdmissionObservationV1,
  type CohortAdmissionObservationV1,
  type CohortAdmissionSnapshotV1,
  type CohortBoundaryCandidateInputV1,
  type CohortBoundaryIdentityV1,
  type CohortGitChangeReceiptV1,
  type CohortPhaseV1,
  type CohortRepositoryIdentityV1,
  type ResolvedCohortMemberV1,
} from "../src/workCohort.js";

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function commit(label: string): string {
  return sha256(label).slice(0, 40);
}

export function boundary(label: string): CohortBoundaryIdentityV1 {
  return Object.freeze({ identity: label, digest: sha256(label) });
}

export interface AtomSpec {
  readonly witness?: string;
  readonly witnessPath?: string;
  readonly cause?: string;
  readonly regression?: string;
  readonly gate?: string;
  readonly reviewer?: string;
  readonly deployment?: string;
  readonly finalization?: string;
  readonly split?: readonly string[];
  readonly command?: string;
}

export interface MemberSpec {
  readonly ref: string;
  readonly phase?: CohortPhaseV1;
  readonly revision?: string;
  readonly owner?: string;
  readonly authority?: string;
  readonly dependencies?: readonly string[];
  readonly unavailable?: boolean;
  readonly atoms?: readonly AtomSpec[];
}

export interface ObservationOptions {
  readonly membersOrder?: readonly string[];
  readonly sourceOrder?: readonly string[];
  readonly repository?: CohortRepositoryIdentityV1;
  readonly environment?: string;
  readonly worksetRevision?: string;
  readonly manifestRevision?: string;
  readonly producerRevision?: string;
  readonly sourceSalt?: string;
  readonly benefits?: boolean;
}

function atomCandidate(
  member: MemberSpec,
  sourceRef: string,
  atom: AtomSpec,
): CohortBoundaryCandidateInputV1 {
  const witness = atom.witness ?? "shared";
  const witnessPath = atom.witnessPath ?? witness;
  const command = atom.command ?? member.ref;
  return Object.freeze({
    witness:
      atom.cause === undefined
        ? Object.freeze({
            kind: "repository-node" as const,
            nodeKind: "versioned-contract" as const,
            nodeIdentity: `${witness}#CohortContract`,
            sourcePath: `src/contracts/${witnessPath}.ts`,
            memberPath: Object.freeze([sourceRef, `src/contracts/${witnessPath}.ts`]),
          })
        : Object.freeze({
            kind: "confirmed-cause" as const,
            causeDigest: sha256(`cause:${atom.cause}`),
            receiptDigest: sha256(`receipt:${atom.cause}`),
          }),
    sharedRegression: boundary(`regression:${atom.regression ?? "shared"}`),
    canonicalFullGate: boundary(`gate:${atom.gate ?? "canonical"}`),
    reviewerClass: boundary(`reviewer:${atom.reviewer ?? "standard"}`),
    deploymentClass: boundary(`deployment:${atom.deployment ?? "standard"}`),
    finalizationClass: boundary(`finalization:${atom.finalization ?? "standard"}`),
    splitConditions: Object.freeze([...(atom.split ?? [])]),
    focusedCommand: Object.freeze({
      argv: Object.freeze(["bun", "test", `packages/ledger/test/${command}.test.ts`]),
      cwd: "nix/pkg/cq-ledgers",
      environment: Object.freeze({}),
      provenance: Object.freeze({
        sourceRef: member.ref,
        sourceRevision: member.revision ?? `revision:${member.ref}`,
      }),
    }),
  });
}

export function snapshotFor(
  specs: readonly MemberSpec[],
  options: ObservationOptions,
): CohortAdmissionSnapshotV1 {
  const repository =
    options.repository ??
    Object.freeze({
      repositoryId: "repository:test",
      headCommit: commit("head"),
      treeOid: commit("tree"),
    });
  const sourceNodes = new Map<
    string,
    { path: string; blobDigest: string; referencedBy: string[] }
  >();
  const edges: { from: string; to: string; relationship: "import" }[] = [];
  const edgeKeys = new Set<string>();
  const membersByRef = new Map<string, ResolvedCohortMemberV1>();
  for (const spec of specs) {
    const phase = spec.phase ?? "implementation";
    const revision = spec.revision ?? `revision:${spec.ref}`;
    const sourceRef = `src/${spec.ref}.ts`;
    sourceNodes.set(sourceRef, {
      path: sourceRef,
      blobDigest: sha256(`blob:${sourceRef}:${options.sourceSalt ?? "base"}`),
      referencedBy: [spec.ref],
    });
    const atomSpecs: readonly AtomSpec[] = spec.atoms ?? [Object.freeze({})];
    for (const atom of atomSpecs) {
      if (atom.cause !== undefined) continue;
      const witnessPath = `src/contracts/${atom.witnessPath ?? atom.witness ?? "shared"}.ts`;
      const node = sourceNodes.get(witnessPath) ?? {
        path: witnessPath,
        blobDigest: sha256(`blob:${witnessPath}:${options.sourceSalt ?? "base"}`),
        referencedBy: [],
      };
      node.referencedBy.push(spec.ref);
      sourceNodes.set(witnessPath, node);
      const edgeKey = `${sourceRef}\u0000${witnessPath}`;
      if (!edgeKeys.has(edgeKey)) {
        edges.push({ from: sourceRef, to: witnessPath, relationship: "import" });
        edgeKeys.add(edgeKey);
      }
    }
    const common = {
      memberRef: spec.ref,
      memberRevision: revision,
      phase,
      ownershipBoundaryDigest: sha256(`owner:${spec.owner ?? "shared"}`),
      authorityRef: `authority:${spec.ref}`,
      authorityRevision: `authority-revision:${spec.ref}:${spec.authority ?? "shared"}`,
      authorityBoundaryDigest: sha256(`authority:${spec.authority ?? "shared"}`),
      dependencyClosure: Object.freeze([...(spec.dependencies ?? [])]),
      sourceRefs: Object.freeze([sourceRef]),
      sourceReferences: Object.freeze([
        Object.freeze({ kind: "repository-path" as const, ref: sourceRef }),
      ]),
      repository,
      environment: Object.freeze({
        environmentDigest: sha256(`environment:${options.environment ?? "test"}`),
      }),
      boundaryCandidates: Object.freeze(
        atomSpecs.map((atom) => atomCandidate(spec, sourceRef, atom)),
      ),
      unavailableFacts: Object.freeze(
        spec.unavailable
          ? [{ memberRef: spec.ref, fact: "source", reason: "unavailable in snapshot" }]
          : [],
      ),
    };
    const causeReceipts = atomSpecs.flatMap((atom) =>
      atom.cause === undefined ? [] : [sha256(`receipt:${atom.cause}`)],
    );
    const member: ResolvedCohortMemberV1 =
      phase === "investigation"
        ? Object.freeze({
            ...common,
            phase,
            defectRef: `defects:${spec.ref}`,
            defectRevision: `defect-revision:${spec.ref}`,
            hypothesisRef: `hypotheses:${spec.ref}`,
            hypothesisRevision: `hypothesis-revision:${spec.ref}`,
            hypothesisState: "confirmed",
            causeState: causeReceipts.length > 0 ? "confirmed" : "unconfirmed",
            confirmedCauseReceiptDigests: Object.freeze(causeReceipts),
            investigationAuthority: `investigation-authority:${spec.ref}`,
          })
        : Object.freeze({
            ...common,
            phase,
            taskRevision: revision,
            goalRef: "goals:G-test",
            finalizedManifestRevision: options.manifestRevision ?? "manifest:1",
            implementationAuthority: `implementation-authority:${spec.ref}`,
          });
    membersByRef.set(spec.ref, member);
  }
  const membersOrder = options.membersOrder ?? specs.map((spec) => spec.ref);
  const sourceOrder = options.sourceOrder ?? membersOrder;
  const members = sourceOrder.map((ref) => {
    const member = membersByRef.get(ref);
    if (member === undefined) throw new Error(`missing fixture member ${ref}`);
    return member;
  });
  const implementationRefs = specs
    .filter((spec) => (spec.phase ?? "implementation") === "implementation")
    .map((spec) => spec.ref);
  const gateDigest = boundary("gate:canonical").digest;
  return Object.freeze({
    producer: "trusted-local-cohort-producer",
    producerRevision: options.producerRevision ?? "producer:1",
    workset: Object.freeze({
      worksetRef: "worksets:test",
      worksetRevision: options.worksetRevision ?? "workset:1",
      orderedMemberRefs: Object.freeze([...membersOrder]),
    }),
    manifest: Object.freeze({
      manifestRef: "manifests:test",
      manifestRevision: options.manifestRevision ?? "manifest:1",
      memberRefs: Object.freeze(implementationRefs),
    }),
    repository,
    environment: Object.freeze({
      environmentDigest: sha256(`environment:${options.environment ?? "test"}`),
    }),
    sourceGraph: Object.freeze({
      nodes: Object.freeze([...sourceNodes.values()].map((node) => Object.freeze(node))),
      edges: Object.freeze(edges.map((edge) => Object.freeze(edge))),
    }),
    members: Object.freeze(members),
    authenticatedBenefitReceipts: Object.freeze(
      options.benefits
        ? [
            Object.freeze({
              receiptDigest: sha256("benefit"),
              boundaryDigest: gateDigest,
              durationMs: 123,
              outcome: "passed",
            }),
          ]
        : [],
    ),
    unavailableFacts: Object.freeze([]),
  });
}

export async function observationFor(
  specs: readonly MemberSpec[],
  options: ObservationOptions = {},
): Promise<CohortAdmissionObservationV1> {
  const snapshot = snapshotFor(specs, options);
  return await produceCohortAdmissionObservationV1(
    { memberRefs: specs.map((spec) => spec.ref) },
    { resolveExactSnapshot: async () => snapshot },
  );
}

export function receipt(input: {
  readonly base: string;
  readonly result: string;
  readonly tree: string;
  readonly operation?: string;
}): CohortGitChangeReceiptV1 {
  return Object.freeze({
    kind: "cq-git-change-receipt",
    version: 1,
    attestationId: "att-test",
    generation: 1,
    taskId: "T-test",
    operationId: input.operation ?? "candidate",
    requestDigest: sha256(input.operation ?? "candidate"),
    oldHead: input.base,
    newHead: input.result,
    tree: input.tree,
    objectOids: Object.freeze([input.tree]),
    paths: Object.freeze(["src/result.ts"]),
    committedAt: "2026-09-16T00:00:00Z",
  });
}

export function qualifiedQueue(input: {
  readonly taskId: string;
  readonly base: string;
  readonly result: string;
  readonly tree: string;
  readonly receipts: readonly CohortGitChangeReceiptV1[];
  readonly attempt?: string;
  readonly managedWorktreeBindingDigest?: string;
}): ImplementationQueueControl {
  return {
    kind: "cq-implementation-queue-control",
    version: 1,
    partition: {
      kind: "cq-implementation-queue-partition",
      version: 1,
      partitionKey: "partition:test",
      projectKey: "project:test",
      repositoryId: "repository:test",
      integrationRef: "refs/heads/main",
    },
    enrollment: {
      kind: "cq-implementation-queue-enrollment",
      version: 1,
      enrollmentId: "enrollment:test",
      partitionKey: "partition:test",
      admissionOrdinal: 1,
      taskId: input.taskId,
      goalRef: "goals:G-test",
      finalizedManifestDigest: sha256("manifest"),
    },
    attempt: {
      kind: "cq-implementation-queue-attempt",
      version: 1,
      attemptId: input.attempt ?? "attempt:test",
      observedBaseCommit: input.base,
      resultCommit: input.result,
      resultTree: input.tree,
      gateCommand:
        'cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check',
      packagedEnvironmentDigest: sha256("environment"),
      taskId: input.taskId,
      goalRef: "goals:G-test",
      finalizedManifestDigest: sha256("manifest"),
      managedWorktreeBindingDigest: input.managedWorktreeBindingDigest ?? sha256("worktree"),
      gitReceiptLineageDigest: sha256(input.receipts),
      gitReceipts: input.receipts,
      worktreePath: "/repo/.claude/worktrees/test",
      repositoryId: "repository:test",
    },
    state: "qualified",
    partitionRevision: 1,
    leaseGeneration: 0,
    qualification: {
      kind: "cq-staged-completion-qualification",
      version: 1,
      qualificationDigest: sha256("qualification"),
      qualifiedAt: "2026-09-16T00:00:01Z",
      partitionKey: "partition:test",
      enrollmentId: "enrollment:test",
      attemptId: input.attempt ?? "attempt:test",
      outputDigest: sha256("output"),
      expectedChild: { childId: "child", runId: "run" },
      expectedProvenance: {
        roleId: "implement-worker",
        version: 10,
        promptDigest: sha256("prompt"),
        inputDigest: sha256("input"),
      },
      nativeCompletion: {
        kind: "native-completion",
        actor: "trusted-parent",
        childId: "child",
        runId: "run",
        completedAt: "2026-09-16T00:00:01Z",
      },
    },
  };
}
