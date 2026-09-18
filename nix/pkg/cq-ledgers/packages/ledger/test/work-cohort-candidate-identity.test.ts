import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "bun:test";

import {
  InMemoryAttestationStore,
  type AttestationEnvelope,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationStore,
} from "@cq/config";

import {
  CohortCandidateSealConflictError,
  G213CandidateAuthenticatorV1,
  GitG213CandidateRepositoryV1,
  InMemoryCohortCandidateSealStoreV1,
  assertCohortLiveEffectCurrentV1,
  bindCohortLiveEffectV1,
  constructCohortDecisionsV1,
  createCohortDefinitionIdentityV1,
  createCohortEffectEnvelopeV1,
  createCohortEvidenceReceiptV1,
  createCohortEvidenceSubjectV1,
  createPendingCohortCandidateAttemptV1,
  isCohortEvidenceReceiptReusableV1,
  type CohortGitChangeReceiptV1,
  type CohortWholeDiffEntryV1,
  type G213CandidateRepositoryV1,
  type G213QualifiedCandidateRowV1,
} from "../src/workCohort.js";
import { commit, observationFor, qualifiedQueue, receipt, sha256 } from "./workCohortFixture.js";

const execFileAsync = promisify(execFile);

const candidateNamespace: AttestationNamespace = Object.freeze({
  backend: "xdg",
  projectKey: "cohort-candidate-test",
});

type CandidateAttestationStore = Pick<AttestationStore, "namespace" | "read">;

class ManualCandidateAttestationStore implements CandidateAttestationStore {
  readonly namespace = candidateNamespace;
  readonly #rows = new Map<string, AttestationRow>();

  constructor(rows: readonly AttestationRow[]) {
    for (const row of rows) {
      this.#rows.set(`${row.attestationId}#${String(row.generation)}`, row);
    }
  }

  read(handle: { readonly attestationId: string; readonly generation: number }) {
    return this.#rows.get(`${handle.attestationId}#${String(handle.generation)}`);
  }
}

const candidateStoreCases = [
  {
    name: "reference attestation adapter",
    create: (rows: readonly AttestationRow[]): CandidateAttestationStore =>
      InMemoryAttestationStore.rehydrate(candidateNamespace, rows),
  },
  {
    name: "manual attestation dummy",
    create: (rows: readonly AttestationRow[]): CandidateAttestationStore =>
      new ManualCandidateAttestationStore(rows),
  },
] as const;

interface CandidateEnvelopeInput {
  readonly dispatch: {
    readonly attestationId: string;
    readonly generation: number;
    readonly taskId: string;
    readonly branch: string;
    readonly startingCommit: string;
  };
  readonly result: string;
  readonly tree: string;
  readonly receipts: readonly CohortGitChangeReceiptV1[];
  readonly repositoryDiff: readonly CohortWholeDiffEntryV1[];
  readonly attempt?: string;
  readonly outputFilesTouched?: readonly string[];
}

function candidateEnvelope(input: CandidateEnvelopeInput) {
  const gitEffectBinding = {
    taskId: input.dispatch.taskId,
    handleToken: "worktree-token",
    handleFingerprint: sha256("worktree-fingerprint"),
    repositoryRoot: "/repo",
    repositoryId: "repository:test",
    commonDir: "/repo/.git",
    worktreePath: "/repo/.claude/worktrees/test",
    branch: input.dispatch.branch,
    ref: `refs/heads/${input.dispatch.branch}`,
    baseCommit: input.dispatch.startingCommit,
  };
  const queue = qualifiedQueue({
    taskId: input.dispatch.taskId,
    base: input.dispatch.startingCommit,
    result: input.result,
    tree: input.tree,
    receipts: input.receipts,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    managedWorktreeBindingDigest: sha256(gitEffectBinding),
  });
  const row = {
    kind: "envelope",
    namespace: candidateNamespace,
    attestationId: input.dispatch.attestationId,
    generation: input.dispatch.generation,
    state: "gate-pending",
    promptProvenance: {
      roleId: "implement-worker",
      version: 10,
      promptDigest: sha256("prompt"),
      inputDigest: sha256("input"),
    },
    expectedChild: { childId: "child", runId: "run" },
    input: {
      baseCommit: input.dispatch.startingCommit,
      startingCommit: input.dispatch.startingCommit,
    },
    gateSubmittedOutputDigest: queue.qualification?.outputDigest,
    gitEffectBinding,
    implementationQueue: queue,
    stagedCompletionQualification: queue.qualification,
    output: {
      taskId: input.dispatch.taskId,
      branch: input.dispatch.branch,
      resultCommit: input.result,
      gitReceipts: input.receipts,
      filesTouched:
        input.outputFilesTouched ?? input.repositoryDiff.map((entry) => entry.path),
    },
  } as unknown as AttestationEnvelope;
  return { queue, row };
}

