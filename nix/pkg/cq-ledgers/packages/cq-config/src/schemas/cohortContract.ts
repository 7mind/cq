import type { JSONSchema } from "../promptCatalog.js";

const digest: JSONSchema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const commit: JSONSchema = { type: "string", pattern: "^[0-9a-f]{40}$" };
const text: JSONSchema = { type: "string", minLength: 1 };
const taskRef: JSONSchema = { type: "string", pattern: "^tasks:T[0-9]+$" };
const goalRef: JSONSchema = { type: "string", pattern: "^goals:G[0-9]+$" };

function closed(properties: Readonly<Record<string, JSONSchema>>): JSONSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export const cohortEvidenceSubjectSchema = closed({
  kind: { const: "cq-cohort-evidence-subject" }, version: { const: 1 },
  definitionDigest: digest, sealDigest: digest, evidenceSubjectDigest: digest,
});

const envelopeProperties = {
  kind: { const: "cq-cohort-effect-envelope" }, version: { const: 1 },
  definition: closed({
    kind: { const: "cq-cohort-definition-identity" }, version: { const: 1 },
    cohortId: text, definitionGeneration: { type: "integer", minimum: 1 }, phase: { const: "implementation" },
    members: { type: "array", minItems: 1, items: closed({
      memberRef: taskRef, memberRevision: digest, authorityRef: goalRef, authorityRevision: digest,
    }) },
    selectedAtomDigest: digest, acceptanceMatrixDigest: digest,
    repository: closed({ repositoryId: text, headCommit: commit, treeOid: commit }),
    environment: closed({ environmentDigest: digest }),
    splitConditions: { type: "array", items: text }, semanticDigest: digest, definitionDigest: digest,
  }),
  intent: closed({ kind: { const: "cq-cohort-candidate-intent" }, version: { const: 1 },
    definitionDigest: digest, operationId: text, intentDigest: digest }),
  memberAuthorities: { type: "array", minItems: 1, items: closed({
    taskRef, taskRevision: digest, goalRef, finalizedManifestDigest: digest, authorityRevision: digest,
  }) },
  memberSetDigest: digest, semanticSubject: digest, executionEpoch: text, envelopeDigest: digest,
} satisfies Readonly<Record<string, JSONSchema>>;

export const cohortPreSealEnvelopeSchema = closed({ ...envelopeProperties, state: { const: "pre-seal" } });
export const cohortSealedEnvelopeSchema = closed({ ...envelopeProperties, state: { const: "sealed" }, evidenceSubject: cohortEvidenceSubjectSchema });
export const cohortEffectEnvelopeSchema: JSONSchema = { oneOf: [cohortPreSealEnvelopeSchema, cohortSealedEnvelopeSchema] };
export const cohortBranchSchema: JSONSchema = { type: "string", pattern: "^implement/cohort-[0-9a-f]{64}$" };
const membersSchema: JSONSchema = { type: "array", minItems: 1, items: closed({
  memberRef: taskRef, headline: text, description: { type: "string" }, acceptance: text,
}) };
const memberObservationsSchema: JSONSchema = { type: "array", minItems: 1, items: closed({ memberRef: taskRef, observation: text }) };

export function cohortRoleArm(task: JSONSchema, envelope: JSONSchema, direction: "input" | "output"): JSONSchema {
  if (task.properties === undefined || task.required === undefined) throw new Error("cohort role arm requires a closed task object schema");
  const properties = { ...task.properties };
  for (const key of ["taskId", "headline", "description", "acceptance"]) delete properties[key];
  if (Object.hasOwn(properties, "branch")) properties["branch"] = cohortBranchSchema;
  properties["cohort"] = envelope;
  const memberField = direction === "input" ? "members" : "memberObservations";
  properties[memberField] = direction === "input" ? membersSchema : memberObservationsSchema;
  const { $id: _id, ...body } = task;
  return { ...body, properties,
    required: [...task.required.filter((key) => !["taskId", "headline", "description", "acceptance"].includes(key)), "cohort", memberField] };
}

export function cohortReceiptArm(task: JSONSchema): JSONSchema {
  if (task.properties === undefined || task.required === undefined) throw new Error("cohort receipt requires a closed task receipt");
  const { taskId: _taskId, ...properties } = task.properties;
  return { ...task, properties: { ...properties, version: { const: 2 }, cohort: cohortEffectEnvelopeSchema },
    required: [...task.required.filter((key) => key !== "taskId"), "cohort"] };
}

export function singleTaskOrCohortSchema(task: JSONSchema, cohort: JSONSchema): JSONSchema {
  const { $id: _id, $defs, ...taskArm } = task;
  const { $defs: _cohortDefs, ...cohortArm } = cohort;
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...(task.$id === undefined ? {} : { $id: task.$id }),
    ...($defs === undefined ? {} : { $defs }), oneOf: [taskArm, cohortArm] };
}
