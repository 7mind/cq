import { createHash } from "node:crypto";

import type { ImplementationQueueControl } from "@cq/config";

export const COHORT_PHASE_ORDER_V1 = ["investigation", "implementation"] as const;

export type CohortPhaseV1 = (typeof COHORT_PHASE_ORDER_V1)[number];

export const COHORT_EXCLUSION_PRIORITY_V1 = [
  "stale-binding",
  "phase-mismatch",
  "ownership-or-manifest",
  "dependency",
  "authority",
  "repository-or-environment",
  "cohort-witness-empty",
  "validation-boundary-empty",
  "reviewer-boundary-empty",
  "deployment-boundary-empty",
  "finalization-boundary-empty",
  "eligibility-tuple-empty",
] as const;

export type CohortExclusionReasonV1 = (typeof COHORT_EXCLUSION_PRIORITY_V1)[number];

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cohort identity contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const member = record[key];
        if (member === undefined) throw new Error(`cohort identity field ${key} is undefined`);
        return `${JSON.stringify(key)}:${canonical(member)}`;
      })
      .join(",")}}`;
  }
  throw new Error("cohort identity contains a non-JSON value");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} must be non-empty`);
}

function assertDigest(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256 digest`);
}

function assertCommit(value: string, label: string): void {
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be one full lowercase commit SHA`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => right.has(value)));
}

function normalizedRepositoryPath(value: string, label: string): string {
  assertNonEmpty(value, label);
  if (value.startsWith("/") || value.split("/").some((part) => part === "" || part === "..")) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return value.startsWith("./") ? value.slice(2) : value;
}

export interface CohortRepositoryIdentityV1 {
  readonly repositoryId: string;
  readonly headCommit: string;
  readonly treeOid: string;
}

export interface CohortEnvironmentIdentityV1 {
  readonly environmentDigest: string;
}

export interface CohortWorksetSnapshotV1 {
  readonly worksetRef: string;
  readonly worksetRevision: string;
  readonly orderedMemberRefs: readonly string[];
}

export interface CohortManifestSnapshotV1 {
  readonly manifestRef: string;
  readonly manifestRevision: string;
  readonly memberRefs: readonly string[];
}

export interface CohortUnavailableFactV1 {
  readonly memberRef: string | null;
  readonly fact: string;
  readonly reason: string;
}

export type CohortSourceRelationshipV1 = "package" | "import" | "test";

export interface CohortSourceGraphNodeV1 {
  readonly path: string;
  readonly blobDigest: string;
  readonly referencedBy: readonly string[];
}

export interface CohortSourceGraphEdgeV1 {
  readonly from: string;
  readonly to: string;
  readonly relationship: CohortSourceRelationshipV1;
}

export interface CohortSourceGraphV1 {
  readonly nodes: readonly CohortSourceGraphNodeV1[];
  readonly edges: readonly CohortSourceGraphEdgeV1[];
}

export type CohortWitnessInputV1 =
  | {
      readonly kind: "confirmed-cause";
      readonly causeDigest: string;
      readonly receiptDigest: string;
    }
  | {
      readonly kind: "repository-node";
      readonly nodeKind: "production-symbol" | "versioned-contract" | "generated-source";
      readonly nodeIdentity: string;
      readonly sourcePath: string;
      readonly memberPath: readonly string[];
    };

export interface CohortBoundaryIdentityV1 {
  readonly identity: string;
  readonly digest: string;
}

export interface CohortFocusedCommandInputV1 {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly provenance: {
    readonly sourceRef: string;
    readonly sourceRevision: string;
  };
}

export interface CohortBoundaryCandidateInputV1 {
  readonly witness: CohortWitnessInputV1;
  readonly sharedRegression: CohortBoundaryIdentityV1;
  readonly canonicalFullGate: CohortBoundaryIdentityV1;
  readonly reviewerClass: CohortBoundaryIdentityV1;
  readonly deploymentClass: CohortBoundaryIdentityV1;
  readonly finalizationClass: CohortBoundaryIdentityV1;
  readonly splitConditions: readonly string[];
  readonly focusedCommand: CohortFocusedCommandInputV1;
}

interface ResolvedCohortMemberBaseV1 {
  readonly memberRef: string;
  readonly memberRevision: string;
  readonly phase: CohortPhaseV1;
  readonly ownershipBoundaryDigest: string;
  readonly authorityRef: string;
  readonly authorityRevision: string;
  readonly authorityBoundaryDigest: string;
  readonly dependencyClosure: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly boundaryCandidates: readonly CohortBoundaryCandidateInputV1[];
  readonly unavailableFacts: readonly CohortUnavailableFactV1[];
}

export interface ResolvedInvestigationCohortMemberV1 extends ResolvedCohortMemberBaseV1 {
  readonly phase: "investigation";
  readonly defectRef: string;
  readonly defectRevision: string;
  readonly hypothesisRef: string;
  readonly hypothesisRevision: string;
  readonly hypothesisState: string;
  readonly causeState: "confirmed" | "unconfirmed" | "unavailable";
  readonly confirmedCauseReceiptDigests: readonly string[];
  readonly investigationAuthority: string;
}

export interface ResolvedImplementationCohortMemberV1 extends ResolvedCohortMemberBaseV1 {
  readonly phase: "implementation";
  readonly taskRevision: string;
  readonly goalRef: string;
  readonly finalizedManifestRevision: string;
  readonly implementationAuthority: string;
}

export type ResolvedCohortMemberV1 =
  | ResolvedInvestigationCohortMemberV1
  | ResolvedImplementationCohortMemberV1;

export interface CohortAuthenticatedBenefitReceiptV1 {
  readonly receiptDigest: string;
  readonly boundaryDigest: string;
  readonly durationMs: number | null;
  readonly outcome: string;
}

export interface CohortAdmissionSnapshotV1 {
  readonly producer: string;
  readonly producerRevision: string;
  readonly workset: CohortWorksetSnapshotV1;
  readonly manifest: CohortManifestSnapshotV1 | null;
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly sourceGraph: CohortSourceGraphV1;
  readonly members: readonly ResolvedCohortMemberV1[];
  readonly authenticatedBenefitReceipts: readonly CohortAuthenticatedBenefitReceiptV1[];
  readonly unavailableFacts: readonly CohortUnavailableFactV1[];
}

export interface CohortAdmissionObservationRequestV1 {
  readonly memberRefs: readonly string[];
}

export interface CohortAdmissionObservationSourceV1 {
  resolveExactSnapshot(
    request: CohortAdmissionObservationRequestV1,
  ): Promise<CohortAdmissionSnapshotV1>;
}

export interface MemberAcceptancePlanV1 {
  readonly kind: "cq-cohort-member-acceptance-plan";
  readonly version: 1;
  readonly memberRef: string;
  readonly memberRevision: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: readonly { readonly name: string; readonly value: string }[];
  readonly provenance: {
    readonly sourceRef: string;
    readonly sourceRevision: string;
  };
  readonly normalizedCommandDigest: string;
  readonly planDigest: string;
}

export interface CohortCommonBoundaryAtomV1 {
  readonly kind: "cq-cohort-common-boundary-atom";
  readonly version: 1;
  readonly phase: CohortPhaseV1;
  readonly witness: {
    readonly kind: "confirmed-cause" | "repository-node";
    readonly witnessDigest: string;
  };
  readonly sharedRegression: CohortBoundaryIdentityV1;
  readonly canonicalFullGate: CohortBoundaryIdentityV1;
  readonly reviewerClass: CohortBoundaryIdentityV1;
  readonly deploymentClass: CohortBoundaryIdentityV1;
  readonly finalizationClass: CohortBoundaryIdentityV1;
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly splitConditions: readonly string[];
  readonly atomDigest: string;
}