async function authenticatedCandidateRow(input: {
  readonly dispatch: {
    readonly attestationId: string;
    readonly generation: number;
    readonly taskId: string;
    readonly branch: string;
    readonly startingCommit: string;
  };
  readonly result: string;
  readonly tree: string;
  readonly receipts: readonly CohortGitChangeReceiptV1[];
  readonly repositoryDiff: readonly CohortWholeDiffEntryV1[];
  readonly attempt?: string;
  readonly outputFilesTouched?: readonly string[];
  readonly repository?: G213CandidateRepositoryV1;
  readonly storeFactory?: (row: AttestationEnvelope) => CandidateAttestationStore;
  readonly observeSourceRow?: (row: AttestationEnvelope) => void;
}) {
  const candidate = candidateEnvelope({
    dispatch: input.dispatch,
    result: input.result,
    tree: input.tree,
    receipts: input.receipts,
    repositoryDiff: input.repositoryDiff,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.outputFilesTouched === undefined
      ? {}
      : { outputFilesTouched: input.outputFilesTouched }),
  });
  input.observeSourceRow?.(candidate.row);
  const store =
    input.storeFactory?.(candidate.row) ?? candidateStoreCases[0].create([candidate.row]);
  const authenticator = new G213CandidateAuthenticatorV1({
    store,
    repository:
      input.repository ??
      ({ resolveWholeDiff: async () => input.repositoryDiff } satisfies G213CandidateRepositoryV1),
  });
  const authenticated = await authenticator.resolve({
    attestationId: input.dispatch.attestationId,
    generation: input.dispatch.generation,
  });
  return { authenticator, queue: candidate.queue, row: authenticated, sourceRow: candidate.row };
}

function substitutePersistedCandidateResult(
  row: AttestationEnvelope,
  input: { readonly resultCommit: string; readonly resultTree: string },
): void {
  const mutable = row as unknown as {
    implementationQueue: {
      attempt: { resultCommit: string; resultTree: string };
    };
    output: { resultCommit: string };
  };
  mutable.implementationQueue.attempt.resultCommit = input.resultCommit;
  mutable.implementationQueue.attempt.resultTree = input.resultTree;
  mutable.output.resultCommit = input.resultCommit;
}

async function identityFixture() {
  const observation = await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }]);
  const decision = constructCohortDecisionsV1(observation)[0]!;
  const definition = createCohortDefinitionIdentityV1({
    cohortId: "cohort:test",
    decision,
    observation,
    prior: null,
  });
  const dispatch = {
    attestationId: "att-test",
    generation: 1,
    taskId: "T-test",
    branch: "implement/T-test",
    startingCommit: commit("base"),
  };
  const base = dispatch.startingCommit;
  const result = commit("result");
  const tree = commit("result-tree");
  const receipts = [receipt({ base, result, tree })];
  const pending = createPendingCohortCandidateAttemptV1(definition, dispatch);
  const repositoryDiff = [
    { path: "src/result.ts", mode: "100644" as const, blobDigest: sha256("result blob") },
  ];
  const authenticated = await authenticatedCandidateRow({
    dispatch,
    result,
    tree,
    receipts,
    repositoryDiff,
  });
  const queue = authenticated.queue;
  const row = authenticated.row;
  const staged = authenticated.authenticator.stage(pending, { row });
  return {
    observation,
    decision,
    definition,
    dispatch,
    base,
    result,
    tree,
    receipts,
    pending,
    authenticator: authenticated.authenticator,
    queue,
    row,
    sourceRow: authenticated.sourceRow,
    staged,
  };
}

