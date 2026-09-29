/**
 * G192/T6628 — Good-Communication interleavings for memory authoring authority
 * on PostgreSQL.
 *
 * A peer with management authority promotes a fact after an ordinary update or
 * sweep was admitted (and its caller observed the fact) but before that
 * mutation entered its tenant transaction. The transaction must re-resolve the
 * kind from the locked rows and reject the stale decision with no effect.
 *
 * Env-gated on CQ_TEST_PG_URL; `CQ_TEST_REQUIRE_PG=1` makes absence fatal.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import {
  MEMORIES_LEDGER,
  MILESTONES_AMBIENT_ID,
  MemoryManagementAuthorityRequiredError,
  createPostgresWorksetGuardedLedger,
  createPostgresWorksetManagementLedger,
  ensureSchema,
  openPgPool,
  type Item,
  type WorksetGuardedLedger,
} from "../src/index.js";

const PG_URL = process.env.CQ_TEST_PG_URL;
if ((PG_URL === undefined || PG_URL.length === 0) && process.env.CQ_TEST_REQUIRE_PG === "1") {
  throw new Error("CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN");
}

const SUITE = "memory authoring authority — PostgresLedgerStore";

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip(SUITE, () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const dsn: string = PG_URL;
  const setupPool = openPgPool(dsn);
  const schemaReady = ensureSchema(setupPool);
  const openLedgers: WorksetGuardedLedger[] = [];

  afterEach(async () => {
    while (openLedgers.length > 0) await openLedgers.pop()?.dispose();
  });

  afterAll(async () => {
    while (openLedgers.length > 0) await openLedgers.pop()?.dispose();
    await setupPool.close();
  });

  interface Interleaving {
    readonly ordinary: WorksetGuardedLedger;
    readonly management: WorksetGuardedLedger;
    /** Pause the next ordinary mutation after admission, before its transaction. */
    pauseNext(): { readonly admitted: Promise<void>; readonly resume: () => void };
    /** A new instance whose init loads the committed tenant state, bypassing peer caches. */
    observe(): Promise<WorksetGuardedLedger>;
  }

  async function interleaving(): Promise<Interleaving> {
    await schemaReady;
    const projectKey = `t6628-memory-${randomUUID()}`;
    const management = await createPostgresWorksetManagementLedger({
      pool: new SQL({ url: dsn, max: 1 }),
      projectKey,
      displayName: projectKey,
    });
    openLedgers.push(management);
    let latch: { admitted: () => void; resume: Promise<void> } | null = null;
    const ordinary = await createPostgresWorksetGuardedLedger({
      pool: new SQL({ url: dsn, max: 1 }),
      projectKey,
      displayName: projectKey,
      afterGenericAdmit: async () => {
        const current = latch;
        if (current === null) return;
        latch = null;
        current.admitted();
        await current.resume;
      },
    });
    openLedgers.push(ordinary);
    return {
      ordinary,
      management,
      async observe() {
        const observer = await createPostgresWorksetManagementLedger({
          pool: new SQL({ url: dsn, max: 1 }),
          projectKey,
          displayName: projectKey,
        });
        openLedgers.push(observer);
        return observer;
      },
      pauseNext() {
        const admitted = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        latch = { admitted: admitted.resolve, resume: resume.promise };
        return { admitted: admitted.promise, resume: () => resume.resolve() };
      },
    };
  }

  async function createFact(ledger: WorksetGuardedLedger, title: string, status: "active" | "superseded"): Promise<Item> {
    const created = await ledger.mutations.createItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "active",
      fields: { title, content: `${title} body`, kind: "fact" },
    });
    if (status === "active") return created;
    return ledger.mutations.updateItem(MEMORIES_LEDGER, created.id, { status: "superseded" });
  }

  describe(SUITE, () => {
    it("rejects an admitted ordinary update whose fact was promoted before its transaction", async () => {
      const { ordinary, management, pauseNext, observe } = await interleaving();
      const fact = await createFact(ordinary, "promoted under update", "active");
      // The ordinary caller's pre-transaction decision: the target is a fact.
      expect(ordinary.fetchItem(MEMORIES_LEDGER, fact.id).fields.kind).toBe("fact");

      const pause = pauseNext();
      const update = ordinary.mutations.updateItem(MEMORIES_LEDGER, fact.id, {
        fields: { tags: ["stale decision"] },
      });
      await pause.admitted;
      const promoted = await management.mutations.updateItem(MEMORIES_LEDGER, fact.id, {
        fields: { kind: "rule" },
      });
      pause.resume();
      await expect(update).rejects.toThrow(MemoryManagementAuthorityRequiredError);

      expect((await observe()).fetchItem(MEMORIES_LEDGER, fact.id)).toEqual(promoted);

      // Control: once demoted back to a fact, the same ordinary update commits.
      await management.mutations.updateItem(MEMORIES_LEDGER, fact.id, { fields: { kind: "fact" } });
      const updated = await ordinary.mutations.updateItem(MEMORIES_LEDGER, fact.id, {
        fields: { tags: ["fresh decision"] },
      });
      expect(updated.fields).toMatchObject({ kind: "fact", tags: ["fresh decision"] });
    }, 30_000);

    it("rejects an admitted ordinary sweep whose terminal fact was promoted before its transaction", async () => {
      const { ordinary, management, pauseNext, observe } = await interleaving();
      const promotedTarget = await createFact(ordinary, "promoted under sweep", "superseded");
      const sibling = await createFact(ordinary, "sibling fact", "superseded");

      const pause = pauseNext();
      const sweep = ordinary.mutations.archiveTerminalItems(
        [MEMORIES_LEDGER],
        "stale sweep",
        "fail-on-active-gate",
      );
      await pause.admitted;
      await management.mutations.updateItem(MEMORIES_LEDGER, promotedTarget.id, {
        fields: { kind: "environment" },
      });
      pause.resume();
      await expect(sweep).rejects.toThrow(MemoryManagementAuthorityRequiredError);

      // The whole sweep rejected: neither the promoted record nor its fact sibling moved.
      const observer = await observe();
      const fetched = observer.fetch(MEMORIES_LEDGER);
      expect(fetched.archivePointers).toEqual([]);
      const activeIds = fetched.milestones.flatMap((group) => group.items.map((item) => item.id));
      expect(activeIds).toEqual(expect.arrayContaining([promotedTarget.id, sibling.id]));
      expect(observer.fetchItem(MEMORIES_LEDGER, sibling.id)).toEqual(sibling);
      expect(observer.fetchItem(MEMORIES_LEDGER, promotedTarget.id).fields.kind).toBe("environment");

      // Control: after demotion the same ordinary sweep archives both facts.
      await management.mutations.updateItem(MEMORIES_LEDGER, promotedTarget.id, {
        fields: { kind: "fact" },
      });
      const result = await ordinary.mutations.archiveTerminalItems(
        [MEMORIES_LEDGER],
        "fresh sweep",
        "fail-on-active-gate",
      );
      expect(result.archivedItems).toBe(2);
    }, 30_000);
  });
}