export interface MemberCommonBoundaryAttestationV1 {
  readonly kind: "cq-member-common-boundary-attestation";
  readonly version: 1;
  readonly atomDigest: string;
  readonly memberRef: string;
  readonly memberRevision: string;
  readonly applicability:
    | {
        readonly kind: "confirmed-cause";
        readonly receiptDigest: string;
        readonly causeDigest: string;
      }
    | {
        readonly kind: "repository-path";
        readonly nodeIdentity: string;
        readonly memberPath: readonly string[];
      };
  readonly acceptancePlan: MemberAcceptancePlanV1;
  readonly attestationDigest: string;
}

interface CohortMemberObservationBaseV1 {
  readonly memberRef: string;
  readonly memberRevision: string;
  readonly phase: CohortPhaseV1;
  readonly worksetOrder: number;
  readonly ownershipBoundaryDigest: string;
  readonly authorityRef: string;
  readonly authorityRevision: string;
  readonly authorityBoundaryDigest: string;
  readonly dependencyClosure: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly attestations: readonly MemberCommonBoundaryAttestationV1[];
  readonly unavailableFacts: readonly CohortUnavailableFactV1[];
  readonly memberBindingDigest: string;
}

export interface InvestigationCohortMemberObservationV1 extends CohortMemberObservationBaseV1 {
  readonly phase: "investigation";
  readonly defectRef: string;
  readonly defectRevision: string;
  readonly hypothesisRef: string;
  readonly hypothesisRevision: string;
  readonly hypothesisState: string;
  readonly causeState: "confirmed" | "unconfirmed" | "unavailable";
  readonly confirmedCauseReceiptDigests: readonly string[];
  readonly investigationAuthority: string;
}

export interface ImplementationCohortMemberObservationV1 extends CohortMemberObservationBaseV1 {
  readonly phase: "implementation";
  readonly taskRevision: string;
  readonly goalRef: string;
  readonly finalizedManifestRevision: string;
  readonly implementationAuthority: string;
}

export type CohortMemberObservationV1 =
  | InvestigationCohortMemberObservationV1
  | ImplementationCohortMemberObservationV1;

export interface CohortAdmissionObservationV1 {
  readonly kind: "cq-cohort-admission-observation";
  readonly version: 1;
  readonly producer: string;
  readonly producerRevision: string;
  readonly inputDigest: string;
  readonly observationSetDigest: string;
  readonly workset: CohortWorksetSnapshotV1;
  readonly manifest: CohortManifestSnapshotV1 | null;
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly sourceGraphDigest: string;
  readonly atoms: readonly CohortCommonBoundaryAtomV1[];
  readonly members: readonly CohortMemberObservationV1[];
  readonly authenticatedBenefitReceipts: readonly CohortAuthenticatedBenefitReceiptV1[];
  readonly unavailableFacts: readonly CohortUnavailableFactV1[];
  readonly observationDigest: string;
}

function assertBoundaryIdentity(boundary: CohortBoundaryIdentityV1, label: string): void {
  assertNonEmpty(boundary.identity, `${label} identity`);
  assertDigest(boundary.digest, `${label} digest`);
}

function assertRepositoryIdentity(repository: CohortRepositoryIdentityV1): void {
  assertNonEmpty(repository.repositoryId, "repository id");
  assertCommit(repository.headCommit, "repository HEAD");
  if (!/^[0-9a-f]{40,64}$/u.test(repository.treeOid)) {
    throw new Error("repository tree identity must be a lowercase object id");
  }
}

function makeAcceptancePlan(
  member: ResolvedCohortMemberV1,
  command: CohortFocusedCommandInputV1,
): MemberAcceptancePlanV1 {
  if (command.argv.length === 0 || command.argv.some((argument) => argument === "")) {
    throw new Error(`${member.memberRef} focused argv must be non-empty`);
  }
  const cwd = normalizedRepositoryPath(command.cwd, `${member.memberRef} focused cwd`);
  assertNonEmpty(command.provenance.sourceRef, `${member.memberRef} command provenance source`);
  assertNonEmpty(command.provenance.sourceRevision, `${member.memberRef} command provenance revision`);
  const environment = Object.freeze(
    Object.entries(command.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => Object.freeze({ name, value })),
  );
  const normalized = {
    argv: [...command.argv],
    cwd,
    environment,
    provenance: command.provenance,
  };
  const normalizedCommandDigest = digest(normalized);
  const payload = {
    kind: "cq-cohort-member-acceptance-plan" as const,
    version: 1 as const,
    memberRef: member.memberRef,
    memberRevision: member.memberRevision,
    ...normalized,
    normalizedCommandDigest,
  };
  return Object.freeze({ ...payload, planDigest: digest(payload) });
}

function validateSourceGraph(graph: CohortSourceGraphV1): {
  readonly nodeByPath: ReadonlyMap<string, CohortSourceGraphNodeV1>;
  readonly edgeKeys: ReadonlySet<string>;
  readonly digest: string;
} {
  const nodeByPath = new Map<string, CohortSourceGraphNodeV1>();
  for (const raw of graph.nodes) {
    const path = normalizedRepositoryPath(raw.path, "source graph node path");
    if (nodeByPath.has(path)) throw new Error(`source graph repeats ${path}`);
    assertDigest(raw.blobDigest, `${path} blob digest`);
    const referencedBy = sortedUnique(raw.referencedBy);
    nodeByPath.set(path, Object.freeze({ ...raw, path, referencedBy }));
  }
  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    const from = normalizedRepositoryPath(edge.from, "source graph edge source");
    const to = normalizedRepositoryPath(edge.to, "source graph edge target");
    if (!nodeByPath.has(from) || !nodeByPath.has(to)) {
      throw new Error(`source graph edge ${from} -> ${to} escapes the observed graph`);
    }
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) throw new Error(`source graph repeats edge ${from} -> ${to}`);
    edgeKeys.add(key);
  }
  const boundedRoots = new Set(
    [...nodeByPath.values()].flatMap((node) => node.referencedBy),
  );
  for (const node of nodeByPath.values()) {
    if (node.referencedBy.some((root) => !boundedRoots.has(root))) {
      throw new Error(`${node.path} has an unbounded source reference`);
    }
  }
  return Object.freeze({ nodeByPath, edgeKeys, digest: digest(graph) });
}

