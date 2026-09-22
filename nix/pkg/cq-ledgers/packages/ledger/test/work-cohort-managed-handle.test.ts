import { expect, test } from "bun:test";
import { managedWorktreeHandlesEqual, validateManagedTaskWorktreeHandle, validateManagedWorktreeHandle,
  type ManagedWorktreeHandleV3 } from "@cq/config";
import { cohortWorktreeIdentityFromEnvelopeV1, createCohortEffectEnvelopeV1 } from "../src/workCohort.js";
import { workCohortStoreFixture } from "./workCohortStoreContract.js";
import { sha256 } from "./workCohortFixture.js";

async function fixture() {
  const f = await workCohortStoreFixture();
  const envelope = (executionEpoch: string) => createCohortEffectEnvelopeV1({ definition: f.definition,
    observation: f.observation, intent: f.pending.intent, evidenceSubject: null, executionEpoch });
  const cohort = cohortWorktreeIdentityFromEnvelopeV1(envelope("epoch:1"));
  const handle: ManagedWorktreeHandleV3 = {
    kind: "cq-managed-worktree-handle", version: 3, token: "opaque-cohort-token",
    worktreeId: "019f2c7a-6b21-7c44-9e10-7a3f5d9b2e08", cohort,
    branch: `implement/cohort-${cohort.candidateIntentDigest}`, repositoryRoot: "/tmp/project",
    absolutePath: "/tmp/project/.claude/worktrees/019f2c7a-6b21-7c44-9e10-7a3f5d9b2e08",
    baseCommit: f.definition.repository.headCommit, createdAt: "2026-09-22T00:00:00.000Z", nonce: "opaque-nonce",
  };
  return { handle, envelope };
}

test("cohort handle has stable all-member identity across epoch renewal [Behavioral-Active Blackbox-Atomic]", async () => {
  const { handle, envelope } = await fixture();
  expect(validateManagedWorktreeHandle(handle, "/tmp/project")).toEqual({ status: "valid", handle });
  expect(Object.hasOwn(handle, "taskId")).toBe(false);
  expect(cohortWorktreeIdentityFromEnvelopeV1(envelope("epoch:2"))).toEqual(handle.cohort);
  expect(managedWorktreeHandlesEqual(handle, structuredClone(handle))).toBe(true);
  expect(validateManagedTaskWorktreeHandle(handle)).toMatchObject({ status: "invalid", reason: "handle-invalid" });
});

test("cohort handle rejects mixed task authority and malformed identity or placement [Behavioral-Active Blackbox-Atomic]", async () => {
  const { handle } = await fixture();
  const variants = [
    { ...handle, taskId: "T1" },
    { ...handle, version: 1 },
    { ...handle, branch: "implement/T1" },
    { ...handle, absolutePath: "/tmp/project/.claude/worktrees/implement-T1" },
    { ...handle, cohort: { ...handle.cohort, executionEpoch: "epoch:1" } },
    { ...handle, cohort: { ...handle.cohort, memberAuthorities: [] } },
    { ...handle, cohort: { ...handle.cohort, memberAuthorities: [handle.cohort.memberAuthorities[0], handle.cohort.memberAuthorities[0]] } },
    { ...handle, cohort: { ...handle.cohort, candidateIntentDigest: "not-a-digest" } },
  ];
  for (const variant of variants) expect(validateManagedWorktreeHandle(variant).status).toBe("invalid");
  expect(managedWorktreeHandlesEqual(handle, { ...handle, cohort: { ...handle.cohort,
    definitionDigest: sha256("other-definition") } })).toBe(false);
  expect(managedWorktreeHandlesEqual(handle, { ...handle, cohort: { ...handle.cohort,
    memberAuthorities: [...handle.cohort.memberAuthorities].reverse() } })).toBe(false);
});
