import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FsAttestationBackend,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  SqliteAttestationBackend,
  prepareDispatchOn,
  sequentialDispatchRandomBytes,
  type AttestationBackend,
  type AttestationBackendManagerPrepareDeps,
  type AttestationNamespace,
  type PrepareDispatchRequest,
} from "@cq/config";
import {
  assertAttestationConstructionSupported,
  createAttestationStoreForConstruction,
  createDispatchLineageCutoverFence,
  dispatchLineageFenceAuthorizes,
  journalRecoveryRequiredForFence,
} from "../src/index.js";
import {
  RECOVERY_ATTESTATION,
  RECOVERY_BASE,
  RECOVERY_BINDING,
  RECOVERY_INPUT,
  RECOVERY_NOW,
  RECOVERY_TASK,
} from "./recoverySealTestSupport.js";

const namespace: AttestationNamespace = { backend: "xdg", projectKey: "t2816-direct" };
const capability = {
  scope: "dispatch-lineage-fence" as const,
  token: RECOVERY_BINDING.handleToken,
};
const recoverySeedRef = `cq-current-recovery-seal:v1:${"a".repeat(64)}`;
const fence = createDispatchLineageCutoverFence({
  namespace,
  taskId: RECOVERY_TASK,
  managedFingerprint: RECOVERY_BINDING.handleFingerprint,
  sourceAttestationId: RECOVERY_ATTESTATION,
  selectedSourceGeneration: 2,
  lineageMaximumGeneration: 9,
  recoverySeedRef,
  fenceCapability: capability,
  installedAt: RECOVERY_NOW,
});

function request(
  overrides: Partial<PrepareDispatchRequest> = {},
  requestNamespace: AttestationNamespace = namespace,
): PrepareDispatchRequest {
  return {
    namespace: requestNamespace,
    roleId: "implement-worker",
    surface: "codex",
    input: { ...RECOVERY_INPUT, round: 18, startingCommit: RECOVERY_BASE },
    idempotencyKey: "T2345-journal-recovery",
    timeoutMs: 600_000,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: "8".repeat(64),
    catalogHash: "9".repeat(64),
    expectedChild: { childId: "journal-recovery-child", runId: "journal-recovery-run" },
    gitEffectBinding: RECOVERY_BINDING,
    ...overrides,
  };
}