function witnessForMember(
  member: ResolvedCohortMemberV1,
  witness: CohortWitnessInputV1,
  graph: ReturnType<typeof validateSourceGraph>,
): {
  readonly atomWitness: CohortCommonBoundaryAtomV1["witness"];
  readonly applicability: MemberCommonBoundaryAttestationV1["applicability"];
} {
  if (witness.kind === "confirmed-cause") {
    assertDigest(witness.causeDigest, "confirmed cause digest");
    assertDigest(witness.receiptDigest, "confirmed cause receipt digest");
    if (
      member.phase !== "investigation" ||
      member.causeState !== "confirmed" ||
      !member.confirmedCauseReceiptDigests.includes(witness.receiptDigest)
    ) {
      throw new Error(`${member.memberRef} cannot attest the named confirmed-cause receipt`);
    }
    return Object.freeze({
      atomWitness: Object.freeze({
        kind: "confirmed-cause",
        witnessDigest: digest({
          kind: witness.kind,
          causeDigest: witness.causeDigest,
          receiptDigest: witness.receiptDigest,
        }),
      }),
      applicability: Object.freeze({
        kind: "confirmed-cause",
        receiptDigest: witness.receiptDigest,
        causeDigest: witness.causeDigest,
      }),
    });
  }

  const sourcePath = normalizedRepositoryPath(witness.sourcePath, "repository witness source");
  assertNonEmpty(witness.nodeIdentity, "repository witness node identity");
  if (witness.memberPath.length === 0) {
    throw new Error(`${member.memberRef} repository witness path must be non-empty`);
  }
  const memberPath = witness.memberPath.map((path) =>
    normalizedRepositoryPath(path, `${member.memberRef} repository witness path`),
  );
  if (!member.sourceRefs.includes(memberPath[0] ?? "")) {
    throw new Error(`${member.memberRef} repository witness path does not start at a source reference`);
  }
  if (memberPath.at(-1) !== sourcePath || !graph.nodeByPath.has(sourcePath)) {
    throw new Error(`${member.memberRef} repository witness path does not end at its source node`);
  }
  for (let index = 1; index < memberPath.length; index += 1) {
    const from = memberPath[index - 1];
    const to = memberPath[index];
    if (from === undefined || to === undefined || !graph.edgeKeys.has(`${from}\u0000${to}`)) {
      throw new Error(`${member.memberRef} repository witness path is not repository-derived`);
    }
  }
  const witnessDigest = digest({
    kind: witness.kind,
    nodeKind: witness.nodeKind,
    nodeIdentity: witness.nodeIdentity,
    sourcePath,
    blobDigest: graph.nodeByPath.get(sourcePath)?.blobDigest,
  });
  return Object.freeze({
    atomWitness: Object.freeze({ kind: "repository-node", witnessDigest }),
    applicability: Object.freeze({
      kind: "repository-path",
      nodeIdentity: witness.nodeIdentity,
      memberPath: Object.freeze(memberPath),
    }),
  });
}

function makeAtom(
  phase: CohortPhaseV1,
  candidate: CohortBoundaryCandidateInputV1,
  atomWitness: CohortCommonBoundaryAtomV1["witness"],
  repository: CohortRepositoryIdentityV1,
  environment: CohortEnvironmentIdentityV1,
): CohortCommonBoundaryAtomV1 {
  assertBoundaryIdentity(candidate.sharedRegression, "shared regression");
  assertBoundaryIdentity(candidate.canonicalFullGate, "canonical full gate");
  assertBoundaryIdentity(candidate.reviewerClass, "reviewer class");
  assertBoundaryIdentity(candidate.deploymentClass, "deployment class");
  assertBoundaryIdentity(candidate.finalizationClass, "finalization class");
  const payload = {
    kind: "cq-cohort-common-boundary-atom" as const,
    version: 1 as const,
    phase,
    witness: atomWitness,
    sharedRegression: candidate.sharedRegression,
    canonicalFullGate: candidate.canonicalFullGate,
    reviewerClass: candidate.reviewerClass,
    deploymentClass: candidate.deploymentClass,
    finalizationClass: candidate.finalizationClass,
    repository,
    environment,
    splitConditions: sortedUnique(candidate.splitConditions),
  };
  return Object.freeze({ ...payload, atomDigest: digest(payload) });
}

function makeAttestation(
  member: ResolvedCohortMemberV1,
  atom: CohortCommonBoundaryAtomV1,
  applicability: MemberCommonBoundaryAttestationV1["applicability"],
  acceptancePlan: MemberAcceptancePlanV1,
): MemberCommonBoundaryAttestationV1 {
  const payload = {
    kind: "cq-member-common-boundary-attestation" as const,
    version: 1 as const,
    atomDigest: atom.atomDigest,
    memberRef: member.memberRef,
    memberRevision: member.memberRevision,
    applicability,
    acceptancePlan,
  };
  return Object.freeze({ ...payload, attestationDigest: digest(payload) });
}

function orderedMembers(
  members: readonly ResolvedCohortMemberV1[],
  workset: CohortWorksetSnapshotV1,
): readonly ResolvedCohortMemberV1[] {
  assertUnique(workset.orderedMemberRefs, "workset member refs");
  const order = new Map(workset.orderedMemberRefs.map((memberRef, index) => [memberRef, index]));
  return Object.freeze(
    [...members].sort((left, right) => {
      const phase = COHORT_PHASE_ORDER_V1.indexOf(left.phase) - COHORT_PHASE_ORDER_V1.indexOf(right.phase);
      if (phase !== 0) return phase;
      const leftOrder = order.get(left.memberRef);
      const rightOrder = order.get(right.memberRef);
      if (leftOrder === undefined || rightOrder === undefined) {
        throw new Error("every cohort member must belong to the exact workset snapshot");
      }
      return leftOrder - rightOrder || left.memberRef.localeCompare(right.memberRef);
    }),
  );
}

