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
  journalRecoveryRequiredForFence,
} from "../src/index.js";
import {
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

class LineageLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function request(namespace: AttestationNamespace, key: string): PrepareDispatchRequest {
  return {
    namespace,
    roleId: "implement-worker",
    surface: "codex",
    input: RECOVERY_INPUT,
    idempotencyKey: key,
    timeoutMs: 600_000,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: "8".repeat(64),
    catalogHash: "9".repeat(64),
    expectedChild: { childId: "pg-race-child", runId: key },
    gitEffectBinding: RECOVERY_BINDING,
  };
}

describe.skipIf(SKIP_LIVE)("live PostgreSQL seal/prepare ordering", () => {
  for (const winner of ["prepare", "seal"] as const) {
    test(`${winner} first is the only ordered winner`, async () => {
      const namespace: AttestationNamespace = {
        backend: "postgres",
        projectKey: `t2816-race-${winner}-${crypto.randomUUID()}`,
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
        sourceAttestationId: `att_${"a".repeat(32)}`,
        selectedSourceGeneration: 2,
        lineageMaximumGeneration: 9,
        recoverySeedRef: `cq-current-recovery-seal:v1:${"a".repeat(64)}`,
        fenceCapability: {
          scope: "dispatch-lineage-fence",
          token: RECOVERY_BINDING.handleToken,
        },
        installedAt: RECOVERY_NOW,
      });
      const lock = new LineageLock();
      let installed = false;
      const seal = async () =>
        await lock.run(async () => {
          installed = true;
        });
      const prepare = async () =>
        await prepareDispatchOn(backend, request(namespace, `pg-race-${winner}`), {
          now: () => RECOVERY_NOW,
          randomBytes: sequentialDispatchRandomBytes(0),
          withLineageLock: async (operation) => await lock.run(operation),
          lineageFenceGuard: async () =>
            installed ? journalRecoveryRequiredForFence(fence) : null,
        });
      try {
        const first = winner === "prepare" ? prepare() : seal();
        const second = winner === "prepare" ? seal() : prepare();
        await first;
        const secondOutcome = await second;
        const rows = await backend.storedRows();
        if (winner === "prepare") {
          expect(secondOutcome).toBeUndefined();
          expect(rows).toHaveLength(1);
        } else {
          expect(secondOutcome).toEqual(journalRecoveryRequiredForFence(fence));
          expect(rows).toHaveLength(0);
        }
      } finally {
        await backend.transact({ kind: "namespace" }, (store) => {
          for (const row of store.rows()) store.remove(row);
        });
        await backend.close();
      }
    });
  }
});
