import type { RoleSchemaSidecar } from "../promptCatalog.js";

const fullSha = "^[0-9a-f]{40}$";
const sha256 = "^[0-9a-f]{64}$";

const jsonValue = {
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: { $ref: "#/$defs/jsonValue" } },
    { type: "object", additionalProperties: { $ref: "#/$defs/jsonValue" } },
  ],
} as const;

const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/implementation-auditor/input",
  title: "implementation-auditor input",
  type: "object",
  $defs: { jsonValue },
  properties: {
    manifestId: { type: "string", minLength: 1 },
    manifestDigest: { type: "string", pattern: sha256 },
    recordKey: { type: "string", minLength: 1 },
    taskId: { type: "string", pattern: "^T[0-9]+$" },
    taskRef: { type: "string", pattern: "^tasks:T[0-9]+$" },
    ownerGoalRef: { type: "string", pattern: "^goals:G[0-9]+$" },
    finalizedManifest: { type: "string", minLength: 1 },
    historicalReview: { anyOf: [{ type: "null" }, { $ref: "#/$defs/jsonValue" }] },
    baseCommit: { type: "string", pattern: fullSha },
    resultCommit: { type: "string", pattern: fullSha },
    repositoryHead: { type: "string", pattern: fullSha },
    diff: { type: "string" },
    acceptance: { $ref: "#/$defs/jsonValue" },
    gateObservations: { $ref: "#/$defs/jsonValue" },
    auditRoster: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          alias: { type: "string", minLength: 1 },
          harness: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          provider: { type: ["string", "null"] },
          effort: { type: ["string", "null"] },
          launch: { type: "string", enum: ["native", "adapter"] },
          adapterId: { type: "string", minLength: 1 },
        },
        required: ["alias", "harness", "model", "provider", "launch", "adapterId"],
        additionalProperties: false,
      },
    },
    requiredObservations: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
  },
  required: [
    "manifestId",
    "manifestDigest",
    "recordKey",
    "taskId",
    "taskRef",
    "ownerGoalRef",
    "finalizedManifest",
    "historicalReview",
    "baseCommit",
    "resultCommit",
    "repositoryHead",
    "diff",
    "acceptance",
    "gateObservations",
    "auditRoster",
    "requiredObservations",
  ],
  additionalProperties: false,
} as const;

const observation = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["verified", "not-verified"] },
    detail: { type: "string", minLength: 1 },
  },
  required: ["name", "status", "detail"],
  additionalProperties: false,
} as const;

const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/implementation-auditor/output",
  title: "implementation-auditor verdict",
  type: "object",
  properties: {
    taskId: { type: "string", pattern: "^T[0-9]+$" },
    verdict: { type: "string", enum: ["approve", "disapprove"] },
    criticism: { type: "array", items: { type: "string", minLength: 1 } },
    questions: { type: "array", items: { type: "string", minLength: 1 } },
    observations: { type: "array", minItems: 1, items: observation },
    rationale: { type: "string", minLength: 1 },
    manifestDigest: { type: "string", pattern: sha256 },
    baseCommit: { type: "string", pattern: fullSha },
    resultCommit: { type: "string", pattern: fullSha },
    repositoryHead: { type: "string", pattern: fullSha },
  },
  required: [
    "taskId",
    "verdict",
    "criticism",
    "questions",
    "observations",
    "rationale",
    "manifestDigest",
    "baseCommit",
    "resultCommit",
    "repositoryHead",
  ],
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { verdict: { const: "approve" } }, required: ["verdict"] },
      then: {
        properties: {
          criticism: { maxItems: 0 },
          questions: { maxItems: 0 },
          observations: {
            items: {
              type: "object",
              properties: { status: { const: "verified" } },
              required: ["status"],
            },
          },
        },
      },
    },
    {
      if: { properties: { verdict: { const: "disapprove" } }, required: ["verdict"] },
      then: {
        anyOf: [
          { properties: { criticism: { minItems: 1 } }, required: ["criticism"] },
          { properties: { questions: { minItems: 1 } }, required: ["questions"] },
        ],
      },
    },
  ],
} as const;

export const implementationAuditorSidecar: RoleSchemaSidecar = {
  id: "implementation-auditor",
  version: 1,
  inputSchema,
  outputSchema,
};