/** Resolve and freeze one bounded, trusted pre-admission observation. */
export async function produceCohortAdmissionObservationV1(
  request: CohortAdmissionObservationRequestV1,
  source: CohortAdmissionObservationSourceV1,
): Promise<CohortAdmissionObservationV1> {
  if (request.memberRefs.length === 0) throw new Error("cohort observation requires members");
  assertUnique(request.memberRefs, "requested cohort member refs");
  const snapshot = await source.resolveExactSnapshot(request);
  assertNonEmpty(snapshot.producer, "cohort observation producer");
  assertNonEmpty(snapshot.producerRevision, "cohort observation producer revision");
  assertRepositoryIdentity(snapshot.repository);
  assertDigest(snapshot.environment.environmentDigest, "environment digest");
  const graph = validateSourceGraph(snapshot.sourceGraph);
  const members = orderedMembers(snapshot.members, snapshot.workset);
  if (canonical(sortedUnique(members.map((member) => member.memberRef))) !== canonical(sortedUnique(request.memberRefs))) {
    throw new Error("resolved cohort members do not exactly match the request");
  }
  if (
    members.some(
      (member) =>
        canonical(member.repository) !== canonical(snapshot.repository) ||
        canonical(member.environment) !== canonical(snapshot.environment),
    )
  ) {
    throw new Error("member repository/environment identity differs from the exact snapshot");
  }

  const atoms = new Map<string, CohortCommonBoundaryAtomV1>();
  const observedMembers: CohortMemberObservationV1[] = [];
  const worksetOrder = new Map(
    snapshot.workset.orderedMemberRefs.map((memberRef, index) => [memberRef, index]),
  );
  for (const member of members) {
    assertNonEmpty(member.memberRef, "cohort member ref");
    assertNonEmpty(member.memberRevision, `${member.memberRef} revision`);
    assertDigest(member.ownershipBoundaryDigest, `${member.memberRef} ownership boundary`);
    assertDigest(member.authorityBoundaryDigest, `${member.memberRef} authority boundary`);
    assertUnique(member.dependencyClosure, `${member.memberRef} dependency closure`);
    assertUnique(member.sourceRefs, `${member.memberRef} source refs`);
    for (const sourceRef of member.sourceRefs) {
      const path = normalizedRepositoryPath(sourceRef, `${member.memberRef} source ref`);
      if (!graph.nodeByPath.has(path)) throw new Error(`${member.memberRef} source ${path} was not inspected`);
    }
    if (
      member.phase === "implementation" &&
      (snapshot.manifest === null ||
        snapshot.manifest.manifestRevision !== member.finalizedManifestRevision ||
        !snapshot.manifest.memberRefs.includes(member.memberRef))
    ) {
      throw new Error(`${member.memberRef} is not in the exact finalized manifest snapshot`);
    }
    const attestations = member.boundaryCandidates.map((candidate) => {
      const witness = witnessForMember(member, candidate.witness, graph);
      const atom = makeAtom(
        member.phase,
        candidate,
        witness.atomWitness,
        snapshot.repository,
        snapshot.environment,
      );
      const prior = atoms.get(atom.atomDigest);
      if (prior !== undefined && canonical(prior) !== canonical(atom)) {
        throw new Error(`common atom digest collision for ${atom.atomDigest}`);
      }
      atoms.set(atom.atomDigest, atom);
      return makeAttestation(
        member,
        atom,
        witness.applicability,
        makeAcceptancePlan(member, candidate.focusedCommand),
      );
    });
    const common = {
      memberRef: member.memberRef,
      memberRevision: member.memberRevision,
      phase: member.phase,
      worksetOrder: worksetOrder.get(member.memberRef) ?? -1,
      ownershipBoundaryDigest: member.ownershipBoundaryDigest,
      authorityRef: member.authorityRef,
      authorityRevision: member.authorityRevision,
      authorityBoundaryDigest: member.authorityBoundaryDigest,
      dependencyClosure: Object.freeze([...member.dependencyClosure].sort()),
      sourceRefs: Object.freeze([...member.sourceRefs].sort()),
      repository: member.repository,
      environment: member.environment,
      attestations: Object.freeze(
        [...attestations].sort((left, right) => left.atomDigest.localeCompare(right.atomDigest)),
      ),
      unavailableFacts: Object.freeze([...member.unavailableFacts]),
    };
    const memberPayload =
      member.phase === "investigation"
        ? {
            ...common,
            phase: "investigation" as const,
            defectRef: member.defectRef,
            defectRevision: member.defectRevision,
            hypothesisRef: member.hypothesisRef,
            hypothesisRevision: member.hypothesisRevision,
            hypothesisState: member.hypothesisState,
            causeState: member.causeState,
            confirmedCauseReceiptDigests: Object.freeze(
              [...member.confirmedCauseReceiptDigests].sort(),
            ),
            investigationAuthority: member.investigationAuthority,
          }
        : {
            ...common,
            phase: "implementation" as const,
            taskRevision: member.taskRevision,
            goalRef: member.goalRef,
            finalizedManifestRevision: member.finalizedManifestRevision,
            implementationAuthority: member.implementationAuthority,
          };
    observedMembers.push(
      Object.freeze({ ...memberPayload, memberBindingDigest: digest(memberPayload) }),
    );
  }

  const inputDigest = digest({ memberRefs: [...request.memberRefs].sort() });
  const observationSetDigest = digest(
    observedMembers.map((member) => ({
      memberRef: member.memberRef,
      memberRevision: member.memberRevision,
      memberBindingDigest: member.memberBindingDigest,
    })),
  );
  const payload = {
    kind: "cq-cohort-admission-observation" as const,
    version: 1 as const,
    producer: snapshot.producer,
    producerRevision: snapshot.producerRevision,
    inputDigest,
    observationSetDigest,
    workset: snapshot.workset,
    manifest: snapshot.manifest,
    repository: snapshot.repository,
    environment: snapshot.environment,
    sourceGraphDigest: graph.digest,
    atoms: Object.freeze([...atoms.values()].sort((left, right) => left.atomDigest.localeCompare(right.atomDigest))),
    members: Object.freeze(observedMembers),
    authenticatedBenefitReceipts: Object.freeze([...snapshot.authenticatedBenefitReceipts]),
    unavailableFacts: Object.freeze([...snapshot.unavailableFacts]),
  };
  return Object.freeze({ ...payload, observationDigest: digest(payload) });
}

export type CohortObservationInvalidationV1 =
  | "phase"
  | "revision"
  | "manifest"
  | "source-or-tree"
  | "dependency-graph"
  | "command"
  | "environment"
  | "reviewer"
  | "deployment"
  | "finalization"
  | "cause-or-witness"
  | "authority";

/** Compare two freshly produced observations without treating their prose as authority. */
export function cohortObservationInvalidationsV1(
  prior: CohortAdmissionObservationV1,
  current: CohortAdmissionObservationV1,
): readonly CohortObservationInvalidationV1[] {
  if (prior.observationDigest === current.observationDigest) return Object.freeze([]);
  const reasons = new Set<CohortObservationInvalidationV1>();
  if (canonical(prior.manifest) !== canonical(current.manifest)) reasons.add("manifest");
  if (
    canonical(prior.repository) !== canonical(current.repository) ||
    prior.sourceGraphDigest !== current.sourceGraphDigest
  ) {
    reasons.add("source-or-tree");
  }
  if (canonical(prior.environment) !== canonical(current.environment)) reasons.add("environment");
  const priorMembers = new Map(prior.members.map((member) => [member.memberRef, member]));
  for (const member of current.members) {
    const old = priorMembers.get(member.memberRef);
    if (old === undefined || old.phase !== member.phase) reasons.add("phase");
    if (old === undefined || old.memberRevision !== member.memberRevision) reasons.add("revision");
    if (old === undefined || canonical(old.dependencyClosure) !== canonical(member.dependencyClosure)) {
      reasons.add("dependency-graph");
    }
    if (
      old === undefined ||
      old.authorityRef !== member.authorityRef ||
      old.authorityRevision !== member.authorityRevision ||
      old.authorityBoundaryDigest !== member.authorityBoundaryDigest
    ) {
      reasons.add("authority");
    }
    const oldAttestations = old?.attestations ?? [];
    if (
      canonical(oldAttestations.map((attestation) => attestation.acceptancePlan)) !==
      canonical(member.attestations.map((attestation) => attestation.acceptancePlan))
    ) {
      reasons.add("command");
    }
    const oldAtoms = oldAttestations.map((attestation) =>
      prior.atoms.find((atom) => atom.atomDigest === attestation.atomDigest),
    );
    const currentAtoms = member.attestations.map((attestation) =>
      current.atoms.find((atom) => atom.atomDigest === attestation.atomDigest),
    );
    const projectionChanged = (
      project: (atom: CohortCommonBoundaryAtomV1) => unknown,
    ): boolean =>
      canonical(oldAtoms.filter((atom): atom is CohortCommonBoundaryAtomV1 => atom !== undefined).map(project)) !==
      canonical(currentAtoms.filter((atom): atom is CohortCommonBoundaryAtomV1 => atom !== undefined).map(project));
    if (projectionChanged((atom) => atom.reviewerClass)) reasons.add("reviewer");
    if (projectionChanged((atom) => atom.deploymentClass)) reasons.add("deployment");
    if (projectionChanged((atom) => atom.finalizationClass)) reasons.add("finalization");
    if (projectionChanged((atom) => atom.witness)) reasons.add("cause-or-witness");
  }
  return Object.freeze(
    [...reasons].sort((left, right) => left.localeCompare(right)),
  );
}

