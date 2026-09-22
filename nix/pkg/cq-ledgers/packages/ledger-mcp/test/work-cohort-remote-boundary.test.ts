import { describe, expect, test } from "bun:test";

import {
  CohortRepositoryExecutorUnavailableError,
  WorkCohortServiceV1,
  createInMemoryWorkCohortStore,
} from "@cq/ledger";
import type { CohortCandidateAttemptV1 } from "@cq/ledger";

describe("work cohort remote repository boundary", () => {
  test("metadata remains readable while enrollment, resume, and effects fail before mutation", async () => {
    const store = createInMemoryWorkCohortStore();
    const service = new WorkCohortServiceV1({ store, executor: null });
    const before = await service.status();

    expect(() =>
      service.enrollCandidate("remote-enrollment", {} as CohortCandidateAttemptV1),
    ).toThrow(CohortRepositoryExecutorUnavailableError);
    expect(() =>
      service.resume({
        definitionDigest: "definition",
        sealDigest: "seal",
        evidenceSubjectDigest: "subject",
        acceptanceMatrixDigest: "matrix",
        environmentDigest: "environment",
        receiptBridgeDigest: "bridge",
      }),
    ).toThrow(CohortRepositoryExecutorUnavailableError);
    expect(() =>
      service.acquireRepositoryEffect({ holderId: "remote", semanticSubject: "candidate" }),
    ).toThrow(CohortRepositoryExecutorUnavailableError);

    const after = await service.status();
    expect(after).toEqual(before);
    expect(after.portable.candidateAttempts).toEqual([]);
    expect(after.runtime.lease).toBeNull();
  });
});