describe("direct prepare lineage fence", () => {
  // Regression: T2816 allowed a manager-bound backend prepare to omit the
  // lineage fence boundary and allocate directly beside a committed fence.
  test("manager-bound backend prepare fails closed when its lineage boundary is omitted [Behavioral-Active Blackbox-Atomic]", async () => {
    const store = new InMemoryAttestationStore(namespace);
    await expect(
      prepareDispatchOn(new InMemoryAttestationBackend(store), request(), {
        mode: "manager-bound",
        now: () => RECOVERY_NOW,
        randomBytes: sequentialDispatchRandomBytes(0),
      } as unknown as AttestationBackendManagerPrepareDeps),
    ).rejects.toThrow("manager-bound prepare requires a lineage fence guard and lock");
    expect(store.snapshot()).toEqual([]);
  });

  // Regression: T2816 trusted a caller-selected backend dependency mode over
  // the request's manager-resolved Git effect authority and allocated beside a fence.
  test("trusted managed binding cannot be downgraded to backend mode [Behavioral-Active Blackbox-Atomic]", async () => {
    const store = new InMemoryAttestationStore(namespace);
    await expect(
      prepareDispatchOn(new InMemoryAttestationBackend(store), request(), {
        mode: "backend",
        now: () => RECOVERY_NOW,
        randomBytes: sequentialDispatchRandomBytes(0),
      }),
    ).rejects.toThrow("trusted managed prepare requires a lineage fence guard and lock");
    expect(store.snapshot()).toEqual([]);
  });

  test("legacy manager-bound prepare returns the typed refusal before allocation", async () => {
    const store = new InMemoryAttestationStore(namespace);
    const outcome = await prepareDispatchOn(
      new InMemoryAttestationBackend(store),
      request(),
      {
        mode: "manager-bound",
        now: () => RECOVERY_NOW,
        randomBytes: sequentialDispatchRandomBytes(0),
        lineageFenceGuard: async () => journalRecoveryRequiredForFence(fence),
        withLineageLock: async (operation) => await operation(),
      },
    );
    expect(outcome).toEqual(journalRecoveryRequiredForFence(fence));
    expect(store.snapshot()).toEqual([]);
  });

  test("exact journal authority reserves max+1 even after the source row was deleted", async () => {
    const store = new InMemoryAttestationStore(namespace);
    const authority = { recoverySeedRef, fenceCapability: capability };
    const outcome = await prepareDispatchOn(
      new InMemoryAttestationBackend(store),
      request({
        reprepareOf: { attestationId: RECOVERY_ATTESTATION, generation: 2 },
        journalRecoveryReservation: {
          fenceRef: fence.fenceRef,
          sourceAttestationId: RECOVERY_ATTESTATION,
          selectedSourceGeneration: 2,
          lineageMaximumGeneration: 9,
        },
      }),
      {
        mode: "manager-bound",
        now: () => RECOVERY_NOW,
        randomBytes: sequentialDispatchRandomBytes(0),
        lineageFenceGuard: async () =>
          dispatchLineageFenceAuthorizes(fence, authority)
            ? null
            : journalRecoveryRequiredForFence(fence),
        withLineageLock: async (operation) => await operation(),
      },
    );
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) throw new Error(outcome.detail);
    expect(outcome.handle).toEqual({ attestationId: RECOVERY_ATTESTATION, generation: 10 });
    expect(store.snapshot()).toHaveLength(1);
  });

  test("wrong seed or capability cannot reserve identity, generation, or child capabilities", async () => {
    for (const authority of [
      {
        recoverySeedRef: `cq-current-recovery-seal:v1:${"0".repeat(64)}`,
        fenceCapability: capability,
      },
      {
        recoverySeedRef,
        fenceCapability: {
          scope: "dispatch-lineage-fence" as const,
          token: "not-the-managed-fence-token",
        },
      },
    ]) {
      const store = new InMemoryAttestationStore(namespace);
      const outcome = await prepareDispatchOn(
        new InMemoryAttestationBackend(store),
        request({ idempotencyKey: `wrong-${authority.fenceCapability.token}` }),
        {
          mode: "manager-bound",
          now: () => RECOVERY_NOW,
          randomBytes: sequentialDispatchRandomBytes(0),
          lineageFenceGuard: async () =>
            dispatchLineageFenceAuthorizes(fence, authority)
              ? null
              : journalRecoveryRequiredForFence(fence),
          withLineageLock: async (operation) => await operation(),
        },
      );
      expect(outcome).toEqual(journalRecoveryRequiredForFence(fence));
      expect(store.snapshot()).toEqual([]);
    }
  });

  for (const adapter of ["in-memory", "filesystem", "git-object", "sqlite"] as const) {
    test(`${adapter} adapter obeys the same locked fence-before-transaction contract [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
      const root = await fs.mkdtemp(join(tmpdir(), `t2816-${adapter}-`));
      const adapterNamespace: AttestationNamespace = {
        backend:
          adapter === "filesystem" ? "fs" : adapter === "git-object" ? "git-object" : "xdg",
        projectKey: `t2816-${adapter}`,
      };
      let backend: AttestationBackend;
      if (adapter === "in-memory") {
        const store = new InMemoryAttestationStore(adapterNamespace);
        backend = new InMemoryAttestationBackend(store);
      } else if (adapter === "filesystem") {
        backend = new FsAttestationBackend({ namespace: adapterNamespace, root });
      } else if (adapter === "git-object") {
        execFileSync("git", ["init", "--quiet"], { cwd: root });
        expect(assertAttestationConstructionSupported("direct", "git-object")).toBe(
          "git-object",
        );
        backend = await createAttestationStoreForConstruction({
          backend: "git-object",
          namespace: adapterNamespace,
          repoRoot: root,
        } as never);
      } else {
        backend = new SqliteAttestationBackend({
          namespace: adapterNamespace,
          dbPath: join(root, "attestations.db"),
        });
      }
      const rows = () =>
        backend.transact({ kind: "namespace" }, (store) => Promise.resolve(store.rows()));
      const order: string[] = [];
      try {
        const prepared = await prepareDispatchOn(
          backend,
          request({ idempotencyKey: `${adapter}-allocated` }, adapterNamespace),
          {
            mode: "manager-bound",
            now: () => RECOVERY_NOW,
            randomBytes: sequentialDispatchRandomBytes(0),
            withLineageLock: async (operation) => {
              order.push("lock-enter");
              try {
                return await operation();
              } finally {
                order.push("lock-exit");
              }
            },
            lineageFenceGuard: async () => {
              order.push("guard");
              return null;
            },
          },
        );
        expect(prepared.accepted).toBe(true);
        expect(await rows()).toHaveLength(1);
        expect(order).toEqual(["lock-enter", "guard", "lock-exit"]);

        const refused = await prepareDispatchOn(
          backend,
          request({ idempotencyKey: `${adapter}-fenced` }, adapterNamespace),
          {
            mode: "manager-bound",
            now: () => RECOVERY_NOW,
            randomBytes: sequentialDispatchRandomBytes(64),
            withLineageLock: async (operation) => await operation(),
            lineageFenceGuard: async () => journalRecoveryRequiredForFence(fence),
          },
        );
        expect(refused).toEqual(journalRecoveryRequiredForFence(fence));
        expect(await rows()).toHaveLength(1);
      } finally {
        await backend.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }

});