export interface CohortAcceptanceMatrixV1 {
  readonly kind: "cq-cohort-acceptance-matrix";
  readonly version: 1;
  readonly atomDigest: string;
  readonly members: readonly {
    readonly memberRef: string;
    readonly memberRevision: string;
    readonly focusedPlanDigest: string;
  }[];
  readonly normalizedCommandClasses: readonly {
    readonly normalizedCommandDigest: string;
    readonly memberRefs: readonly string[];
  }[];
  readonly sharedRegression: CohortBoundaryIdentityV1;
  readonly canonicalFullGate: CohortBoundaryIdentityV1;
  readonly matrixDigest: string;
}

export interface CohortExclusionV1 {
  readonly memberRef: string;
  readonly reason: CohortExclusionReasonV1;
  readonly againstMemberRef: string;
}

export interface CohortDecisionV1 {
  readonly kind: "cq-cohort-decision";
  readonly version: 1;
  readonly producer: string;
  readonly producerRevision: string;
  readonly observationSetDigest: string;
  readonly worksetRevision: string;
  readonly manifestRevision: string | null;
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly inputDigest: string;
  readonly selectedAtomDigest: string;
  readonly matrix: CohortAcceptanceMatrixV1;
  readonly includedMemberRefs: readonly string[];
  readonly excluded: readonly CohortExclusionV1[];
  readonly memberProofs: readonly {
    readonly memberRef: string;
    readonly attestationDigest: string;
    readonly applicability: MemberCommonBoundaryAttestationV1["applicability"];
    readonly acceptancePlanDigest: string;
  }[];
  readonly splitConditions: readonly string[];
  readonly benefit: {
    readonly basis: "eliminate-identical-gate-review-deployment";
    readonly receipts: readonly CohortAuthenticatedBenefitReceiptV1[];
    readonly unknownBoundaryDigests: readonly string[];
  };
  readonly decisionDigest: string;
}

function atomByDigest(
  observation: CohortAdmissionObservationV1,
): ReadonlyMap<string, CohortCommonBoundaryAtomV1> {
  return new Map(observation.atoms.map((atom) => [atom.atomDigest, atom]));
}

function atomSet(member: CohortMemberObservationV1): Set<string> {
  return new Set(member.attestations.map((attestation) => attestation.atomDigest));
}

type Projection =
  | "witness"
  | "validation"
  | "reviewer"
  | "deployment"
  | "finalization";

function projectionSet(
  member: CohortMemberObservationV1,
  atoms: ReadonlyMap<string, CohortCommonBoundaryAtomV1>,
  projection: Projection,
): Set<string> {
  return new Set(
    member.attestations.map((attestation) => {
      const atom = atoms.get(attestation.atomDigest);
      if (atom === undefined) throw new Error(`missing common atom ${attestation.atomDigest}`);
      switch (projection) {
        case "witness":
          return atom.witness.witnessDigest;
        case "validation":
          return digest({
            sharedRegression: atom.sharedRegression,
            canonicalFullGate: atom.canonicalFullGate,
          });
        case "reviewer":
          return atom.reviewerClass.digest;
        case "deployment":
          return atom.deploymentClass.digest;
        case "finalization":
          return atom.finalizationClass.digest;
      }
    }),
  );
}

const PROJECTION_EXCLUSION: Readonly<Record<Projection, CohortExclusionReasonV1>> = {
  witness: "cohort-witness-empty",
  validation: "validation-boundary-empty",
  reviewer: "reviewer-boundary-empty",
  deployment: "deployment-boundary-empty",
  finalization: "finalization-boundary-empty",
};

function pairExclusions(
  included: CohortMemberObservationV1,
  candidate: CohortMemberObservationV1,
  atoms: ReadonlyMap<string, CohortCommonBoundaryAtomV1>,
): readonly CohortExclusionReasonV1[] {
  const reasons: CohortExclusionReasonV1[] = [];
  if (candidate.unavailableFacts.length > 0) reasons.push("stale-binding");
  if (included.phase !== candidate.phase) reasons.push("phase-mismatch");
  if (included.ownershipBoundaryDigest !== candidate.ownershipBoundaryDigest) {
    reasons.push("ownership-or-manifest");
  }
  if (
    included.dependencyClosure.includes(candidate.memberRef) ||
    candidate.dependencyClosure.includes(included.memberRef)
  ) {
    reasons.push("dependency");
  }
  if (included.authorityBoundaryDigest !== candidate.authorityBoundaryDigest) {
    reasons.push("authority");
  }
  if (
    canonical(included.repository) !== canonical(candidate.repository) ||
    canonical(included.environment) !== canonical(candidate.environment)
  ) {
    reasons.push("repository-or-environment");
  }
  for (const projection of [
    "witness",
    "validation",
    "reviewer",
    "deployment",
    "finalization",
  ] as const) {
    if (
      intersection(
        projectionSet(included, atoms, projection),
        projectionSet(candidate, atoms, projection),
      ).size === 0
    ) {
      reasons.push(PROJECTION_EXCLUSION[projection]);
    }
  }
  if (intersection(atomSet(included), atomSet(candidate)).size === 0) {
    reasons.push("eligibility-tuple-empty");
  }
  return Object.freeze(reasons);
}

function firstExclusion(
  included: readonly CohortMemberObservationV1[],
  candidate: CohortMemberObservationV1,
  cumulativeAtoms: ReadonlySet<string>,
  atoms: ReadonlyMap<string, CohortCommonBoundaryAtomV1>,
): CohortExclusionV1 | null {
  const failures: { reason: CohortExclusionReasonV1; against: CohortMemberObservationV1 }[] = [];
  for (const member of included) {
    for (const reason of pairExclusions(member, candidate, atoms)) {
      failures.push({ reason, against: member });
    }
  }
  const cumulativeProjectionEmpty = (projection: Projection): boolean => {
    let surviving: Set<string> | null = null;
    for (const member of [...included, candidate]) {
      const memberProjection = projectionSet(member, atoms, projection);
      surviving = surviving === null ? memberProjection : intersection(surviving, memberProjection);
    }
    return surviving?.size === 0;
  };
  for (const projection of [
    "witness",
    "validation",
    "reviewer",
    "deployment",
    "finalization",
  ] as const) {
    if (cumulativeProjectionEmpty(projection)) {
      failures.push({ reason: PROJECTION_EXCLUSION[projection], against: included[0]! });
    }
  }
  if (intersection(cumulativeAtoms, atomSet(candidate)).size === 0) {
    failures.push({ reason: "eligibility-tuple-empty", against: included[0]! });
  }
  if (failures.length === 0) return null;
  failures.sort((left, right) => {
    const priority =
      COHORT_EXCLUSION_PRIORITY_V1.indexOf(left.reason) -
      COHORT_EXCLUSION_PRIORITY_V1.indexOf(right.reason);
    return priority || left.against.memberRef.localeCompare(right.against.memberRef);
  });
  const first = failures[0]!;
  return Object.freeze({
    memberRef: candidate.memberRef,
    reason: first.reason,
    againstMemberRef: first.against.memberRef,
  });
}