describe("cohort candidate identity", () => {
  for (const storeCase of candidateStoreCases) {
    test(`resolves only a live qualified row through the ${storeCase.name}`, async () => {
      const fixture = await identityFixture();
      const repository = {
        resolveWholeDiff: async () => fixture.row.repositoryDiff,
      } satisfies G213CandidateRepositoryV1;
      const authenticator = new G213CandidateAuthenticatorV1({
        store: storeCase.create([fixture.sourceRow]),
        repository,
      });
      const resolved = await authenticator.resolve({
        attestationId: fixture.dispatch.attestationId,
        generation: fixture.dispatch.generation,
      });
      const staged = authenticator.stage(fixture.pending, { row: resolved });
      expect(staged.g213.attemptId).toBe(fixture.queue.attempt.attemptId);

      await expect(
        authenticator.resolve({ attestationId: "att-unknown", generation: 1 }),
      ).rejects.toThrow("trusted attestation store");
      await expect(
        authenticator.resolve({
          attestationId: fixture.dispatch.attestationId,
          generation: fixture.dispatch.generation + 1,
        }),
      ).rejects.toThrow("trusted attestation store");

      const stale = { ...fixture.sourceRow, state: "consumed" } as AttestationEnvelope;
      const staleAuthenticator = new G213CandidateAuthenticatorV1({
        store: storeCase.create([stale]),
        repository,
      });
      await expect(
        staleAuthenticator.resolve({
          attestationId: fixture.dispatch.attestationId,
          generation: fixture.dispatch.generation,
        }),
      ).rejects.toThrow("stale G213 candidate");

      const unqualified = {
        ...fixture.sourceRow,
        implementationQueue: {
          ...fixture.sourceRow.implementationQueue!,
          state: "enqueued",
          qualification: undefined,
        },
      } as unknown as AttestationEnvelope;
      const unqualifiedAuthenticator = new G213CandidateAuthenticatorV1({
        store: storeCase.create([unqualified]),
        repository,
      });
      await expect(
        unqualifiedAuthenticator.resolve({
          attestationId: fixture.dispatch.attestationId,
          generation: fixture.dispatch.generation,
        }),
      ).rejects.toThrow("qualified managed implement-worker");

      const foreignBinding = {
        ...fixture.sourceRow,
        gitEffectBinding: {
          ...fixture.sourceRow.gitEffectBinding!,
          repositoryId: "repository:foreign",
        },
      } as AttestationEnvelope;
      const foreignBindingAuthenticator = new G213CandidateAuthenticatorV1({
        store: storeCase.create([foreignBinding]),
        repository,
      });
      await expect(
        foreignBindingAuthenticator.resolve({
          attestationId: fixture.dispatch.attestationId,
          generation: fixture.dispatch.generation,
        }),
      ).rejects.toThrow("identity or qualification is inconsistent");
    });
  }

  test("rejects a trusted-store lookup that substitutes another handle", async () => {
    const fixture = await identityFixture();
    const foreign = candidateEnvelope({
      dispatch: { ...fixture.dispatch, attestationId: "att-foreign", generation: 2 },
      result: fixture.result,
      tree: fixture.tree,
      receipts: fixture.receipts,
      repositoryDiff: fixture.row.repositoryDiff,
    });
    const authenticator = new G213CandidateAuthenticatorV1({
      store: {
        namespace: candidateNamespace,
        read: () => foreign.row,
      },
      repository: { resolveWholeDiff: async () => fixture.row.repositoryDiff },
    });

    await expect(
      authenticator.resolve({
        attestationId: fixture.dispatch.attestationId,
        generation: fixture.dispatch.generation,
      }),
    ).rejects.toThrow("different G213 handle");
  });

  test("seals one G213 attempt atomically without advancing definition generation", async () => {
    const fixture = await identityFixture();
    const store = new InMemoryCohortCandidateSealStoreV1();
    const request = {
      definition: fixture.definition,
      attempt: fixture.staged,
      baseCommit: fixture.base,
      resultCommit: fixture.result,
      resultTree: fixture.tree,
      wholeDiff: [
        { path: "src/result.ts", mode: "100644" as const, blobDigest: sha256("result blob") },
      ],
      gitReceipts: fixture.receipts,
    };
    const first = store.seal(request);
    const replay = store.seal(request);

    expect(first.state).toBe("sealed");
    expect(replay.state).toBe("existing");
    expect(replay.seal).toEqual(first.seal);
    expect(fixture.definition.definitionGeneration).toBe(1);
  });

  test("rejects altered seal closure, base, result tree, and whole diff", async () => {
    const fixture = await identityFixture();
    const store = new InMemoryCohortCandidateSealStoreV1();
    const request = {
      definition: fixture.definition,
      attempt: fixture.staged,
      baseCommit: fixture.base,
      resultCommit: fixture.result,
      resultTree: fixture.tree,
      wholeDiff: [
        { path: "src/result.ts", mode: "100644" as const, blobDigest: sha256("result blob") },
      ],
      gitReceipts: fixture.receipts,
    };
    store.seal(request);

    expect(() => store.seal({ ...request, baseCommit: commit("other-base") })).toThrow(
      CohortCandidateSealConflictError,
    );
    expect(() =>
      store.seal({
        ...request,
        wholeDiff: [{ ...request.wholeDiff[0]!, blobDigest: sha256("altered") }],
      }),
    ).toThrow(CohortCandidateSealConflictError);
    expect(() => store.seal({ ...request, resultTree: commit("other-tree") })).toThrow(
      CohortCandidateSealConflictError,
    );
    expect(() => store.seal({ ...request, gitReceipts: [] })).toThrow(
      CohortCandidateSealConflictError,
    );
  });

  test("unchanged restart preserves semantic bytes, renews epoch, and reuses receipts", async () => {
    const fixture = await identityFixture();
    const sameDefinition = createCohortDefinitionIdentityV1({
      cohortId: fixture.definition.cohortId,
      decision: fixture.decision,
      observation: fixture.observation,
      prior: fixture.definition,
    });
    const seal = new InMemoryCohortCandidateSealStoreV1().seal({
      definition: fixture.definition,
      attempt: fixture.staged,
      baseCommit: fixture.base,
      resultCommit: fixture.result,
      resultTree: fixture.tree,
      wholeDiff: [
        { path: "src/result.ts", mode: "100644", blobDigest: sha256("result blob") },
      ],
      gitReceipts: fixture.receipts,
    }).seal;
    const subject = createCohortEvidenceSubjectV1(fixture.definition, seal);
    const firstEnvelope = createCohortEffectEnvelopeV1({
      definition: fixture.definition,
      attempt: fixture.staged,
      evidenceSubject: subject,
      executionEpoch: "epoch:1",
    });
    const priorHolder = bindCohortLiveEffectV1(firstEnvelope, "gate-holder");
    const receipt = createCohortEvidenceReceiptV1({
      evidenceSubject: subject,
      definition: fixture.definition,
      authorizingExecutionEpoch: "epoch:1",
    });
    const restarted = createCohortEffectEnvelopeV1({
      definition: sameDefinition,
      attempt: fixture.staged,
      evidenceSubject: subject,
      executionEpoch: "epoch:2",
    });

    expect(sameDefinition).toBe(fixture.definition);
    expect(() => assertCohortLiveEffectCurrentV1(restarted, priorHolder)).toThrow(
      "fenced by another semantic subject or execution epoch",
    );
    expect(
      isCohortEvidenceReceiptReusableV1({
        receipt,
        evidenceSubject: subject,
        definition: sameDefinition,
      }),
    ).toBe(true);
  });

  test("changed candidate creates a new seal and subject while retaining prior lineage", async () => {
    const fixture = await identityFixture();
    const store = new InMemoryCohortCandidateSealStoreV1();
    const firstSeal = store.seal({
      definition: fixture.definition,
      attempt: fixture.staged,
      baseCommit: fixture.base,
      resultCommit: fixture.result,
      resultTree: fixture.tree,
      wholeDiff: [
        { path: "src/result.ts", mode: "100644", blobDigest: sha256("result blob") },
      ],
      gitReceipts: fixture.receipts,
    }).seal;
    const nextResult = commit("next-result");
    const nextTree = commit("next-tree");
    const nextReceipts = [receipt({ base: fixture.base, result: nextResult, tree: nextTree, operation: "next" })];
    const nextDispatch = { ...fixture.dispatch, generation: 2 };
    const nextRepositoryDiff = [
      { path: "src/result.ts", mode: "100644" as const, blobDigest: sha256("two") },
    ];
    const nextAuthenticated = await authenticatedCandidateRow({
      dispatch: nextDispatch,
      result: nextResult,
      tree: nextTree,
      receipts: nextReceipts,
      repositoryDiff: nextRepositoryDiff,
      attempt: "attempt:next",
    });
    const nextPending = createPendingCohortCandidateAttemptV1(fixture.definition, nextDispatch);
    const nextAttempt = nextAuthenticated.authenticator.stage(nextPending, {
      row: nextAuthenticated.row,
    });
    const nextSeal = store.seal({
      definition: fixture.definition,
      attempt: nextAttempt,
      baseCommit: fixture.base,
      resultCommit: nextResult,
      resultTree: nextTree,
      wholeDiff: [
        { path: "src/result.ts", mode: "100644", blobDigest: sha256("two") },
      ],
      gitReceipts: nextReceipts,
    }).seal;
    const firstSubject = createCohortEvidenceSubjectV1(fixture.definition, firstSeal);
    const nextSubject = createCohortEvidenceSubjectV1(fixture.definition, nextSeal);

    expect(nextSubject.evidenceSubjectDigest).not.toBe(firstSubject.evidenceSubjectDigest);
    expect(store.read(fixture.staged.candidateAttemptDigest)).toEqual(firstSeal);
  });

  test("cannot substitute a dispatch or allocate an independent G213 identity", async () => {
    const fixture = await identityFixture();
    const other = await authenticatedCandidateRow({
      dispatch: { ...fixture.dispatch, generation: 2 },
      result: fixture.result,
      tree: fixture.tree,
      receipts: fixture.receipts,
      repositoryDiff: fixture.row.repositoryDiff,
    });
    expect(() =>
      fixture.authenticator.stage(fixture.pending, {
        row: other.row,
      }),
    ).toThrow("actual G213 row");
  });

  test("cannot stage a caller-allocated G213 row shape", async () => {
    const fixture = await identityFixture();
    const callerAllocated = {
      preparedDispatch: fixture.row.preparedDispatch,
      queue: fixture.row.queue,
      repositoryDiff: fixture.row.repositoryDiff,
    } as unknown as G213QualifiedCandidateRowV1;
    expect(() =>
      fixture.authenticator.stage(fixture.pending, { row: callerAllocated }),
    ).toThrow("actual G213 row");
  });

  test("rejects a fabricated candidate passed through caller-controlled resolution", async () => {
    const fixture = await identityFixture();
    const forgedResult = commit("caller-resolved-result");
    const forgedTree = commit("caller-resolved-tree");
    const forgedReceipts = [
      receipt({
        base: fixture.base,
        result: forgedResult,
        tree: forgedTree,
        operation: "caller-resolved",
      }),
    ];
    const fabricated = candidateEnvelope({
      dispatch: fixture.dispatch,
      result: forgedResult,
      tree: forgedTree,
      receipts: forgedReceipts,
      repositoryDiff: [
        { path: "src/forged.ts", mode: "100644", blobDigest: sha256("forged blob") },
      ],
      attempt: "attempt:caller-resolved",
    });
    const resolved = await fixture.authenticator.resolve({
      attestationId: fixture.dispatch.attestationId,
      generation: fixture.dispatch.generation,
      row: fabricated.row,
      repository: {
        resolveWholeDiff: async () => fabricated.row.output,
      },
    } as unknown as { readonly attestationId: string; readonly generation: number });
    const staged = fixture.authenticator.stage(fixture.pending, { row: resolved });

    expect(staged.g213.resultCommit).toBe(fixture.result);
    expect(staged.g213.resultTree).toBe(fixture.tree);
    expect(staged.g213.attemptId).toBe(fixture.queue.attempt.attemptId);
    expect(staged.g213.resultCommit).not.toBe(forgedResult);
  });

  test("rejects spread and descriptor clones of an authenticated G213 row", async () => {
    const fixture = await identityFixture();
    const replacementResult = commit("replacement-result");
    const replacementTree = commit("replacement-tree");
    const replacementReceipts = [
      receipt({
        base: fixture.base,
        result: replacementResult,
        tree: replacementTree,
        operation: "replacement",
      }),
    ];
    const replacement = await authenticatedCandidateRow({
      dispatch: fixture.dispatch,
      result: replacementResult,
      tree: replacementTree,
      receipts: replacementReceipts,
      repositoryDiff: [
        { path: "src/result.ts", mode: "100644", blobDigest: sha256("replacement blob") },
      ],
      attempt: "attempt:replacement",
    });
    const spreadClone = {
      ...fixture.row,
      queue: replacement.row.queue,
      repositoryDiff: replacement.row.repositoryDiff,
    } as G213QualifiedCandidateRowV1;
    const descriptorClone = Object.create(
      Object.getPrototypeOf(fixture.row) as object,
      Object.getOwnPropertyDescriptors(fixture.row),
    ) as G213QualifiedCandidateRowV1;

    expect(() =>
      fixture.authenticator.stage(fixture.pending, { row: spreadClone }),
    ).toThrow("actual G213 row");
    expect(() =>
      fixture.authenticator.stage(fixture.pending, { row: descriptorClone }),
    ).toThrow("actual G213 row");
  });

  test("retains an immutable candidate snapshot without freezing the persisted row", async () => {
    const fixture = await identityFixture();
    const forgedResult = commit("post-authentication-result");
    const forgedTree = commit("post-authentication-tree");

    expect(Reflect.set(fixture.row.queue.attempt, "resultCommit", forgedResult)).toBe(false);
    substitutePersistedCandidateResult(fixture.sourceRow, {
      resultCommit: forgedResult,
      resultTree: forgedTree,
    });

    const staged = fixture.authenticator.stage(fixture.pending, { row: fixture.row });
    expect(staged.g213.resultCommit).toBe(fixture.result);
    expect(staged.g213.resultTree).toBe(fixture.tree);
    expect(
      (fixture.sourceRow.implementationQueue?.attempt as { resultCommit: string }).resultCommit,
    ).toBe(forgedResult);
  });

  test("snapshots the persisted candidate before asynchronous repository resolution", async () => {
    const fixture = await identityFixture();
    const repositoryDiff = fixture.row.repositoryDiff;
    let observedSource: AttestationEnvelope | undefined;
    let releaseRepository!: () => void;
    let repositoryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      repositoryStarted = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      releaseRepository = resolve;
    });
    const authentication = authenticatedCandidateRow({
      dispatch: fixture.dispatch,
      result: fixture.result,
      tree: fixture.tree,
      receipts: fixture.receipts,
      repositoryDiff,
      observeSourceRow: (row) => {
        observedSource = row;
      },
      repository: {
        resolveWholeDiff: async () => {
          repositoryStarted();
          await paused;
          return repositoryDiff;
        },
      },
    });
    await started;
    const forgedResult = commit("mid-resolution-result");
    const forgedTree = commit("mid-resolution-tree");
    substitutePersistedCandidateResult(observedSource!, {
      resultCommit: forgedResult,
      resultTree: forgedTree,
    });
    releaseRepository();

    const authenticated = await authentication;
    const staged = authenticated.authenticator.stage(fixture.pending, { row: authenticated.row });
    expect(staged.g213.resultCommit).toBe(fixture.result);
    expect(staged.g213.resultTree).toBe(fixture.tree);
  });

  test("rejects an attestation substituted for the actual G213 row", async () => {
    const fixture = await identityFixture();
    const foreign = { ...fixture.dispatch, attestationId: "att-foreign" };
    const pending = createPendingCohortCandidateAttemptV1(fixture.definition, foreign);
    expect(() =>
      fixture.authenticator.stage(pending, {
        row: fixture.row,
      }),
    ).toThrow("actual G213 row");
  });

  test("rejects a generation substituted for the actual G213 row", async () => {
    const fixture = await identityFixture();
    const foreign = { ...fixture.dispatch, generation: 99 };
    const pending = createPendingCohortCandidateAttemptV1(fixture.definition, foreign);
    expect(() =>
      fixture.authenticator.stage(pending, {
        row: fixture.row,
      }),
    ).toThrow("actual G213 row");
  });

  test("rejects a branch substituted for the actual G213 row", async () => {
    const fixture = await identityFixture();
    const foreign = { ...fixture.dispatch, branch: "implement/T-foreign" };
    const pending = createPendingCohortCandidateAttemptV1(fixture.definition, foreign);
    expect(() =>
      fixture.authenticator.stage(pending, {
        row: fixture.row,
      }),
    ).toThrow("actual G213 row");
  });

  test("rejects a whole diff substituted for the G213 repository diff", async () => {
    const fixture = await identityFixture();
    expect(() =>
      new InMemoryCohortCandidateSealStoreV1().seal({
        definition: fixture.definition,
        attempt: fixture.staged,
        baseCommit: fixture.base,
        resultCommit: fixture.result,
        resultTree: fixture.tree,
        wholeDiff: [
          { path: "src/unrelated.ts", mode: "100644", blobDigest: sha256("unrelated") },
        ],
        gitReceipts: fixture.receipts,
      }),
    ).toThrow("G213 repository diff");
  });

  test("rejects a G213 row whose staged files differ from the repository", async () => {
    const dispatch = {
      attestationId: "att-test",
      generation: 1,
      taskId: "T-test",
      branch: "implement/T-test",
      startingCommit: commit("base"),
    };
    const result = commit("result");
    const tree = commit("result-tree");
    const receipts = [receipt({ base: dispatch.startingCommit, result, tree })];
    await expect(
      authenticatedCandidateRow({
        dispatch,
        result,
        tree,
        receipts,
        repositoryDiff: [
          { path: "src/result.ts", mode: "100644", blobDigest: sha256("result blob") },
        ],
        outputFilesTouched: ["src/unrelated.ts"],
      }),
    ).rejects.toThrow("filesTouched differs from the repository diff");
  });

  test("production Git source derives the exact G213 whole diff", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "cq-g213-diff-"));
    try {
      const git = async (args: readonly string[]): Promise<string> => {
        const result = await execFileAsync("git", [...args], { cwd: repositoryRoot });
        return result.stdout.trim();
      };
      await git(["init", "--quiet"]);
      await git(["config", "user.name", "cq-test"]);
      await git(["config", "user.email", "cq-test@localhost"]);
      await mkdir(join(repositoryRoot, "src"), { recursive: true });
      await writeFile(join(repositoryRoot, "src/result.ts"), "export const result = 1;\n");
      await git(["add", "."]);
      await git(["commit", "--quiet", "-m", "base"]);
      const baseCommit = await git(["rev-parse", "HEAD"]);
      await writeFile(join(repositoryRoot, "src/result.ts"), "export const result = 2;\n");
      await git(["add", "."]);
      await git(["commit", "--quiet", "-m", "result"]);
      const resultCommit = await git(["rev-parse", "HEAD"]);
      const resultTree = await git(["rev-parse", "HEAD^{tree}"]);

      const repository = new GitG213CandidateRepositoryV1({
        repositoryRoot,
        repositoryId: "repository:test",
      });
      const diff = await repository.resolveWholeDiff({
        repositoryId: "repository:test",
        baseCommit,
        resultCommit,
        resultTree,
      });

      expect(diff).toHaveLength(1);
      expect(diff[0]?.path).toBe("src/result.ts");
      expect(diff[0]?.mode).toBe("100644");
      expect(diff[0]?.blobDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  test("semantic changes advance the definition generation", async () => {
    const fixture = await identityFixture();
    const variants = [
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }, { ref: "tasks:T3" }]),
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2", authority: "changed" }]),
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2", atoms: [{ witness: "changed" }] }]),
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2", atoms: [{ command: "changed" }] }]),
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }], {
        environment: "changed",
      }),
      await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }], {
        repository: {
          repositoryId: "repository:test",
          headCommit: commit("changed-head"),
          treeOid: commit("changed-tree"),
        },
      }),
    ];

    for (const observation of variants) {
      const decision = constructCohortDecisionsV1(observation)[0]!;
      const changed = createCohortDefinitionIdentityV1({
        cohortId: fixture.definition.cohortId,
        decision,
        observation,
        prior: fixture.definition,
      });
      expect(changed.definitionGeneration).toBe(2);
      expect(changed.definitionDigest).not.toBe(fixture.definition.definitionDigest);
    }
  });
});
