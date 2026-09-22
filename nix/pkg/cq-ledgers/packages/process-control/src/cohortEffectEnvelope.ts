import { createHash } from "node:crypto";

export interface CohortRepositoryIdentityV1 {
  readonly repositoryId: string;
  readonly headCommit: string;
  readonly treeOid: string;
}

export interface CohortEnvironmentIdentityV1 {
  readonly environmentDigest: string;
}

export interface CohortDefinitionIdentityV1 {
  readonly kind: "cq-cohort-definition-identity";
  readonly version: 1;
  readonly cohortId: string;
  readonly definitionGeneration: number;
  readonly phase: "investigation" | "implementation";
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

/** Allocated before worktree/dispatch preparation; never derived from a member task. */
export interface CohortCandidateIntentV1 {
  readonly kind: "cq-cohort-candidate-intent";
  readonly version: 1;
  readonly definitionDigest: string;
  readonly operationId: string;
  readonly intentDigest: string;
}

export interface CohortEvidenceSubjectV1 {
  readonly kind: "cq-cohort-evidence-subject";
  readonly version: 1;
  readonly definitionDigest: string;
  readonly sealDigest: string;
  readonly evidenceSubjectDigest: string;
}

export interface CohortMemberTaskAuthorityV1 {
  readonly taskRef: string;
  readonly taskRevision: string;
  readonly goalRef: string;
  readonly finalizedManifestDigest: string;
  readonly authorityRevision: string;
}

export interface CohortWorktreeIdentityV1 {
  readonly kind: "cq-cohort-worktree-identity";
  readonly version: 1;
  readonly cohortId: string;
  readonly definitionDigest: string;
  readonly candidateIntentDigest: string;
  readonly memberSetDigest: string;
  readonly memberAuthorities: readonly CohortMemberTaskAuthorityV1[];
}

interface CohortEffectEnvelopeBaseV1 {
  readonly kind: "cq-cohort-effect-envelope";
  readonly version: 1;
  readonly definition: CohortDefinitionIdentityV1;
  readonly intent: CohortCandidateIntentV1;
  readonly memberAuthorities: readonly CohortMemberTaskAuthorityV1[];
  readonly memberSetDigest: string;
  readonly semanticSubject: string;
  readonly executionEpoch: string;
  readonly envelopeDigest: string;
}

export type CohortEffectEnvelopeV1 =
  | (CohortEffectEnvelopeBaseV1 & { readonly state: "pre-seal" })
  | (CohortEffectEnvelopeBaseV1 & {
      readonly state: "sealed";
      readonly evidenceSubject: CohortEvidenceSubjectV1;
    });
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

export { digest as cohortValueDigestV1 };

export { canonical as canonicalCohortValueV1 };

function assertNonEmpty(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} must be non-empty`);
}

function assertDigest(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256 digest`);
}

