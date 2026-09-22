import { describe, expect, test } from "bun:test";
import {
  acquireImplementationCandidateOn,
  enqueueImplementationCandidateOn,
  implementationQueueSubjectsMatch,
  implementationQueueAuthoritiesMatch,
  type ImplementationQueueAuthority,
} from "@cq/config";
import { cohortValueDigestV1 } from "@cq/process-control";
import { cohortQueueFixture } from "./workCohortQueueFixture.js";
import { cohortRoleEnvelope, sealedCohortRoleEnvelope } from "./workCohortRoleFixture.js";

test("historical cohort matching is directional and retains the exact sealed subject [Blackbox-Atomic]", () => {
  const cohort = cohortRoleEnvelope();
  const sealed = sealedCohortRoleEnvelope();
  expect(implementationQueueSubjectsMatch({ cohort }, { cohort: sealed }, true)).toBe(true);
  expect(implementationQueueSubjectsMatch({ cohort: sealed }, { cohort }, true)).toBe(false);
  const { evidenceSubjectDigest: _subjectDigest, ...subject } = sealed.evidenceSubject;
  const changedSubject = { ...subject, sealDigest: "9".repeat(64) };
  const evidenceSubject = {
    ...changedSubject,
    evidenceSubjectDigest: cohortValueDigestV1(changedSubject),
  };
  const { envelopeDigest: _envelopeDigest, ...envelope } = sealed;
  const payload = {
    ...envelope,
    evidenceSubject,
    semanticSubject: evidenceSubject.evidenceSubjectDigest,
  };
  const changed = { ...payload, envelopeDigest: cohortValueDigestV1(payload) };
  expect(implementationQueueSubjectsMatch({ cohort: sealed }, { cohort: changed }, true)).toBe(
    false,
  );
  expect(implementationQueueSubjectsMatch({ cohort, taskId: "T701" }, { cohort }, true)).toBe(
    false,
  );
  expect(implementationQueueSubjectsMatch({ taskId: "T701" }, { cohort }, true)).toBe(false);
  expect(
    implementationQueueAuthoritiesMatch({ cohort, goalRef: "goals:G191" }, { cohort }, false),
  ).toBe(false);
});

for (const backend of ["memory", "sqlite"] as const)
  describe(`${backend} cohort implementation queue [Blackbox-GoodCommunication]`, () => {
    test("snapshots nested receipt authority independently from the enqueue caller", async () => {
      const f = await cohortQueueFixture(backend);
      try {
        const queue = await f.enroll();
        const digest = cohortValueDigestV1(queue.attempt.gitReceipts);
        Reflect.set(f.cohort.memberAuthorities[1]!, "taskRevision", "0".repeat(64));
        expect(cohortValueDigestV1(queue.attempt.gitReceipts)).toBe(digest);
      } finally {
        await f.close();
      }
    });
    test("enrolls and qualifies one complete cohort on the existing queue front without task or goal anchors", async () => {
      const f = await cohortQueueFixture(backend);
      try {
        const queue = await f.enroll();
        expect(queue.attempt.version).toBe(2);
        expect(queue.enrollment.version).toBe(2);
        expect(queue.attempt.cohort).toEqual(f.cohort);
        for (const value of [queue.enrollment, queue.attempt]) {
          expect(Object.hasOwn(value, "taskId")).toBe(false);
          expect(Object.hasOwn(value, "goalRef")).toBe(false);
        }
        expect(await f.enroll()).toEqual(queue);
        const blocked = await acquireImplementationCandidateOn(
          f.backend,
          {
            namespace: f.namespace,
            actor: "trusted-parent",
            partitionKey: queue.partition.partitionKey,
            holderId: "front",
          },
          { now: f.now },
        );
        expect(blocked.state).toBe("blocked");
        await f.qualify();
        const acquired = await acquireImplementationCandidateOn(
          f.backend,
          {
            namespace: f.namespace,
            actor: "trusted-parent",
            partitionKey: queue.partition.partitionKey,
            holderId: "front",
          },
          { now: f.now },
        );
        expect(acquired.state).toBe("leased");
      } finally {
        await f.close();
      }
    });
    test("rejects anchor injection, omitted members and changed current epoch before enrollment", async () => {
      const f = await cohortQueueFixture(backend);
      try {
        const { envelopeDigest: _digest, ...payload } = f.cohort;
        const renewedPayload = { ...payload, executionEpoch: "renewed-epoch" };
        const renewed = { ...renewedPayload, envelopeDigest: cohortValueDigestV1(renewedPayload) };
        const omittedPayload = {
          ...payload,
          memberAuthorities: payload.memberAuthorities.slice(0, 1),
          memberSetDigest: cohortValueDigestV1(payload.memberAuthorities.slice(0, 1)),
        };
        const omitted = { ...omittedPayload, envelopeDigest: cohortValueDigestV1(omittedPayload) };
        for (const authority of [
          { cohort: f.cohort, taskId: "T701" },
          { cohort: renewed },
          { cohort: omitted },
        ]) {
          await expect(
            enqueueImplementationCandidateOn(
              f.backend,
              { ...f.request, authority: authority as ImplementationQueueAuthority },
              { now: f.now },
            ),
          ).rejects.toThrow();
        }
        expect(
          implementationQueueSubjectsMatch({ cohort: f.cohort }, { cohort: renewed }, true),
        ).toBe(true);
        expect(
          implementationQueueSubjectsMatch({ cohort: f.cohort }, { cohort: renewed }, false),
        ).toBe(false);
        expect(implementationQueueSubjectsMatch({}, {}, true)).toBe(false);
      } finally {
        await f.close();
      }
    });
  });
