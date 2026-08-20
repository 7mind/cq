import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  ensureSchema,
  IDEAS_LEDGER,
  openPgPool,
  PostgresLedgerStore,
  worksetMemberRefSet,
  type WorksetOwnedGuardedLedger,
} from "../src/index.js";

const dsn = process.env.CQ_TEST_PG_URL;
const requirePostgres = process.env.CQ_TEST_REQUIRE_PG === "1";

if (dsn === undefined || dsn.length === 0) {
  if (requirePostgres) {
    throw new Error(
      "CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN",
    );
  }
  describe.skip("workset coordination-bundle PostgreSQL faults [T1966]", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const pgDsn: string = dsn;
  const setupPool = openPgPool(pgDsn);
  const schemaReady = ensureSchema(setupPool);
  const ledgers: WorksetOwnedGuardedLedger[] = [];

  afterAll(async () => {
    for (const ledger of ledgers) await ledger.dispose().catch(() => undefined);
    await setupPool.close();
  });

  async function open(
    projectKey: string,
    onMutation?: (ledgerId: string) => void,
  ): Promise<{
    raw: PostgresLedgerStore;
    ledger: WorksetOwnedGuardedLedger;
    pool: ReturnType<typeof openPgPool>;
  }> {
    await schemaReady;
    const pool = openPgPool(pgDsn);
    const raw = new PostgresLedgerStore({
      pool,
      projectKey,
      displayName: projectKey,
      ...(onMutation !== undefined ? { onMutation } : {}),
      workset: {
        isTargetAdmitted: (target, selectedRoots) => {
          if (selectedRoots.length === 0) return true;
          const graph = closeWorkset(
            selectedRoots,
            buildActiveStateFromLedgerStore(raw),
          );
          return (
            worksetMemberRefSet(graph).has(target) ||
            graph.inactiveRoots.includes(target)
          );
        },
      },
    });
    await raw.init();
    const ledger = createWorksetOwnedGuardedLedger({
      rawStore: raw,
      worksetStore: raw.worksetStore(),
      invocationAuthority: createTrustedWorksetManagementAuthority(),
      runOwnedTransaction: (mutate) => raw.runAtomicOwnedMutation(mutate),
    });
    ledgers.push(ledger);
    return { raw, ledger, pool };
  }

  describe("workset coordination-bundle PostgreSQL faults [T1966]", () => {
    it("serializes same-tenant writers while preserving tenant isolation", async () => {
      const sharedProject = `t1966-serialized-${randomUUID()}`;
      const isolatedProject = `t1966-isolated-${randomUUID()}`;
      const first = await open(sharedProject);
      const second = await open(sharedProject);
      const isolated = await open(isolatedProject);
      const [left, right, other] = await Promise.all([
        first.ledger.owned.createOwnerless({
          ledgerId: IDEAS_LEDGER,
          status: "open",
          fields: { title: "pg-serialized-left" },
        }),
        second.ledger.owned.createOwnerless({
          ledgerId: IDEAS_LEDGER,
          status: "open",
          fields: { title: "pg-serialized-right" },
        }),
        isolated.ledger.owned.createOwnerless({
          ledgerId: IDEAS_LEDGER,
          status: "open",
          fields: { title: "pg-isolated-other" },
        }),
      ]);
      expect(left.id).not.toBe(right.id);
      expect(other.id).toBe("I1");

      const sharedRestart = await open(sharedProject);
      const isolatedRestart = await open(isolatedProject);
      expect(sharedRestart.raw.fetchItem(IDEAS_LEDGER, left.id).fields.title).toBe(
        "pg-serialized-left",
      );
      expect(sharedRestart.raw.fetchItem(IDEAS_LEDGER, right.id).fields.title).toBe(
        "pg-serialized-right",
      );
      expect(sharedRestart.raw.search(IDEAS_LEDGER, "pg-isolated-other")).toEqual([]);
      expect(isolatedRestart.raw.search(IDEAS_LEDGER, "pg-serialized")).toEqual([]);
      expect(isolatedRestart.raw.fetchItem(IDEAS_LEDGER, other.id).fields.title).toBe(
        "pg-isolated-other",
      );
    });
  });
}