function freezeMatrix(
  members: readonly CohortMemberObservationV1[],
  atom: CohortCommonBoundaryAtomV1,
): CohortAcceptanceMatrixV1 {
  const selected = members.map((member) => {
    const matches = member.attestations.filter(
      (attestation) => attestation.atomDigest === atom.atomDigest,
    );
    if (matches.length !== 1) {
      throw new Error(`${member.memberRef} must have one attestation for the selected atom`);
    }
    return { member, attestation: matches[0]! };
  });
  const commandClasses = new Map<string, string[]>();
  for (const entry of selected) {
    const key = entry.attestation.acceptancePlan.normalizedCommandDigest;
    const refs = commandClasses.get(key) ?? [];
    refs.push(entry.member.memberRef);
    commandClasses.set(key, refs);
  }
  const payload = {
    kind: "cq-cohort-acceptance-matrix" as const,
    version: 1 as const,
    atomDigest: atom.atomDigest,
    members: Object.freeze(
      selected.map(({ member, attestation }) =>
        Object.freeze({
          memberRef: member.memberRef,
          memberRevision: member.memberRevision,
          focusedPlanDigest: attestation.acceptancePlan.planDigest,
        }),
      ),
    ),
    normalizedCommandClasses: Object.freeze(
      [...commandClasses.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([normalizedCommandDigest, memberRefs]) =>
          Object.freeze({
            normalizedCommandDigest,
            memberRefs: Object.freeze(memberRefs.sort((left, right) => left.localeCompare(right))),
          }),
        ),
    ),
    sharedRegression: atom.sharedRegression,
    canonicalFullGate: atom.canonicalFullGate,
  };
  return Object.freeze({ ...payload, matrixDigest: digest(payload) });
}

function makeDecision(
  observation: CohortAdmissionObservationV1,
  included: readonly CohortMemberObservationV1[],
  excluded: readonly CohortExclusionV1[],
  survivingAtoms: ReadonlySet<string>,
  atoms: ReadonlyMap<string, CohortCommonBoundaryAtomV1>,
): CohortDecisionV1 {
  const selectedAtomDigest = [...survivingAtoms].sort((left, right) => left.localeCompare(right))[0];
  if (selectedAtomDigest === undefined) throw new Error("cohort anchor has no complete common atom");
  const atom = atoms.get(selectedAtomDigest);
  if (atom === undefined) throw new Error(`missing selected common atom ${selectedAtomDigest}`);
  const matrix = freezeMatrix(included, atom);
  const memberProofs = included.map((member) => {
    const attestation = member.attestations.find(
      (candidate) => candidate.atomDigest === selectedAtomDigest,
    );
    if (attestation === undefined) throw new Error(`${member.memberRef} lacks selected atom proof`);
    return Object.freeze({
      memberRef: member.memberRef,
      attestationDigest: attestation.attestationDigest,
      applicability: attestation.applicability,
      acceptancePlanDigest: attestation.acceptancePlan.planDigest,
    });
  });
  const boundaryDigests = [
    atom.canonicalFullGate.digest,
    atom.reviewerClass.digest,
    atom.deploymentClass.digest,
  ];
  const receipts = observation.authenticatedBenefitReceipts.filter((receipt) =>
    boundaryDigests.includes(receipt.boundaryDigest),
  );
  const receiptBoundaries = new Set(receipts.map((receipt) => receipt.boundaryDigest));
  const payload = {
    kind: "cq-cohort-decision" as const,
    version: 1 as const,
    producer: observation.producer,
    producerRevision: observation.producerRevision,
    observationSetDigest: observation.observationSetDigest,
    worksetRevision: observation.workset.worksetRevision,
    manifestRevision: observation.manifest?.manifestRevision ?? null,
    repository: observation.repository,
    environment: observation.environment,
    inputDigest: observation.inputDigest,
    selectedAtomDigest,
    matrix,
    includedMemberRefs: Object.freeze(included.map((member) => member.memberRef)),
    excluded: Object.freeze([...excluded]),
    memberProofs: Object.freeze(memberProofs),
    splitConditions: atom.splitConditions,
    benefit: Object.freeze({
      basis: "eliminate-identical-gate-review-deployment" as const,
      receipts: Object.freeze(receipts),
      unknownBoundaryDigests: sortedUnique(
        boundaryDigests.filter((boundaryDigest) => !receiptBoundaries.has(boundaryDigest)),
      ),
    }),
  };
  return Object.freeze({ ...payload, decisionDigest: digest(payload) });
}

/** Deterministically assign every observed member to exactly one cohort. */
export function constructCohortDecisionsV1(
  observation: CohortAdmissionObservationV1,
): readonly CohortDecisionV1[] {
  const atoms = atomByDigest(observation);
  const remaining = [...observation.members];
  const decisions: CohortDecisionV1[] = [];
  while (remaining.length > 0) {
    const anchor = remaining.shift()!;
    const included = [anchor];
    let survivingAtoms = atomSet(anchor);
    const excluded: CohortExclusionV1[] = [];
    const admittedRefs = new Set([anchor.memberRef]);
    for (const candidate of remaining) {
      const failure = firstExclusion(included, candidate, survivingAtoms, atoms);
      if (failure !== null) {
        excluded.push(failure);
        continue;
      }
      survivingAtoms = intersection(survivingAtoms, atomSet(candidate));
      included.push(candidate);
      admittedRefs.add(candidate.memberRef);
    }
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (admittedRefs.has(remaining[index]!.memberRef)) remaining.splice(index, 1);
    }
    decisions.push(makeDecision(observation, included, excluded, survivingAtoms, atoms));
  }
  return Object.freeze(decisions);
}

export interface CohortDefinitionIdentityV1 {
  readonly kind: "cq-cohort-definition-identity";
  readonly version: 1;
  readonly cohortId: string;
  readonly definitionGeneration: number;
  readonly phase: CohortPhaseV1;
  readonly members: readonly {
    readonly memberRef: string;
    readonly memberRevision: string;
    readonly authorityRef: string;
    readonly authorityRevision: string;
  }[];
  readonly selectedAtomDigest: string;
  readonly acceptanceMatrixDigest: string;
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly splitConditions: readonly string[];
  readonly semanticDigest: string;
  readonly definitionDigest: string;
}

function definitionSemanticPayload(
  cohortId: string,
  decision: CohortDecisionV1,
  observation: CohortAdmissionObservationV1,
): Omit<
  CohortDefinitionIdentityV1,
  "kind" | "version" | "definitionGeneration" | "semanticDigest" | "definitionDigest"
> {
  const byRef = new Map(observation.members.map((member) => [member.memberRef, member]));
  const members = decision.includedMemberRefs.map((memberRef) => {
    const member = byRef.get(memberRef);
    if (member === undefined) throw new Error(`definition member ${memberRef} was not observed`);
    return Object.freeze({
      memberRef,
      memberRevision: member.memberRevision,
      authorityRef: member.authorityRef,
      authorityRevision: member.authorityRevision,
    });
  });
  const first = byRef.get(decision.includedMemberRefs[0] ?? "");
  if (first === undefined) throw new Error("cohort definition requires members");
  return Object.freeze({
    cohortId,
    phase: first.phase,
    members: Object.freeze(members),
    selectedAtomDigest: decision.selectedAtomDigest,
    acceptanceMatrixDigest: decision.matrix.matrixDigest,
    repository: decision.repository,
    environment: decision.environment,
    splitConditions: decision.splitConditions,
  });
}

export function createCohortDefinitionIdentityV1(input: {
  readonly cohortId: string;
  readonly decision: CohortDecisionV1;
  readonly observation: CohortAdmissionObservationV1;
  readonly prior: CohortDefinitionIdentityV1 | null;
}): CohortDefinitionIdentityV1 {
  assertNonEmpty(input.cohortId, "cohort id");
  const semantic = definitionSemanticPayload(input.cohortId, input.decision, input.observation);
  const semanticDigest = digest(semantic);
  if (input.prior !== null && input.prior.semanticDigest === semanticDigest) return input.prior;
  const definitionGeneration = input.prior === null ? 1 : input.prior.definitionGeneration + 1;
  const payload = {
    kind: "cq-cohort-definition-identity" as const,
    version: 1 as const,
    definitionGeneration,
    ...semantic,
    semanticDigest,
  };
  return Object.freeze({ ...payload, definitionDigest: digest(payload) });
}

