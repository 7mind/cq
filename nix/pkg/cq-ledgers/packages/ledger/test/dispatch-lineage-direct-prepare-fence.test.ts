import { describe, expect, test } from "bun:test";
import {
  DISPATCH_OVERLAY_REGISTRY,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  prepareDispatchOn,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
  type PrepareDispatchRequest,
} from "@cq/config";
import {
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
): PrepareDispatchRequest {
  return {
    namespace,
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
  test("legacy manager-bound prepare returns the typed refusal before allocation", async () => {
    const store = new InMemoryAttestationStore(namespace);
    const outcome = await prepareDispatchOn(
      new InMemoryAttestationBackend(store),
      request(),
      {
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
});
