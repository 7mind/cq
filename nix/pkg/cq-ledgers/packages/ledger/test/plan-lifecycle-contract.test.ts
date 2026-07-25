import { describe, expect, it } from "bun:test";
import {
  PLAN_AUTHORITY_RULES,
  PLAN_FOLLOW_UP_AGGREGATE_PRECEDENCE,
  PLAN_FOLLOW_UP_CLEANUP,
  PLAN_FOLLOW_UP_TASK_DISPOSITION,
  PLAN_LEGACY_ADOPTION,
  PLAN_LIFECYCLE_CONTRACT_VERSION,
  PLAN_MANAGED_MUTATION_OWNERS,
  PLAN_OPERATION_CONTRACTS,
  PLAN_RESEARCH_WAIT_DISPOSITION,
  PLAN_SECRET_FIELD_NAMES,
  PlanClaimInputSchema,
  PlanClaimResultSchema,
  PlanConflictSchema,
  PlanDraftManifestSchema,
  PlanFinalizeAcknowledgementSchema,
  PlanFinalizeInputSchema,
  PlanFinalizeResultSchema,
  PlanPrivateClaimRecordSchema,
  PlanPublicClaimSchema,
  PlanPublishDraftAcknowledgementSchema,
  PlanPublishDraftInputSchema,
  PlanPublishDraftResultSchema,
  PlanReleaseAcknowledgementSchema,
  PlanReleaseInputSchema,
  PlanReleaseResultSchema,
  type PlanLifecycleStore,
} from "../src/index.js";

const ownerFenceToken = "A".repeat(22);
const verifier = "b".repeat(64);

const provenance = {
  author: "gpt-5.6",
  session: "session-1",
} as const;

const operationKey = {
  goalId: "G99",
  claimId: "claim_1",
  generation: 3,
  operationId: "operation_1",
} as const;

const ownerOperation = {
  ...operationKey,
  ownerFenceToken,
  ...provenance,
} as const;

const manifest = {
  milestones: [
    {
      key: "api",
      title: "Implement the API",
    },
  ],
  tasks: [
    {
      key: "contract",
      milestoneKey: "api",
      headline: "Define the contract",
    },
    {
      key: "implementation",
      milestoneKey: "api",
      headline: "Implement the contract",
      dependsOn: [{ kind: "draft-task", key: "contract" }],
    },
  ],
} as const;

const reviewDefects = {
  reviewId: "R852",
  defects: [
    {
      key: "missing_guard",
      headline: "Missing stale-owner guard",
      severity: "high",
    },
    {
      key: "partial_batch",
      headline: "Defect batch can partially persist",
      severity: "medium",
    },
  ],
} as const;

const publishedManifest = {
  revision: 1,
  milestones: [{ key: "api", id: "M360" }],
  tasks: [
    { key: "contract", id: "T846" },
    { key: "implementation", id: "T848" },
  ],
} as const;

const reviewDefectAllocations = [
  { key: "missing_guard", id: "D200" },
  { key: "partial_batch", id: "D201" },
] as const;