function assertCommit(value: string, label: string): void {
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be one full lowercase commit SHA`);
}

export function createCohortCandidateIntentV1(
  definition: CohortDefinitionIdentityV1, operationId: string,
): CohortCandidateIntentV1 {
  assertNonEmpty(operationId, "cohort candidate intent operation");
  const payload = { kind: "cq-cohort-candidate-intent" as const, version: 1 as const,
    definitionDigest: definition.definitionDigest, operationId };
  return Object.freeze({ ...payload, intentDigest: digest(payload) });
}

function assertCohortClosedFields(value: object, fields: readonly string[], label: string): void {
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new Error(`${label} differs from its closed field set`);
  }
}

export function assertCohortCandidateIntentV1(
  intent: CohortCandidateIntentV1, definition: CohortDefinitionIdentityV1,
): void {
  const expected = createCohortCandidateIntentV1(definition, intent.operationId);
  if (canonical(intent) !== canonical(expected)) throw new Error("cohort candidate intent differs from its definition");
}

export function assertCohortEffectEnvelopeV1(envelope: CohortEffectEnvelopeV1): void {
  assertCohortClosedFields(envelope, ["kind", "version", "state", "definition", "intent", "memberAuthorities",
    "memberSetDigest", "semanticSubject", "executionEpoch", "envelopeDigest",
    ...(envelope.state === "sealed" ? ["evidenceSubject"] : [])], "cohort effect envelope");
  if (envelope.kind !== "cq-cohort-effect-envelope" || envelope.version !== 1 ||
      (envelope.state !== "pre-seal" && envelope.state !== "sealed")) throw new Error("invalid cohort effect envelope version or state");
  const { definition, intent, memberAuthorities } = envelope;
  assertCohortClosedFields(definition, ["kind", "version", "cohortId", "definitionGeneration", "phase", "members",
    "selectedAtomDigest", "acceptanceMatrixDigest", "repository", "environment", "splitConditions", "semanticDigest", "definitionDigest"], "cohort definition");
  const { kind, version, definitionDigest, semanticDigest, definitionGeneration, ...semantic } = definition;
  if (kind !== "cq-cohort-definition-identity" || version !== 1 || definition.phase !== "implementation" ||
      !Number.isInteger(definitionGeneration) || definitionGeneration < 1 ||
      digest(semantic) !== semanticDigest || digest({ kind, version, definitionGeneration, ...semantic, semanticDigest }) !== definitionDigest) {
    throw new Error("cohort effect definition is not an exact implementation definition");
  }
  assertNonEmpty(definition.cohortId, "cohort id");
  assertDigest(definition.selectedAtomDigest, "selected atom");
  assertDigest(definition.acceptanceMatrixDigest, "acceptance matrix");
  assertCohortClosedFields(definition.repository, ["repositoryId", "headCommit", "treeOid"], "cohort repository");
  assertNonEmpty(definition.repository.repositoryId, "cohort repository id");
  assertCommit(definition.repository.headCommit, "cohort repository head");
  assertCommit(definition.repository.treeOid, "cohort repository tree");
  assertCohortClosedFields(definition.environment, ["environmentDigest"], "cohort environment");
  assertDigest(definition.environment.environmentDigest, "cohort environment digest");
  if (!Array.isArray(definition.splitConditions) || definition.splitConditions.some((condition) => typeof condition !== "string")) {
    throw new Error("cohort split conditions must be an array of strings");
  }
  for (const condition of definition.splitConditions) assertNonEmpty(condition, "cohort split condition");
  if (!Array.isArray(definition.members) || !Array.isArray(memberAuthorities)) {
    throw new Error("cohort effect members and authorities must be arrays");
  }
  if (definition.members.length === 0 || memberAuthorities.length !== definition.members.length ||
      new Set(definition.members.map((member) => member.memberRef)).size !== definition.members.length) {
    throw new Error("cohort effect envelope requires the exact complete ordered member set");
  }
  for (const [index, member] of definition.members.entries()) {
    assertCohortClosedFields(member, ["memberRef", "memberRevision", "authorityRef", "authorityRevision"], "cohort member");
    const authority = memberAuthorities[index]!;
    assertCohortClosedFields(authority, ["taskRef", "taskRevision", "goalRef", "finalizedManifestDigest", "authorityRevision"], "cohort member authority");
    if (!/^tasks:T\d+$/u.test(member.memberRef) || !/^goals:G\d+$/u.test(member.authorityRef) ||
        authority.taskRef !== member.memberRef || authority.taskRevision !== member.memberRevision ||
        authority.goalRef !== member.authorityRef || authority.authorityRevision !== member.authorityRevision) {
      throw new Error("cohort effect envelope has a substituted member or goal authority");
    }
    assertDigest(member.memberRevision, "cohort member revision");
    assertDigest(member.authorityRevision, "cohort authority revision");
    assertDigest(authority.finalizedManifestDigest, "cohort manifest digest");
  }
  assertCohortCandidateIntentV1(intent, definition);
  const memberSetDigest = digest(memberAuthorities);
  let semanticSubject = digest({ definitionDigest, intentDigest: intent.intentDigest, memberSetDigest });
  if (envelope.state === "sealed") {
    const subject = envelope.evidenceSubject;
    assertCohortClosedFields(subject, ["kind", "version", "definitionDigest", "sealDigest", "evidenceSubjectDigest"], "cohort evidence subject");
    const { evidenceSubjectDigest, ...payload } = subject;
    if (subject.kind !== "cq-cohort-evidence-subject" || subject.version !== 1 ||
        subject.definitionDigest !== definitionDigest || digest(payload) !== evidenceSubjectDigest) {
      throw new Error("cohort effect evidence belongs to another definition or seal");
    }
    assertDigest(subject.sealDigest, "cohort seal digest");
    semanticSubject = evidenceSubjectDigest;
  }
  const { envelopeDigest, ...payload } = envelope;
  assertNonEmpty(envelope.executionEpoch, "cohort execution epoch");
  if (envelope.memberSetDigest !== memberSetDigest || envelope.semanticSubject !== semanticSubject || digest(payload) !== envelopeDigest) {
    throw new Error("cohort effect envelope digest or semantic subject is inconsistent");
  }
}

export function cohortEffectTargetRefV1(envelope: CohortEffectEnvelopeV1): string {
  assertCohortEffectEnvelopeV1(envelope);
  return `cq-cohort-effect:v1:${envelope.envelopeDigest}`;
}
