import { assertCohortEffectEnvelopeV1, type CohortEffectEnvelopeV1 } from "@cq/process-control";
import type { DispatchGuardedRebaseBridge } from "./dispatchAttestation.js";

const COMMON_FIELDS = ["guardedRebase", "operationId", "requestDigest", "oldResultCommit", "ontoCommit", "rebasedStartCommit", "outcome", "exactTip", "finalizedAt"];
const SOURCE_FIELDS = ["handleToken", "handleFingerprint", "repositoryRoot", "repositoryId", "commonDir", "worktreePath", "branch", "ref", "baseCommit"];
const JOURNAL_FIELDS = ["requestDigest", "oldResultCommit", "ontoCommit", "rebasedStartCommit", "cohortEnvelopeDigest", "conflictReceiptDigests"];
const COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function exactRecord(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) {
    throw new Error("guarded rebase bridge requires one closed task or cohort arm");
  }
}

export function assertDispatchGuardedRebaseBridge(value: unknown): asserts value is DispatchGuardedRebaseBridge {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid guarded rebase bridge");
  const candidate = value as Record<string, unknown>;
  const cohort = candidate["version"] === 2;
  exactRecord(candidate, [...COMMON_FIELDS, ...(cohort ? ["version", "cohort", "sourceBinding", "journals"] : [])]);
  if (typeof candidate["guardedRebase"] !== "string" || !/^cq-guarded-rebase:v1:[0-9a-f]{64}$/u.test(candidate["guardedRebase"]) ||
      typeof candidate["operationId"] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(candidate["operationId"]) ||
      typeof candidate["requestDigest"] !== "string" || !DIGEST.test(candidate["requestDigest"]) ||
      (cohort && candidate["guardedRebase"] !== `cq-guarded-rebase:v1:${candidate["requestDigest"]}`) ||
      !["oldResultCommit", "ontoCommit", "rebasedStartCommit"].every((field) => typeof candidate[field] === "string" && COMMIT.test(candidate[field])) ||
      (candidate["outcome"] !== "clean" && candidate["outcome"] !== "conflicted") ||
      typeof candidate["exactTip"] !== "boolean" || typeof candidate["finalizedAt"] !== "string" || candidate["finalizedAt"].trim() === "") {
    throw new Error("invalid guarded rebase bridge coordinates");
  }
  if (!cohort) return;
  const envelope = candidate["cohort"] as CohortEffectEnvelopeV1;
  assertCohortEffectEnvelopeV1(envelope);
  const source = candidate["sourceBinding"];
  exactRecord(source, SOURCE_FIELDS);
  if (!SOURCE_FIELDS.every((field) => typeof source[field] === "string" && source[field].length > 0) ||
      typeof source["baseCommit"] !== "string" || !COMMIT.test(source["baseCommit"])) throw new Error("invalid guarded rebase source binding");
  const journals = candidate["journals"];
  if (!Array.isArray(journals) || journals.length === 0) throw new Error("cohort guarded rebase requires an ordered journal bridge");
  let previous = candidate["oldResultCommit"];
  const seen = new Set<string>();
  for (const journal of journals as unknown[]) {
    exactRecord(journal, JOURNAL_FIELDS);
    if (typeof journal["requestDigest"] !== "string" || !DIGEST.test(journal["requestDigest"]) || seen.has(journal["requestDigest"]) ||
        typeof journal["cohortEnvelopeDigest"] !== "string" || !DIGEST.test(journal["cohortEnvelopeDigest"]) ||
        !["oldResultCommit", "ontoCommit", "rebasedStartCommit"].every((field) => typeof journal[field] === "string" && COMMIT.test(journal[field])) ||
        journal["oldResultCommit"] !== previous || !Array.isArray(journal["conflictReceiptDigests"]) ||
        !journal["conflictReceiptDigests"].every((digest: unknown) => typeof digest === "string" && DIGEST.test(digest))) {
      throw new Error("cohort guarded rebase journal chain is not exact and contiguous");
    }
    seen.add(journal["requestDigest"]);
    previous = journal["rebasedStartCommit"];
  }
  const last = journals[journals.length - 1] as Record<string, unknown>;
  if (previous !== candidate["rebasedStartCommit"] || last["requestDigest"] !== candidate["requestDigest"] ||
      last["ontoCommit"] !== candidate["ontoCommit"] || last["cohortEnvelopeDigest"] !== envelope.envelopeDigest) {
    throw new Error("cohort guarded rebase terminal journal is substituted");
  }
}
