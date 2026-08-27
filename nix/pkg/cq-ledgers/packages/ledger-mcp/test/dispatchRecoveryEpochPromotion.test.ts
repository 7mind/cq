import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  dispatchPayloadDigest,
  sequentialDispatchRandomBytes,
  type AttestationEnvelope,
  type AttestationNamespace,
  type AttestationRow,
  type PromptSurface,
} from "@cq/config";
import {
  InMemoryCurrentRecoverySealJournalStore,
  dispatchLineageFenceFromRecoveryJournal,
  journalRecoveryRequiredForFence,
  prepareManagedWorktree,
  resolveInheritedGitChangeReceipts,
  resolveManagedWorktreeDispatchBinding,
  type GitChangeBrokerReceipt,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import { captureCurrentRecoverySeal } from "../src/dispatchRecoverySeal.js";
import type {
  PromptArtifactRoleMetadata,
  PromptArtifactStore,
} from "../src/promptArtifactStore.js";
import {
  RECOVERY_ATTESTATION,
  RECOVERY_BINDING,
  RECOVERY_INPUT,
  RECOVERY_RECEIPTS,
  RECOVERY_TASK,
  RECOVERY_TIP,
  abortedEnvelope,
  receipt,
} from "../../ledger/test/recoverySealTestSupport.js";

const TASK_ID = "T2345";
const NOW = "2026-08-25T01:00:00.000Z";
const LATER = "2026-08-25T01:00:01.000Z";
const PROMPT_DIGEST = "8".repeat(64);
const CATALOG_HASH = "9".repeat(64);
const PROMOTED_TIP = "4".repeat(40);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

function artifactStore(surface: PromptSurface): PromptArtifactStore {
  const metadata: PromptArtifactRoleMetadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent",
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: surface,
    promptDigest: PROMPT_DIGEST,
    schemaVersion: 1,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: surface,
      catalogHash: CATALOG_HASH,
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

function terminalAbortDigest(reason: string): string {
  return dispatchPayloadDigest({ terminalKind: "aborted", reason, detailsDigest: null });
}

function journalDerivedAbort(
  reason: "invalid-output" | "missing-result" | "deadline-exceeded" | "parent-lost" =
    "parent-lost",
): AttestationEnvelope {
  const input = { ...RECOVERY_INPUT, round: 18 };
  const row = abortedEnvelope({ generation: 18, reason });
  return {
    ...row,
    promptProvenance: {
      ...row.promptProvenance,
      inputDigest: dispatchPayloadDigest(input),
    },
    input,
    gitEffectBinding: {
      ...RECOVERY_BINDING,
      inheritedGitReceipts: RECOVERY_RECEIPTS,
    },
    terminalDigest: terminalAbortDigest(reason),
  };
}

async function generation17Journal() {
  const journal = new InMemoryCurrentRecoverySealJournalStore();
  const generation17 = abortedEnvelope({ generation: 17 });
  await captureCurrentRecoverySeal(
    {
      taskId: RECOVERY_TASK,
      binding: RECOVERY_BINDING,
      liveTip: RECOVERY_TIP,
      taskDigest: "b".repeat(64),
      finalizedManifestDigest: "c".repeat(64),
    },
    {
      journal,
      snapshot: async () => [generation17],
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => NOW,
    },
  );
  return { journal, generation17 };
}

function promotionCoordinates() {
  return {
    taskId: RECOVERY_TASK,
    binding: RECOVERY_BINDING,
    liveTip: PROMOTED_TIP,
    taskDigest: "b".repeat(64),
    finalizedManifestDigest: "c".repeat(64),
  } as const;
}

function promotedReceipts(): readonly GitChangeBrokerReceipt[] {
  return [...RECOVERY_RECEIPTS, receipt(18, RECOVERY_TIP, PROMOTED_TIP)];
}

describe("journal recovery epoch promotion", () => {
  // Regression: D365 left the first committed journal epoch immutable, so a
  // journal-derived terminal successor could not authorize the next generation.
  test("seal generation 17 -> journal generation 18 -> promoted epoch -> journal generation 19 [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), "t2345-recovery-epoch-"));
    const ledgerState = new InMemoryCurrentRecoverySealJournalStore();
    const namespace: AttestationNamespace = { backend: "xdg", projectKey: "t2345-epoch" };
    const store = new InMemoryAttestationStore(namespace);
    const backend = new InMemoryAttestationBackend(store);
    try {
      await git(repositoryRoot, ["init", "-q"]);
      await fs.writeFile(path.join(repositoryRoot, "state.txt"), "generation-17\n");
      await git(repositoryRoot, ["add", "state.txt"]);
      await git(repositoryRoot, [
        "-c",
        "user.name=T2345",
        "-c",
        "user.email=t2345@example.invalid",
        "commit",
        "-q",
        "-m",
        "generation 17 base",
      ]);
      const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      const baseTree = await git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
      const stateDir = path.join(repositoryRoot, ".manager-state");
      const managed = await prepareManagedWorktree(
        { repositoryRoot, taskId: TASK_ID, baseCommit },
        { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
      );
      if (managed.status !== "prepared") throw new Error(`unexpected ${managed.status}`);
      const binding = await resolveManagedWorktreeDispatchBinding(
        {
          repositoryRoot,
          taskId: TASK_ID,
          worktreePath: managed.handle.absolutePath,
          branch: managed.handle.branch,
        },
        { stateDir },
      );
      if (binding === null) throw new Error("managed binding disappeared");
      const attestationId = `att_${"a".repeat(32)}`;
      const input17 = {
        taskId: TASK_ID,
        headline: "promote journal recovery epochs",
        description: "retain the complete authenticated receipt closure",
        acceptance: "generation 19 inherits generation 18",
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
        baseCommit,
        round: 17,
        startingCommit: baseCommit,
        priorResultCommit: baseCommit,
      } as const;
      const seedReceipt: GitChangeBrokerReceipt = {
        kind: "cq-git-change-receipt",
        version: 1,
        attestationId,
        generation: 17,
        taskId: TASK_ID,
        operationId: "generation-17-seal",
        requestDigest: "1".repeat(64),
        oldHead: baseCommit,
        newHead: baseCommit,
        tree: baseTree,
        objectOids: [baseCommit, baseTree],
        paths: ["state.txt"],
        committedAt: NOW,
      };
      const terminalDigest = dispatchPayloadDigest({
        terminalKind: "aborted",
        reason: "deadline-exceeded",
        detailsDigest: null,
      });
      const generation17: AttestationEnvelope = {
        kind: "envelope",
        namespace,
        attestationId,
        generation: 17,
        idempotencyKey: "T2345-generation-17",
        state: "aborted",
        promptProvenance: {
          roleId: "implement-worker",
          version: 10,
          surface: "codex",
          promptDigest: PROMPT_DIGEST,
          catalogHash: CATALOG_HASH,
          inputDigest: dispatchPayloadDigest(input17),
        },
        prepareRequestDigest: "2".repeat(64),
        input: input17,
        overlays: [],
        deadlines: {
          responseStoreNow: NOW,
          childCancelAt: LATER,
          launchDeadline: LATER,
        },
        expectedChild: { childId: "generation-17", runId: "generation-17" },
        inputCapabilityHash: "3".repeat(64),
        resultCapabilityHash: "4".repeat(64),
        gitChangeCapabilityHash: "5".repeat(64),
        gitEffectBinding: binding,
        createdAt: NOW,
        abortedAt: LATER,
        abortReason: "deadline-exceeded",
        terminalAt: LATER,
        terminalDigest,
      };
      store.insert(generation17);
      const coordinates = {
        taskId: TASK_ID,
        binding,
        liveTip: baseCommit,
        taskDigest: "6".repeat(64),
        finalizedManifestDigest: "7".repeat(64),
      } as const;
      const seal17 = await captureCurrentRecoverySeal(coordinates, {
        journal: ledgerState,
        snapshot: async () => store.snapshot(),
        resolveReceipts: async () => [seedReceipt],
        revalidateBinding: async () => {},
        observeLiveTip: async () => baseCommit,
        now: () => NOW,
      });
      expect(seal17.seed.selectedSourceHandle.generation).toBe(17);

      const capability = createDispatchCapability({
        backend,
        promptArtifactStore: artifactStore("codex"),
        repositoryRoot,
        worktreeStateDir: stateDir,
        recoveryJournal: ledgerState,
        now: () => NOW,
        randomBytes: sequentialDispatchRandomBytes(2345),
      });
      const recoveryAuthority17 = {
        recoverySeedRef: seal17.sealReference,
        fenceCapability: {
          scope: "dispatch-lineage-fence" as const,
          token: managed.handle.token,
        },
      };
      const generation18Request = {
        roleId: "implement-worker",
        input: { ...input17, round: 18 },
        idempotencyKey: "T2345-generation-18",
        timeoutMs: 600_000,
        expectedChild: { childId: "generation-18", runId: "generation-18" },
        recoveryPreparation: recoveryAuthority17,
      } as const;
      const generation18 = await capability.prepare(generation18Request);
      if (!generation18.accepted || generation18.prepared.gitChangeCapability === undefined) {
        throw new Error("journal generation 18 was not prepared with Git authority");
      }
      expect(generation18.handle).toEqual({ attestationId, generation: 18 });
      await capability.fetchInput({
        ...generation18.handle,
        inputCapability: generation18.prepared.inputCapability,
      });
      await fs.writeFile(path.join(managed.handle.absolutePath, "state.txt"), "generation-18\n");
      if (capability.gitCommit === undefined) throw new Error("git_commit was not wired");
      const generation18Receipt = await capability.gitCommit({
        ...generation18.handle,
        gitChangeCapability: generation18.prepared.gitChangeCapability,
        operationId: "generation-18-change",
        expectedHead: baseCommit,
        message: "generation 18 brokered change",
        changes: [
          {
            kind: "modify",
            path: "state.txt",
            oldState: { mode: "100644", digest: sha256("generation-17\n") },
            newState: { mode: "100644", digest: sha256("generation-18\n") },
          },
        ],
      });
      await capability.abort({ ...generation18.handle, reason: "parent-lost" });

      const promotionDeps = {
        journal: ledgerState,
        snapshot: async () => store.snapshot(),
        resolveReceipts: async (row: AttestationRow, liveTip: string) =>
          await resolveInheritedGitChangeReceipts(
            {
              ...binding,
              attestationId: row.attestationId,
              generation: row.generation,
              ...(row.kind === "envelope" &&
              row.gitEffectBinding?.inheritedGitReceipts !== undefined
                ? { inheritedGitReceipts: row.gitEffectBinding.inheritedGitReceipts }
                : {}),
            },
            liveTip,
            { stateDir },
          ),
        revalidateBinding: async () => {},
        observeLiveTip: async () => generation18Receipt.newHead,
        now: () => LATER,
      };
      const livePromotionCoordinates = {
        ...coordinates,
        liveTip: generation18Receipt.newHead,
      };
      const promoted = await captureCurrentRecoverySeal(livePromotionCoordinates, promotionDeps);
      expect(promoted.seed.selectedSourceHandle).toEqual({ attestationId, generation: 18 });
      expect(promoted.seed.gitReceipts).toHaveLength(2);
      expect(promoted.seed.gitReceipts[0]?.requestDigest).toBe(seedReceipt.requestDigest);
      expect(promoted.seed.gitReceipts[1]?.requestDigest).toBe(
        generation18Receipt.requestDigest,
      );
      const committed18 = await ledgerState.read(TASK_ID);
      expect(await captureCurrentRecoverySeal(livePromotionCoordinates, promotionDeps)).toEqual(
        promoted,
      );
      expect(await ledgerState.read(TASK_ID)).toEqual(committed18);

      const fence18 = dispatchLineageFenceFromRecoveryJournal(await ledgerState.read(TASK_ID));
      if (fence18 === null) throw new Error("promoted recovery epoch has no fence");
      const fencedRowCount = store.snapshot().length;
      for (const [label, requestFields] of [
        ["ordinary", {}],
        ["reprepare", { reprepareOf: generation18.handle }],
        ["legacy-recovery", { recovery: `cq-dispatch-recovery:v1:${"a".repeat(64)}` }],
        ["continuation", { continuation: `cq-dispatch-continuation:v1:${"b".repeat(64)}` }],
        [
          "guarded-rebase",
          {
            reprepareOf: generation18.handle,
            guardedRebase: `cq-guarded-rebase:v1:${"c".repeat(64)}`,
          },
        ],
      ] as const) {
        expect(
          await capability.prepare({
            ...generation18Request,
            idempotencyKey: `T2345-fenced-${label}`,
            ...requestFields,
          }),
        ).toEqual(journalRecoveryRequiredForFence(fence18));
      }
      for (const recoveryPreparation of [
        recoveryAuthority17,
        {
          recoverySeedRef: promoted.sealReference,
          fenceCapability: {
            scope: "dispatch-lineage-fence" as const,
            token: "foreign-managed-handle-token",
          },
        },
      ]) {
        expect(
          await capability.prepare({
            ...generation18Request,
            idempotencyKey: `T2345-rejected-${recoveryPreparation.recoverySeedRef}`,
            recoveryPreparation,
          }),
        ).toEqual(journalRecoveryRequiredForFence(fence18));
      }
      expect(store.snapshot()).toHaveLength(fencedRowCount);
      const generation19Request = {
        ...generation18Request,
        input: {
          ...input17,
          round: 19,
          startingCommit: generation18Receipt.newHead,
          priorResultCommit: generation18Receipt.newHead,
        },
        idempotencyKey: "T2345-generation-19",
        expectedChild: { childId: "generation-19", runId: "generation-19" },
        recoveryPreparation: {
          recoverySeedRef: promoted.sealReference,
          fenceCapability: recoveryAuthority17.fenceCapability,
        },
      } as const;
      const generation19 = await capability.prepare(generation19Request);
      if (!generation19.accepted) throw new Error(generation19.detail);
      expect(generation19.handle).toEqual({ attestationId, generation: 19 });
      const row19 = store
        .snapshot()
        .find((row) => row.attestationId === attestationId && row.generation === 19);
      expect(row19?.kind === "envelope" ? row19.gitEffectBinding?.inheritedGitReceipts : []).toEqual(
        [seedReceipt, generation18Receipt],
      );
      expect(
        row19?.kind === "envelope"
          ? row19.gitEffectBinding?.inheritedGitReceipts?.at(-1)?.newHead
          : undefined,
      ).toBe(generation18Receipt.newHead);
      const rowCount = store.snapshot().length;
      const responseLossReplay = await capability.prepare(generation19Request);
      expect(responseLossReplay).toEqual(generation19);
      expect(store.snapshot()).toHaveLength(rowCount);
    } finally {
      await backend.close();
      await fs.rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  test("all four authenticated terminal abort reasons promote one epoch [Behavioral-Active Blackbox-Group]", async () => {
    for (const reason of [
      "invalid-output",
      "missing-result",
      "deadline-exceeded",
      "parent-lost",
    ] as const) {
      const { journal, generation17 } = await generation17Journal();
      const successor = journalDerivedAbort(reason);
      const promoted = await captureCurrentRecoverySeal(promotionCoordinates(), {
        journal,
        snapshot: async () => [generation17, successor],
        resolveReceipts: async () => promotedReceipts(),
        revalidateBinding: async () => {},
        observeLiveTip: async () => PROMOTED_TIP,
        now: () => LATER,
      });
      expect(promoted.seed.selectedSourceHandle).toEqual({
        attestationId: RECOVERY_ATTESTATION,
        generation: 18,
      });
      expect(promoted.version === 1 ? promoted.seed.sourceAbortReason : undefined).toBe(reason);
    }
  });

  test("promotion rejects every unauthenticated or competing successor control [Behavioral-Active Blackbox-Group]", async () => {
    const valid = journalDerivedAbort();
    const cases: readonly {
      readonly label: string;
      readonly reason: string;
      readonly rows: (generation17: AttestationEnvelope) => readonly AttestationEnvelope[];
      readonly receipts?: readonly GitChangeBrokerReceipt[];
      readonly liveTip?: string;
      readonly taskDigest?: string;
      readonly finalizedManifestDigest?: string;
    }[] = [
      {
        label: "nonterminal",
        reason: "lineage-active",
        rows: (generation17) => {
          const {
            abortedAt: _abortedAt,
            abortReason: _abortReason,
            terminalAt: _terminalAt,
            terminalDigest: _terminalDigest,
            ...prepared
          } = valid;
          return [generation17, { ...prepared, state: "prepared" }];
        },
      },
      {
        label: "consumed-pass",
        reason: "source-not-found",
        rows: (generation17) => [
          generation17,
          { ...valid, state: "consumed", consumedAt: LATER } as AttestationEnvelope,
        ],
      },
      {
        label: "foreign-binding",
        reason: "journal-conflict",
        rows: (generation17) => [
          generation17,
          {
            ...valid,
            gitEffectBinding: {
              ...valid.gitEffectBinding!,
              handleFingerprint: "f".repeat(64),
            },
          },
        ],
      },
      {
        label: "foreign-handle",
        reason: "source-not-found",
        rows: (generation17) => [
          generation17,
          { ...valid, attestationId: `att_${"f".repeat(32)}` },
        ],
      },
      {
        label: "moved-tip",
        reason: "snapshot-changed",
        rows: (generation17) => [generation17, valid],
        liveTip: RECOVERY_TIP,
      },
      {
        label: "incomplete-receipts",
        reason: "source-not-found",
        rows: (generation17) => [generation17, valid],
        receipts: RECOVERY_RECEIPTS,
      },
      {
        label: "divergent-receipts",
        reason: "invalid",
        rows: (generation17) => [generation17, valid],
        receipts: [
          ...RECOVERY_RECEIPTS,
          receipt(18, RECOVERY_RECEIPTS[0]!.newHead, PROMOTED_TIP),
        ],
      },
      {
        label: "competing-terminal-sources",
        reason: "source-ambiguous",
        rows: (generation17) => [
          generation17,
          valid,
          {
            ...valid,
            attestationId: `att_${"e".repeat(32)}`,
            generation: 19,
          },
        ],
      },
      {
        label: "changed-task-identity",
        reason: "journal-conflict",
        rows: (generation17) => [generation17, valid],
        taskDigest: "0".repeat(64),
      },
      {
        label: "changed-finalized-manifest",
        reason: "journal-conflict",
        rows: (generation17) => [generation17, valid],
        finalizedManifestDigest: "0".repeat(64),
      },
      {
        label: "changed-terminal-digest",
        reason: "journal-conflict",
        rows: (generation17) => [
          generation17,
          { ...valid, terminalDigest: "0".repeat(64) },
        ],
      },
    ];

    for (const control of cases) {
      const { journal, generation17 } = await generation17Journal();
      const coordinates = {
        ...promotionCoordinates(),
        ...(control.taskDigest === undefined ? {} : { taskDigest: control.taskDigest }),
        ...(control.finalizedManifestDigest === undefined
          ? {}
          : { finalizedManifestDigest: control.finalizedManifestDigest }),
      };
      await expect(
        captureCurrentRecoverySeal(coordinates, {
          journal,
          snapshot: async () => control.rows(generation17),
          resolveReceipts: async () => control.receipts ?? promotedReceipts(),
          revalidateBinding: async () => {},
          observeLiveTip: async () => control.liveTip ?? PROMOTED_TIP,
          now: () => LATER,
        }),
        control.label,
      ).rejects.toMatchObject({ reason: control.reason });
      expect(
        (await journal.read(RECOVERY_TASK))?.seal.seed.selectedSourceHandle.generation,
        control.label,
      ).toBe(17);
    }
  });
});
