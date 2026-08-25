import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import {
  DISPATCH_OVERLAY_REGISTRY,
  PostgresAttestationBackend,
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
  RECOVERY_BINDING,
  RECOVERY_INPUT,
  RECOVERY_NOW,
  RECOVERY_TASK,
} from "./recoverySealTestSupport.js";

const PG_URL = process.env["CQ_TEST_PG_URL"];
if (
  process.env["CQ_TEST_REQUIRE_PG"] === "1" &&
  (PG_URL === undefined || PG_URL.length === 0)
) {
  throw new Error("CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN");
}
const SKIP_LIVE = PG_URL === undefined || PG_URL.length === 0;

function request(
  namespace: AttestationNamespace,
  fenceRef: string,
): PrepareDispatchRequest {
  return {
    namespace,
    roleId: "implement-worker",
    surface: "codex",
    input: RECOVERY_INPUT,
    idempotencyKey: `pg-journal-recovery-${crypto.randomUUID()}`,
    timeoutMs: 600_000,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: "8".repeat(64),
    catalogHash: "9".repeat(64),
    expectedChild: { childId: "pg-fence-child", runId: crypto.randomUUID() },
    reprepareOf: { attestationId: RECOVERY_ATTESTATION, generation: 2 },
    gitEffectBinding: RECOVERY_BINDING,
    journalRecoveryReservation: {
      fenceRef,
      sourceAttestationId: RECOVERY_ATTESTATION,
      selectedSourceGeneration: 2,
      lineageMaximumGeneration: 9,
    },
  };
}

describe.skipIf(SKIP_LIVE)("live PostgreSQL lineage cutover fence", () => {
  test("exact journal authority durably reserves max+1 with a deleted source row", async () => {
    const namespace: AttestationNamespace = {
      backend: "postgres",
      projectKey: `t2816-fence-${crypto.randomUUID()}`,
    };
    const backend = await PostgresAttestationBackend.open({
      namespace,
      pool: new SQL({ url: PG_URL!, max: 1 }),
      ownsPool: true,
    });
    const fence = createDispatchLineageCutoverFence({
      namespace,
      taskId: RECOVERY_TASK,
      managedFingerprint: RECOVERY_BINDING.handleFingerprint,
      sourceAttestationId: RECOVERY_ATTESTATION,
      selectedSourceGeneration: 2,
      lineageMaximumGeneration: 9,
      recoverySeedRef: `cq-current-recovery-seal:v1:${"a".repeat(64)}`,
      fenceCapability: {
        scope: "dispatch-lineage-fence",
        token: RECOVERY_BINDING.handleToken,
      },
      installedAt: RECOVERY_NOW,
    });
    const authority = {
      recoverySeedRef: fence.recoverySeedRef,
      fenceCapability: {
        scope: "dispatch-lineage-fence" as const,
        token: RECOVERY_BINDING.handleToken,
      },
    };
    try {
      const outcome = await prepareDispatchOn(backend, request(namespace, fence.fenceRef), {
        mode: "manager-bound",
        now: () => RECOVERY_NOW,
        randomBytes: sequentialDispatchRandomBytes(0),
        withLineageLock: async (operation) => await operation(),
        lineageFenceGuard: async () =>
          dispatchLineageFenceAuthorizes(fence, authority)
            ? null
            : journalRecoveryRequiredForFence(fence),
      });
      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) throw new Error(outcome.detail);
      expect(outcome.handle).toEqual({ attestationId: RECOVERY_ATTESTATION, generation: 10 });
      expect(await backend.storedRows()).toHaveLength(1);
    } finally {
      await backend.transact({ kind: "namespace" }, (store) => {
        for (const row of store.rows()) store.remove(row);
      });
      await backend.close();
    }
  });
});
