import { describe, expect, test } from "bun:test";
import {
  DISPATCH_OVERLAY_REGISTRY,
  prepareDispatchOn,
  sequentialDispatchRandomBytes,
  type AttestationBackend,
  type AttestationNamespace,
  type PrepareDispatchRequest,
} from "@cq/config";
import {
  createDispatchLineageCutoverFence,
  journalRecoveryRequiredForFence,
} from "../src/index.js";
import {
  RECOVERY_ATTESTATION,
  RECOVERY_BINDING,
  RECOVERY_INPUT,
  RECOVERY_NOW,
  RECOVERY_TASK,
} from "./recoverySealTestSupport.js";

const namespace: AttestationNamespace = { backend: "xdg", projectKey: "t2816-paths" };
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

function baseRequest(idempotencyKey: string): PrepareDispatchRequest {
  return {
    namespace,
    roleId: "implement-worker",
    surface: "codex",
    input: RECOVERY_INPUT,
    idempotencyKey,
    timeoutMs: 600_000,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: "8".repeat(64),
    catalogHash: "9".repeat(64),
    expectedChild: { childId: "fenced-child", runId: "fenced-run" },
    gitEffectBinding: RECOVERY_BINDING,
  };
}

const source = { attestationId: RECOVERY_ATTESTATION, generation: 2 } as const;
const legacyPaths: ReadonlyArray<{
  readonly label: string;
  readonly request: PrepareDispatchRequest;
}> = [
  { label: "direct", request: baseRequest("direct") },
  { label: "reprepareOf", request: { ...baseRequest("reprepare"), reprepareOf: source } },
  { label: "legacy recovery", request: { ...baseRequest("recovery"), reprepareOf: source } },
  {
    label: "consumed continuation",
    request: {
      ...baseRequest("continuation"),
      reprepareOf: source,
      continuationClaim: {
        continuationReference: `cq-dispatch-continuation:v1:${"b".repeat(64)}`,
        actor: "trusted-parent",
        liveTip: "3".repeat(40),
      },
    },
  },
  {
    label: "guarded rebase continuation",
    request: {
      ...baseRequest("guarded-rebase"),
      reprepareOf: source,
      gitEffectBinding: {
        ...RECOVERY_BINDING,
        guardedRebaseBridge: {
          guardedRebase: `cq-guarded-rebase:v1:${"c".repeat(64)}`,
          operationId: "guarded-rebase-fixture",
          requestDigest: "c".repeat(64),
          oldResultCommit: "1".repeat(40),
          ontoCommit: "2".repeat(40),
          rebasedStartCommit: "3".repeat(40),
          outcome: "conflicted",
          exactTip: false,
          finalizedAt: RECOVERY_NOW,
        },
      },
    },
  },
];

describe("all legacy continuation paths obey the lineage fence", () => {
  for (const path of legacyPaths) {
    test(`${path.label} refuses before backend validation or allocation`, async () => {
      let transactions = 0;
      const order: string[] = [];
      const backend: AttestationBackend = {
        namespace,
        transact: async () => {
          transactions += 1;
          throw new Error("the fenced request reached the backend");
        },
        close: async () => {},
      };
      const outcome = await prepareDispatchOn(backend, path.request, {
        now: () => RECOVERY_NOW,
        randomBytes: sequentialDispatchRandomBytes(0),
        withLineageLock: async (operation) => {
          order.push("lock");
          return await operation();
        },
        lineageFenceGuard: async () => {
          order.push("fence");
          return journalRecoveryRequiredForFence(fence);
        },
      });
      expect(outcome).toEqual(journalRecoveryRequiredForFence(fence));
      expect(order).toEqual(["lock", "fence"]);
      expect(transactions).toBe(0);
    });
  }
});