export interface CohortPreparedDispatchIdentityV1 {
  readonly attestationId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly branch: string;
  readonly startingCommit: string;
}

interface CohortCandidateAttemptBaseV1 {
  readonly kind: "cq-cohort-candidate-attempt";
  readonly version: 1;
  readonly definitionDigest: string;
  readonly preparedDispatch: CohortPreparedDispatchIdentityV1;
  readonly pendingAttemptDigest: string;
  readonly candidateAttemptDigest: string;
}

export interface PendingCohortCandidateAttemptV1 extends CohortCandidateAttemptBaseV1 {
  readonly state: "pending";
}

export interface StagedCohortCandidateAttemptV1 extends CohortCandidateAttemptBaseV1 {
  readonly state: "staged";
  readonly g213: {
    readonly partitionKey: string;
    readonly enrollmentId: string;
    readonly attemptId: string;
    readonly resultCommit: string;
    readonly resultTree: string;
    readonly gitReceiptLineageDigest: string;
  };
}

export type CohortCandidateAttemptV1 =
  | PendingCohortCandidateAttemptV1
  | StagedCohortCandidateAttemptV1;

export function createPendingCohortCandidateAttemptV1(
  definition: CohortDefinitionIdentityV1,
  preparedDispatch: CohortPreparedDispatchIdentityV1,
): PendingCohortCandidateAttemptV1 {
  assertCommit(preparedDispatch.startingCommit, "prepared dispatch starting commit");
  if (!Number.isInteger(preparedDispatch.generation) || preparedDispatch.generation < 1) {
    throw new Error("prepared dispatch generation must be a positive integer");
  }
  const base = {
    kind: "cq-cohort-candidate-attempt" as const,
    version: 1 as const,
    definitionDigest: definition.definitionDigest,
    preparedDispatch,
  };
  const pendingAttemptDigest = digest(base);
  const payload = { ...base, state: "pending" as const, pendingAttemptDigest };
  return Object.freeze({ ...payload, candidateAttemptDigest: digest(payload) });
}

export interface G213CandidateAttemptBindingV1 {
  readonly preparedDispatch: CohortPreparedDispatchIdentityV1;
  readonly queue: ImplementationQueueControl;
}

/** Project, but never allocate, the candidate identity owned by G213. */
export function stageCohortCandidateAttemptV1(
  pending: PendingCohortCandidateAttemptV1,
  binding: G213CandidateAttemptBindingV1,
): StagedCohortCandidateAttemptV1 {
  if (canonical(pending.preparedDispatch) !== canonical(binding.preparedDispatch)) {
    throw new Error("G213 candidate binding substituted the prepared dispatch");
  }
  const queue = binding.queue;
  if (
    queue.state !== "qualified" ||
    queue.qualification === undefined ||
    queue.attempt.taskId !== pending.preparedDispatch.taskId
  ) {
    throw new Error("cohort binding requires G213's exact qualified candidate attempt");
  }
  const g213 = Object.freeze({
    partitionKey: queue.partition.partitionKey,
    enrollmentId: queue.enrollment.enrollmentId,
    attemptId: queue.attempt.attemptId,
    resultCommit: queue.attempt.resultCommit,
    resultTree: queue.attempt.resultTree,
    gitReceiptLineageDigest: queue.attempt.gitReceiptLineageDigest,
  });
  const payload = {
    kind: pending.kind,
    version: pending.version,
    definitionDigest: pending.definitionDigest,
    preparedDispatch: pending.preparedDispatch,
    state: "staged" as const,
    pendingAttemptDigest: pending.pendingAttemptDigest,
    g213,
  };
  return Object.freeze({ ...payload, candidateAttemptDigest: digest(payload) });
}

export interface CohortWholeDiffEntryV1 {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly blobDigest: string;
}

export interface CohortGitChangeReceiptV1 {
  readonly kind: "cq-git-change-receipt";
  readonly version: 1;
  readonly attestationId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly oldHead: string;
  readonly newHead: string;
  readonly tree: string;
  readonly objectOids: readonly string[];
  readonly paths: readonly string[];
  readonly committedAt: string;
}

export interface CohortCandidateSealV1 {
  readonly kind: "cq-cohort-candidate-seal";
  readonly version: 1;
  readonly definitionDigest: string;
  readonly candidateAttemptDigest: string;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly wholeDiff: readonly CohortWholeDiffEntryV1[];
  readonly wholeDiffDigest: string;
  readonly gitReceipts: readonly CohortGitChangeReceiptV1[];
  readonly gitReceiptBridgeDigest: string;
  readonly sealDigest: string;
}

export class CohortCandidateSealConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CohortCandidateSealConflictError";
  }
}

export interface CohortCandidateSealRequestV1 {
  readonly definition: CohortDefinitionIdentityV1;
  readonly attempt: StagedCohortCandidateAttemptV1;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly wholeDiff: readonly CohortWholeDiffEntryV1[];
  readonly gitReceipts: readonly CohortGitChangeReceiptV1[];
}

export interface CohortCandidateSealStoreV1 {
  seal(request: CohortCandidateSealRequestV1): {
    readonly state: "sealed" | "existing";
    readonly seal: CohortCandidateSealV1;
  };
  read(candidateAttemptDigest: string): CohortCandidateSealV1 | undefined;
}