describe("guarded plan lifecycle inputs", () => {
  it("accepts first-plan and follow-up claims with caller authority and an explicit CAS", () => {
    expect(
      PlanClaimInputSchema.parse({
        goalId: "G99",
        purpose: "initial",
        claimRequestId: "request_1",
        ownerFenceToken,
        expectedGeneration: null,
        ...provenance,
      }),
    ).toEqual({
      goalId: "G99",
      purpose: "initial",
      claimRequestId: "request_1",
      ownerFenceToken,
      expectedGeneration: null,
      ...provenance,
    });

    expect(
      PlanClaimInputSchema.safeParse({
        goalId: "G99",
        purpose: "follow-up",
        claimRequestId: "request_2",
        ownerFenceToken,
        expectedGeneration: 3,
        ...provenance,
      }).success,
    ).toBe(true);
  });

  it("rejects weak owner tokens and undeclared claim authority fields", () => {
    const base = {
      goalId: "G99",
      purpose: "initial",
      claimRequestId: "request_1",
      expectedGeneration: null,
      ...provenance,
    };

    expect(
      PlanClaimInputSchema.safeParse({
        ...base,
        ownerFenceToken: "too-short",
      }).success,
    ).toBe(false);
    expect(
      PlanClaimInputSchema.safeParse({
        ...base,
        ownerFenceToken,
        expiresAt: "2026-07-25T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("requires a complete, internally referentially valid draft manifest", () => {
    expect(PlanDraftManifestSchema.safeParse(manifest).success).toBe(true);

    expect(
      PlanDraftManifestSchema.safeParse({
        milestones: manifest.milestones,
        tasks: [
          {
            key: "orphan",
            milestoneKey: "missing",
            headline: "Cannot be placed",
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      PlanDraftManifestSchema.safeParse({
        milestones: manifest.milestones,
        tasks: [
          manifest.tasks[0],
          {
            ...manifest.tasks[1],
            key: "contract",
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      PlanDraftManifestSchema.safeParse({
        milestones: manifest.milestones,
        tasks: [
          {
            ...manifest.tasks[0],
            dependsOn: [{ kind: "draft-task", key: "missing" }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("scopes publish idempotency to claim, generation, operation, and operation id", () => {
    const input = {
      ...ownerOperation,
      manifest,
      reviewDefects,
    };
    expect(PlanPublishDraftInputSchema.safeParse(input).success).toBe(true);

    const { operationId: _operationId, ...missingOperationId } = input;
    expect(PlanPublishDraftInputSchema.safeParse(missingOperationId).success).toBe(false);
  });

  it("accepts atomic question and research pauses, plus exact public abandonment", () => {
    expect(
      PlanReleaseInputSchema.safeParse({
        kind: "pause",
        ...ownerOperation,
        effect: {
          kind: "questions",
          questions: [
            {
              key: "choice",
              question: "Which compatibility policy should apply?",
              recommendation: "Additive",
            },
          ],
        },
        reviewDefects,
      }).success,
    ).toBe(true);

    expect(
      PlanReleaseInputSchema.safeParse({
        kind: "pause",
        ...ownerOperation,
        effect: {
          kind: "researches",
          researches: [
            {
              key: "probe",
              question: "Does the upstream API preserve ordering?",
            },
          ],
        },
      }).success,
    ).toBe(true);

    const abandon = {
      kind: "abandon",
      ...operationKey,
      reason: "original claimant lost its response",
      ...provenance,
    } as const;
    expect(PlanReleaseInputSchema.safeParse(abandon).success).toBe(true);
    expect(
      PlanReleaseInputSchema.safeParse({
        ...abandon,
        ownerFenceToken,
      }).success,
    ).toBe(false);
    expect(
      PlanReleaseInputSchema.safeParse({
        ...abandon,
        reviewDefects,
      }).success,
    ).toBe(false);
  });

  it("requires exact owner authority and review identity for finalization", () => {
    expect(
      PlanFinalizeInputSchema.safeParse({
        ...ownerOperation,
        reviewId: "R852",
        decision: {
          headline: "Approve generation 3",
          rationale: "The exact published manifest passed review.",
        },
        reviewDefects,
      }).success,
    ).toBe(true);

    expect(
      PlanFinalizeInputSchema.safeParse({
        ...operationKey,
        reviewId: "R852",
        decision: { headline: "Missing owner token" },
        ...provenance,
      }).success,
    ).toBe(false);
    expect(
      PlanFinalizeInputSchema.safeParse({
        ...ownerOperation,
        reviewId: "R900",
        decision: { headline: "Mismatched review batch" },
        reviewDefects,
      }).success,
    ).toBe(false);
  });
});

describe("authority persistence and observer redaction", () => {
  it("persists a SHA-256 verifier and never accepts the plaintext token in private state", () => {
    const record = {
      goalId: "G99",
      claimId: "claim_1",
      generation: 3,
      purpose: "initial",
      claimRequestId: "request_1",
      ownerFenceTokenVerifier: verifier,
      priorGeneration: 2,
      state: "active",
    } as const;

    expect(PlanPrivateClaimRecordSchema.safeParse(record).success).toBe(true);
    expect(
      PlanPrivateClaimRecordSchema.safeParse({
        ...record,
        ownerFenceToken,
      }).success,
    ).toBe(false);
    expect(
      PlanPrivateClaimRecordSchema.safeParse({
        ...record,
        ownerFenceTokenVerifier: verifier.toUpperCase(),
      }).success,
    ).toBe(false);
  });

  it("keeps public claims and structured conflicts free of token material", () => {
    const publicClaim = {
      goalId: "G99",
      claimId: "claim_1",
      generation: 3,
      purpose: "initial",
    } as const;
    expect(PlanPublicClaimSchema.safeParse(publicClaim).success).toBe(true);
    expect(
      PlanPublicClaimSchema.safeParse({
        ...publicClaim,
        ownerFenceToken,
      }).success,
    ).toBe(false);

    const conflict = {
      code: "owner-fence-mismatch",
      goalId: "G99",
      claimId: "claim_1",
      generation: 3,
    } as const;
    expect(PlanConflictSchema.safeParse(conflict).success).toBe(true);
    expect(
      PlanConflictSchema.safeParse({
        ...conflict,
        ownerFenceToken,
      }).success,
    ).toBe(false);
    expect(PLAN_SECRET_FIELD_NAMES).toEqual(["ownerFenceToken", "ownerFenceTokenVerifier"]);
  });

  it("allows the caller-known token only on a winning or exact-retry claim acknowledgement", () => {
    const claimResult = {
      ok: true,
      replayed: true,
      acknowledgement: {
        goalId: "G99",
        claimId: "claim_1",
        generation: 3,
        purpose: "initial",
        claimRequestId: "request_1",
        ownerFenceToken,
        legacyAdopted: false,
        adoptedManifest: {
          milestoneIds: [],
          taskIds: [],
        },
        waitingResearches: [],
      },
    } as const;

    expect(JSON.stringify(PlanClaimResultSchema.parse(claimResult))).toBe(
      JSON.stringify(claimResult),
    );

    const leaked = {
      ...operationKey,
      manifest: publishedManifest,
      replacedManifest: null,
      reviewDefects: reviewDefectAllocations,
      ownerFenceToken,
    };
    expect(PlanPublishDraftAcknowledgementSchema.safeParse(leaked).success).toBe(false);
    expect(
      PlanFinalizeAcknowledgementSchema.safeParse({
        ...operationKey,
        reviewId: "R852",
        decisionId: "K143",
        manifest: publishedManifest,
        reviewDefects: reviewDefectAllocations,
        goalPhase: "planned",
        ownerFenceToken,
      }).success,
    ).toBe(false);
  });
});

describe("atomic acknowledgements and exact replay", () => {
  it("records complete draft and multi-defect allocations in one replayable result", () => {
    const result = {
      ok: true,
      replayed: false,
      acknowledgement: {
        ...operationKey,
        manifest: publishedManifest,
        replacedManifest: null,
        reviewDefects: reviewDefectAllocations,
      },
    } as const;

    expect(JSON.stringify(PlanPublishDraftResultSchema.parse(result))).toBe(JSON.stringify(result));
    const replayed = PlanPublishDraftResultSchema.parse({
      ...result,
      replayed: true,
    });
    if (!replayed.ok) throw new Error("expected successful replay");
    expect(JSON.stringify(replayed.acknowledgement)).toBe(JSON.stringify(result.acknowledgement));
  });

  it("records exact question allocations with the clarifying phase transition", () => {
    const acknowledgement = {
      kind: "questions",
      ...operationKey,
      reviewDefects: reviewDefectAllocations,
      questions: [
        { key: "compatibility", id: "Q300" },
        { key: "migration", id: "Q301" },
      ],
      researches: [],
      waitingResearches: [],
      goalPhase: "clarifying",
    } as const;

    expect(JSON.stringify(PlanReleaseAcknowledgementSchema.parse(acknowledgement))).toBe(
      JSON.stringify(acknowledgement),
    );
  });

  it("requires research pause acknowledgement ids to exactly equal the wait set", () => {
    const acknowledgement = {
      kind: "researches",
      ...operationKey,
      reviewDefects: reviewDefectAllocations,
      questions: [],
      researches: [
        { key: "ordering", id: "RS8" },
        { key: "recovery", id: "RS9" },
      ],
      waitingResearches: ["RS8", "RS9"],
      goalPhase: "planning",
    } as const;

    expect(JSON.stringify(PlanReleaseAcknowledgementSchema.parse(acknowledgement))).toBe(
      JSON.stringify(acknowledgement),
    );
    expect(
      PlanReleaseAcknowledgementSchema.safeParse({
        ...acknowledgement,
        waitingResearches: ["RS8"],
      }).success,
    ).toBe(false);

    const result = {
      ok: true,
      replayed: true,
      acknowledgement,
    } as const;
    expect(JSON.stringify(PlanReleaseResultSchema.parse(result))).toBe(JSON.stringify(result));
  });

  it("records the exact approved review, decision, manifest, and defect batch", () => {
    const acknowledgement = {
      ...operationKey,
      reviewId: "R852",
      decisionId: "K143",
      manifest: publishedManifest,
      reviewDefects: reviewDefectAllocations,
      goalPhase: "planned",
    } as const;
    const result = {
      ok: true,
      replayed: false,
      acknowledgement,
    } as const;

    expect(JSON.stringify(PlanFinalizeResultSchema.parse(result))).toBe(JSON.stringify(result));
    const replayed = PlanFinalizeResultSchema.parse({
      ...result,
      replayed: true,
    });
    if (!replayed.ok) throw new Error("expected successful replay");
    expect(JSON.stringify(replayed.acknowledgement)).toBe(JSON.stringify(acknowledgement));
  });

  it("keeps conflict results side-effect-free and structurally closed", () => {
    const result = {
      ok: false,
      conflict: {
        code: "implementation-active",
        goalId: "G99",
        tasks: [
          { taskId: "T900", status: "wip" },
          { taskId: "T901", status: "blocked" },
        ],
      },
    } as const;

    expect(JSON.stringify(PlanClaimResultSchema.parse(result))).toBe(JSON.stringify(result));
    expect(
      PlanPublishDraftResultSchema.safeParse({
        ...result,
      }).success,
    ).toBe(false);
    expect(
      PlanClaimResultSchema.safeParse({
        ...result,
        partialWrites: ["T902"],
      }).success,
    ).toBe(false);
  });
});

describe("executable lifecycle semantics", () => {
  it("defines the total research wait table and clears/replaces the set at guarded boundaries", () => {
    expect(PLAN_RESEARCH_WAIT_DISPOSITION).toEqual({
      open: "suppress",
      wip: "suppress",
      inconclusive: "suppress",
      concluded: "resume",
      abandoned: "resume",
      missing: "resume",
      archived: "resume",
    });
    expect(PLAN_OPERATION_CONTRACTS.claim.postconditions).toContain("waiting-researches-cleared");
    expect(PLAN_OPERATION_CONTRACTS.release.postconditions).toContain(
      "researches-create-exact-items-and-replace-waiting-researches",
    );
  });

  it("defines planned dependency-blocked replacement and actual wip/blocked rejection", () => {
    expect(PLAN_FOLLOW_UP_TASK_DISPOSITION).toEqual({
      planned: "replace",
      wip: "reject-implementation-active",
      blocked: "reject-implementation-active",
      done: "drained",
      abandoned: "drained",
    });
    expect(PLAN_FOLLOW_UP_AGGREGATE_PRECEDENCE).toEqual([
      "reject-implementation-active",
      "replace",
      "drained",
    ]);
    expect(PLAN_FOLLOW_UP_CLEANUP).toEqual({
      plannedTasks: "transition-to-abandoned",
      milestones: "transition-to-postponed",
      dependencyRefs: "remove-if-owned-only-by-superseded-work",
      backlinks: "remove-if-owned-only-by-superseded-work",
      openQuestions: "withdraw-if-owned-only-by-superseded-work",
      activeTasks: "reject-without-mutation",
    });
  });

  it("adopts only the declared legacy manifest and preserves additive compatibility", () => {
    expect(PLAN_LEGACY_ADOPTION).toEqual({
      metadataAbsentExpectedGeneration: null,
      baselineGeneration: "absent",
      firstAllocatedGeneration: 1,
      milestoneSource: "goal.milestones-only",
      taskSource: "tasks-under-declared-milestones-only",
      goalRefOrphans: "ignore",
      missingOptionalMetadata: "compatible",
    });
  });

  it("makes claim authority recoverable without clocks, digests, or a coordinator", () => {
    expect(PLAN_AUTHORITY_RULES).toEqual({
      ownerTokenInput: "caller-generated-random-base64url-at-least-128-bits",
      ownerTokenPersistence: "sha256-verifier-only",
      ownerTokenEcho: "winning-or-exact-claim-retry-channel-only",
      observerExposure: "never",
      claimRequestScope: ["goalId", "claimRequestId"],
      operationScope: ["claimId", "generation", "operation", "operationId"],
      exactReplay: "return-recorded-acknowledgement-and-side-effect-ids",
      changedClaimReplayPayload: "claim-request-reused",
      changedOperationReplayPayload: "idempotency-key-reused",
      expiry: "none",
      heartbeat: "none",
      digestAuthority: "none",
      coordinator: "none",
      abandonmentAuthority: "exact-public-claim-id-and-generation",
    });
  });

  it("assigns every managed state family to guarded mutations and rejects raw bypass", () => {
    expect(PLAN_MANAGED_MUTATION_OWNERS).toEqual({
      activeClaim: ["claim", "release", "finalize"],
      generation: ["claim"],
      draft: ["publish-draft"],
      waitingResearches: ["claim", "release"],
      goalPhase: ["claim", "release", "finalize"],
      finalizedManifest: ["finalize"],
      followUpCleanup: ["claim"],
      reviewDefects: ["publish-draft", "release-pause", "finalize"],
      rawCrud: "reject-managed-plan-fields-and-transitions",
    });
  });

  it("closes the four-operation pre/postcondition and structured-conflict surface", () => {
    expect(PLAN_LIFECYCLE_CONTRACT_VERSION).toBe(1);
    expect(Object.keys(PLAN_OPERATION_CONTRACTS)).toEqual([
      "claim",
      "publish-draft",
      "release",
      "finalize",
    ]);
    expect(PLAN_OPERATION_CONTRACTS.finalize.preconditions).toEqual([
      "exact-active-owner-authority",
      "complete-current-draft-exists",
      "review-exists-is-go-ahead-and-matches-claim-generation",
    ]);
    expect(PLAN_OPERATION_CONTRACTS.finalize.postconditions).toContain(
      "only-finalized-current-manifest-is-executable",
    );

    const declaredConflicts = new Set(
      Object.values(PLAN_OPERATION_CONTRACTS).flatMap(({ conflicts }) => conflicts),
    );
    expect([...declaredConflicts].sort() as string[]).toEqual(
      [
        "claim-active",
        "claim-not-active",
        "claim-request-reused",
        "draft-not-found",
        "goal-not-found",
        "goal-phase-conflict",
        "goal-terminal",
        "idempotency-key-reused",
        "implementation-active",
        "owner-fence-mismatch",
        "research-wait-active",
        "review-generation-mismatch",
        "review-not-approved",
        "review-not-found",
        "stale-claim",
        "stale-generation",
      ].sort(),
    );
  });

  it("publishes the four-method capability without changing LedgerStore yet", () => {
    const methodNames: readonly (keyof PlanLifecycleStore)[] = [
      "claimPlan",
      "publishPlanDraft",
      "releasePlanClaim",
      "finalizePlan",
    ];

    expect(methodNames).toEqual([
      "claimPlan",
      "publishPlanDraft",
      "releasePlanClaim",
      "finalizePlan",
    ]);
  });
});