function materializeSeal(request: CohortCandidateSealRequestV1): CohortCandidateSealV1 {
  if (request.definition.definitionDigest !== request.attempt.definitionDigest) {
    throw new CohortCandidateSealConflictError("candidate attempt belongs to another definition");
  }
  assertCommit(request.baseCommit, "candidate seal base commit");
  assertCommit(request.resultCommit, "candidate seal result commit");
  if (!/^[0-9a-f]{40,64}$/u.test(request.resultTree)) {
    throw new Error("candidate seal result tree must be a lowercase object id");
  }
  if (
    request.attempt.g213.resultCommit !== request.resultCommit ||
    request.attempt.g213.resultTree !== request.resultTree
  ) {
    throw new CohortCandidateSealConflictError("candidate seal substituted G213 result identity");
  }
  const wholeDiff = [...request.wholeDiff]
    .map((entry) => {
      const path = normalizedRepositoryPath(entry.path, "candidate whole-diff path");
      assertDigest(entry.blobDigest, `${path} whole-diff blob digest`);
      return Object.freeze({ ...entry, path });
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  assertUnique(wholeDiff.map((entry) => entry.path), "candidate whole-diff paths");
  const receipts = [...request.gitReceipts];
  if (receipts.length === 0 && request.baseCommit !== request.resultCommit) {
    throw new CohortCandidateSealConflictError("changed candidate lacks its Git receipt bridge");
  }
  let expected = request.baseCommit;
  for (const receipt of receipts) {
    if (receipt.oldHead !== expected) {
      throw new CohortCandidateSealConflictError("Git receipt bridge is not contiguous from base");
    }
    expected = receipt.newHead;
  }
  if (expected !== request.resultCommit) {
    throw new CohortCandidateSealConflictError("Git receipt bridge does not end at result commit");
  }
  const receiptDigest = digest(receipts);
  if (receiptDigest !== request.attempt.g213.gitReceiptLineageDigest) {
    throw new CohortCandidateSealConflictError("Git receipt bridge differs from G213 lineage");
  }
  const payload = {
    kind: "cq-cohort-candidate-seal" as const,
    version: 1 as const,
    definitionDigest: request.definition.definitionDigest,
    candidateAttemptDigest: request.attempt.candidateAttemptDigest,
    baseCommit: request.baseCommit,
    resultCommit: request.resultCommit,
    resultTree: request.resultTree,
    wholeDiff: Object.freeze(wholeDiff),
    wholeDiffDigest: digest(wholeDiff),
    gitReceipts: Object.freeze(receipts),
    gitReceiptBridgeDigest: receiptDigest,
  };
  return Object.freeze({ ...payload, sealDigest: digest(payload) });
}

export class InMemoryCohortCandidateSealStoreV1 implements CohortCandidateSealStoreV1 {
  readonly #seals = new Map<string, CohortCandidateSealV1>();

  seal(request: CohortCandidateSealRequestV1): {
    readonly state: "sealed" | "existing";
    readonly seal: CohortCandidateSealV1;
  } {
    const candidate = materializeSeal(request);
    const prior = this.#seals.get(request.attempt.candidateAttemptDigest);
    if (prior !== undefined) {
      if (canonical(prior) !== canonical(candidate)) {
        throw new CohortCandidateSealConflictError("altered candidate seal replay");
      }
      return Object.freeze({ state: "existing", seal: prior });
    }
    this.#seals.set(request.attempt.candidateAttemptDigest, candidate);
    return Object.freeze({ state: "sealed", seal: candidate });
  }

  read(candidateAttemptDigest: string): CohortCandidateSealV1 | undefined {
    return this.#seals.get(candidateAttemptDigest);
  }
}

export interface CohortEvidenceSubjectV1 {
  readonly kind: "cq-cohort-evidence-subject";
  readonly version: 1;
  readonly definitionDigest: string;
  readonly sealDigest: string;
  readonly evidenceSubjectDigest: string;
}

export function createCohortEvidenceSubjectV1(
  definition: CohortDefinitionIdentityV1,
  seal: CohortCandidateSealV1,
): CohortEvidenceSubjectV1 {
  if (definition.definitionDigest !== seal.definitionDigest) {
    throw new Error("candidate seal belongs to another cohort definition");
  }
  const payload = {
    kind: "cq-cohort-evidence-subject" as const,
    version: 1 as const,
    definitionDigest: definition.definitionDigest,
    sealDigest: seal.sealDigest,
  };
  return Object.freeze({ ...payload, evidenceSubjectDigest: digest(payload) });
}

export interface CohortEffectEnvelopeV1 {
  readonly kind: "cq-cohort-effect-envelope";
  readonly version: 1;
  readonly semanticSubject: string;
  readonly executionEpoch: string;
  readonly envelopeDigest: string;
}

export function createCohortEffectEnvelopeV1(input: {
  readonly definition: CohortDefinitionIdentityV1;
  readonly attempt: CohortCandidateAttemptV1;
  readonly evidenceSubject: CohortEvidenceSubjectV1 | null;
  readonly executionEpoch: string;
}): CohortEffectEnvelopeV1 {
  assertNonEmpty(input.executionEpoch, "cohort execution epoch");
  if (input.definition.definitionDigest !== input.attempt.definitionDigest) {
    throw new Error("effect envelope attempt belongs to another definition");
  }
  const semanticSubject =
    input.evidenceSubject === null
      ? digest({
          definitionDigest: input.definition.definitionDigest,
          candidateAttemptDigest: input.attempt.candidateAttemptDigest,
        })
      : input.evidenceSubject.evidenceSubjectDigest;
  if (
    input.evidenceSubject !== null &&
    input.evidenceSubject.definitionDigest !== input.definition.definitionDigest
  ) {
    throw new Error("effect envelope evidence belongs to another definition");
  }
  const payload = {
    kind: "cq-cohort-effect-envelope" as const,
    version: 1 as const,
    semanticSubject,
    executionEpoch: input.executionEpoch,
  };
  return Object.freeze({ ...payload, envelopeDigest: digest(payload) });
}

export interface CohortLiveEffectBindingV1 {
  readonly semanticSubject: string;
  readonly executionEpoch: string;
  readonly effectDigest: string;
}

export function bindCohortLiveEffectV1(
  envelope: CohortEffectEnvelopeV1,
  effectIdentity: string,
): CohortLiveEffectBindingV1 {
  assertNonEmpty(effectIdentity, "cohort effect identity");
  return Object.freeze({
    semanticSubject: envelope.semanticSubject,
    executionEpoch: envelope.executionEpoch,
    effectDigest: digest({ envelopeDigest: envelope.envelopeDigest, effectIdentity }),
  });
}

export function assertCohortLiveEffectCurrentV1(
  envelope: CohortEffectEnvelopeV1,
  binding: CohortLiveEffectBindingV1,
): void {
  if (
    envelope.semanticSubject !== binding.semanticSubject ||
    envelope.executionEpoch !== binding.executionEpoch
  ) {
    throw new Error("cohort live effect is fenced by another semantic subject or execution epoch");
  }
}

export interface CohortEvidenceReceiptV1 {
  readonly evidenceSubjectDigest: string;
  readonly acceptanceMatrixDigest: string;
  readonly environmentDigest: string;
  readonly authorizingExecutionEpoch: string;
  readonly receiptDigest: string;
}

export function createCohortEvidenceReceiptV1(input: {
  readonly evidenceSubject: CohortEvidenceSubjectV1;
  readonly definition: CohortDefinitionIdentityV1;
  readonly authorizingExecutionEpoch: string;
}): CohortEvidenceReceiptV1 {
  assertNonEmpty(input.authorizingExecutionEpoch, "authorizing execution epoch");
  if (input.evidenceSubject.definitionDigest !== input.definition.definitionDigest) {
    throw new Error("evidence receipt definition mismatch");
  }
  const payload = {
    evidenceSubjectDigest: input.evidenceSubject.evidenceSubjectDigest,
    acceptanceMatrixDigest: input.definition.acceptanceMatrixDigest,
    environmentDigest: input.definition.environment.environmentDigest,
    authorizingExecutionEpoch: input.authorizingExecutionEpoch,
  };
  return Object.freeze({ ...payload, receiptDigest: digest(payload) });
}

export function isCohortEvidenceReceiptReusableV1(input: {
  readonly receipt: CohortEvidenceReceiptV1;
  readonly evidenceSubject: CohortEvidenceSubjectV1;
  readonly definition: CohortDefinitionIdentityV1;
}): boolean {
  return (
    input.receipt.evidenceSubjectDigest === input.evidenceSubject.evidenceSubjectDigest &&
    input.receipt.acceptanceMatrixDigest === input.definition.acceptanceMatrixDigest &&
    input.receipt.environmentDigest === input.definition.environment.environmentDigest &&
    input.receipt.receiptDigest ===
      digest({
        evidenceSubjectDigest: input.receipt.evidenceSubjectDigest,
        acceptanceMatrixDigest: input.receipt.acceptanceMatrixDigest,
        environmentDigest: input.receipt.environmentDigest,
        authorizingExecutionEpoch: input.receipt.authorizingExecutionEpoch,
      })
  );
}
