/**
 * G80/M245 write-side dependency-ref canonicalization + dangling-rejection
 * (T551). On every write that touches `dependsOn` / `blockedBy` (create_item,
 * update_item, and the milestone create/update paths), the store:
 *   - NORMALIZES each entry to the canonical `<ledger>:<id>` form via refs.ts
 *     ("T1" → "tasks:T1"), accepting the bare form as ergonomic shorthand;
 *   - REJECTS a NEWLY-ADDED entry that resolves to a known ledger but whose
 *     target does NOT exist (active OR archived) with a typed DanglingRefError;
 *   - passes FREE-TEXT / unresolvable-prefix entries through VERBATIM (advisory,
 *     matching the T552 read-side resolver);
 *   - round-trips entries ALREADY present on the item untouched — a preserved
 *     legacy / free-text / unresolvable value never throws.
 *
 * `ledgerRefs` / `sourceRefs` stay ADVISORY and UNVALIDATED. The rejection must
 * break none of the real flow write orders (plan-flow persists dependency
 * targets before dependents; investigate/seed writes advisory back-links).
 *
 * Dual-adapter: every store-level scenario runs against the fs, sqlite, AND
 * in-memory backends (the shared core.ts guards must behave identically). The
 * tolerance-policy edge (a pre-existing UNRESOLVABLE ref surviving verbatim)
 * is additionally pinned at the pure-core layer, where such state can be
 * constructed directly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  DanglingRefError,
  SchemaValidationError,
  type Item,
  type Ledger,
  type LedgerSchema,
} from "../src/types.js";
import { MILESTONES_AMBIENT_ID, TASKS_SCHEMA } from "../src/constants.js";
import type { LedgerStore } from "../src/store/LedgerStore.js";
import { FsLedgerStore } from "../src/store/FsLedgerStore.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { applyUpdateItem, type RefValidationContext } from "../src/store/core.js";
import { buildPrefixRegistry } from "../src/refs.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const now = (): string => FIXED_NOW;

const dirs: string[] = [];
async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// --- dual-adapter harness ---------------------------------------------------

interface Adapter {
  name: string;
  make: () => Promise<{ store: LedgerStore; dispose: () => Promise<void> }>;
}

const ADAPTERS: Adapter[] = [
  {
    name: "fs",
    make: async () => {
      const store = new FsLedgerStore({ root: await freshDir("t551-fs-"), now });
      await store.init();
      return { store, dispose: () => store.dispose() };
    },
  },
  {
    name: "sqlite",
    make: async () => {
      const dbPath = path.join(await freshDir("t551-sq-"), "ledger.db");
      const store = new SqliteLedgerStore({ dbPath, now });
      await store.init();
      return { store, dispose: () => store.dispose() };
    },
  },
  {
    name: "in-memory",
    make: async () => {
      const store = new InMemoryLedgerStore({ now });
      await store.init();
      return { store, dispose: () => store.dispose() };
    },
  },
];

/** Run `body` against a fresh instance of every backend. */
function eachAdapter(body: (store: LedgerStore) => Promise<void>): () => Promise<void> {
  return async () => {
    for (const adapter of ADAPTERS) {
      const { store, dispose } = await adapter.make();
      try {
        await body(store);
      } catch (err) {
        // Attribute the failure to the specific backend.
        throw new Error(`[${adapter.name}] ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await dispose();
      }
    }
  };
}

/** Create a task under the ambient milestone; returns the created Item. */
function makeTask(
  store: LedgerStore,
  fields: Record<string, string | string[]>,
): Promise<Item> {
  return store.createItem("tasks", MILESTONES_AMBIENT_ID, {
    status: "planned",
    fields: { headline: "task", ...fields },
  });
}

// --- reproduction: dangling ref on create ----------------------------------

describe("T551 dangling-ref rejection", () => {
  test(
    "create_item with dependsOn ['tasks:NOPE9'] throws DanglingRefError (was silently accepted)",
    eachAdapter(async (store) => {
      await expect(makeTask(store, { dependsOn: ["tasks:NOPE9"] })).rejects.toBeInstanceOf(
        DanglingRefError,
      );
    }),
  );

  test(
    "a bare dangling id (known prefix, missing target) is rejected too",
    eachAdapter(async (store) => {
      await expect(makeTask(store, { dependsOn: ["T404"] })).rejects.toBeInstanceOf(
        DanglingRefError,
      );
    }),
  );

  test(
    "dangling blockedBy on update_item is rejected",
    eachAdapter(async (store) => {
      const t = await makeTask(store, {});
      await expect(
        store.updateItem("tasks", t.id, { fields: { blockedBy: ["tasks:T999"] } }),
      ).rejects.toBeInstanceOf(DanglingRefError);
    }),
  );
});

// --- normalization ----------------------------------------------------------

describe("T551 canonicalization of resolvable refs", () => {
  test(
    "bare ['T1'] (existing) persists as ['tasks:T1']",
    eachAdapter(async (store) => {
      const t1 = await makeTask(store, {}); // T1
      expect(t1.id).toBe("T1");
      const dep = await makeTask(store, { dependsOn: ["T1"] }); // T2
      expect(dep.fields["dependsOn"]).toEqual(["tasks:T1"]);
      // Persisted value (re-read) is canonical, not just the returned Item.
      const reread = store.fetchItem("tasks", dep.id);
      expect(reread.fields["dependsOn"]).toEqual(["tasks:T1"]);
    }),
  );

  test(
    "prefixed input is idempotent; a cross-ledger bare id resolves by prefix",
    eachAdapter(async (store) => {
      const t1 = await makeTask(store, {}); // T1
      // A defect dependsOn a bare 'T1' means tasks:T1 (alpha-prefix resolution),
      // NOT defects:T1 — the ref grammar resolves by registered prefix.
      const d = await store.createItem("defects", MILESTONES_AMBIENT_ID, {
        status: "open",
        fields: { headline: "d", severity: "high", dependsOn: ["T1", "tasks:T1"] },
      });
      expect(t1.id).toBe("T1");
      expect(d.fields["dependsOn"]).toEqual(["tasks:T1", "tasks:T1"]);
    }),
  );

  test(
    "a ref to an ARCHIVED task is accepted (archived-existence is legal)",
    eachAdapter(async (store) => {
      const m = await store.createMilestone({ title: "m" }); // M1
      const t = await store.createItem("tasks", m.id, {
        status: "planned",
        fields: { headline: "target" },
      }); // T1
      await store.updateItem("tasks", t.id, { status: "done" }); // terminal
      await store.updateMilestone(m.id, { status: "done" }); // milestone terminal
      await store.archiveMilestone(m.id, "done"); // T1 → archived
      // Reference the now-archived task: accepted + normalized, NOT dangling.
      const dep = await makeTask(store, { dependsOn: ["tasks:T1"] });
      expect(dep.fields["dependsOn"]).toEqual(["tasks:T1"]);
    }),
  );
});

// --- free-text pass-through -------------------------------------------------

describe("T551 free-text / advisory pass-through", () => {
  test(
    "NEW free-text blockedBy passes through verbatim (blockedBy doubles as prose)",
    eachAdapter(async (store) => {
      const t = await makeTask(store, {
        blockedBy: ["waiting on the external security review"],
      });
      expect(t.fields["blockedBy"]).toEqual(["waiting on the external security review"]);
    }),
  );

  test(
    "an unknown-prefix bare id and an unknown-ledger prefixed ref pass through (advisory)",
    eachAdapter(async (store) => {
      // 'ZZ9' — no ledger has idPrefix ZZ; 'nope:X1' — no ledger 'nope'. Both
      // parse-or-not to unresolvable → advisory pass-through, never dangling.
      const t = await makeTask(store, { blockedBy: ["ZZ9", "nope:X1", "M-AMBIENT"] });
      expect(t.fields["blockedBy"]).toEqual(["ZZ9", "nope:X1", "M-AMBIENT"]);
    }),
  );

  test(
    "ledgerRefs / sourceRefs stay advisory — a nonexistent target is NOT rejected",
    eachAdapter(async (store) => {
      const t = await makeTask(store, {
        ledgerRefs: ["goals:G404"],
        sourceRefs: ["defects:D404", "packages/x/y.ts:1-2"],
      });
      expect(t.fields["ledgerRefs"]).toEqual(["goals:G404"]);
      expect(t.fields["sourceRefs"]).toEqual(["defects:D404", "packages/x/y.ts:1-2"]);
    }),
  );
});

// --- round-trip tolerance ---------------------------------------------------

describe("T551 round-trip tolerance (never refuse to re-write held data)", () => {
  test(
    "update reordering/copying existing refs (incl. a preserved free-text entry) does NOT throw",
    eachAdapter(async (store) => {
      const t1 = await makeTask(store, {}); // T1
      const item = await makeTask(store, {
        dependsOn: ["T1"], // → tasks:T1
        blockedBy: ["awaiting design sign-off"], // free-text, preserved
      });
      expect(t1.id).toBe("T1");
      expect(item.fields["dependsOn"]).toEqual(["tasks:T1"]);
      // Copy the current values straight back (what a UI edit does): no throw,
      // values unchanged. Order preserved.
      const updated = await store.updateItem("tasks", item.id, {
        fields: {
          dependsOn: ["tasks:T1"],
          blockedBy: ["awaiting design sign-off"],
        },
      });
      expect(updated.fields["dependsOn"]).toEqual(["tasks:T1"]);
      expect(updated.fields["blockedBy"]).toEqual(["awaiting design sign-off"]);
    }),
  );

  test(
    "adding a NEW dangling entry alongside preserved existing entries still throws",
    eachAdapter(async (store) => {
      await makeTask(store, {}); // T1
      const item = await makeTask(store, { dependsOn: ["T1"] }); // T2 → tasks:T1
      await expect(
        store.updateItem("tasks", item.id, {
          fields: { dependsOn: ["tasks:T1", "tasks:T777"] },
        }),
      ).rejects.toBeInstanceOf(DanglingRefError);
      // The item's stored value is untouched (throw-before-mutate).
      expect(store.fetchItem("tasks", item.id).fields["dependsOn"]).toEqual(["tasks:T1"]);
    }),
  );
});

// --- pure-core tolerance edge: pre-existing UNRESOLVABLE ref ----------------

describe("T551 pure-core: a pre-existing unresolvable ref survives verbatim", () => {
  // The store create path can never persist a dangling ref, so the "legacy
  // unresolvable value the migration preserves verbatim" state is constructed
  // directly against applyUpdateItem — the shared guard every backend reuses.
  function tasksLedgerWith(dependsOn: string[]): Ledger {
    return {
      id: "tasks",
      schema: TASKS_SCHEMA,
      counters: { milestone: 1, item: 2 },
      milestones: [
        {
          id: "M1",
          title: "",
          description: "",
          items: [
            {
              id: "T2",
              milestoneId: "M1",
              status: "planned",
              fields: { headline: "dependent", dependsOn },
              createdAt: FIXED_NOW,
              updatedAt: FIXED_NOW,
            },
          ],
        },
      ],
      archivePointers: [],
    };
  }

  const registry = buildPrefixRegistry([{ name: "tasks", schema: TASKS_SCHEMA }]);
  // Only tasks:T1 exists; tasks:GONE9 resolves (known ledger) but is absent.
  const ctx: RefValidationContext = {
    registry,
    refExists: (ledger, id) => ledger === "tasks" && id === "T1",
  };

  test("copying a pre-existing dangling entry does NOT throw; verbatim + others normalize", () => {
    const ledger = tasksLedgerWith(["tasks:GONE9", "T1"]);
    const out = applyUpdateItem(
      ledger,
      "T2",
      { fields: { dependsOn: ["tasks:GONE9", "T1"] } },
      FIXED_NOW,
      undefined,
      ctx,
    );
    // GONE9 (pre-existing, unresolvable) survives verbatim; T1 normalizes.
    expect(out.fields["dependsOn"]).toEqual(["tasks:GONE9", "tasks:T1"]);
  });

  test("a NEW dangling entry added to the same field throws DanglingRefError", () => {
    const ledger = tasksLedgerWith(["tasks:GONE9"]);
    expect(() =>
      applyUpdateItem(
        ledger,
        "T2",
        { fields: { dependsOn: ["tasks:GONE9", "tasks:GONE8"] } },
        FIXED_NOW,
        undefined,
        ctx,
      ),
    ).toThrow(DanglingRefError);
  });
});

// --- replay: real flow write orders survive the rejection -------------------

describe("T551 replay fixtures — real flow write orders are not broken", () => {
  test(
    "plan-flow: dependency-target task persisted BEFORE dependents → all accepted",
    eachAdapter(async (store) => {
      // Plan-flow orders writes so a task's dependsOn targets already exist.
      const m = await store.createMilestone({ title: "feature" }); // M1
      const t1 = await store.createItem("tasks", m.id, {
        status: "planned",
        fields: { headline: "foundation" },
      }); // T1
      const t2 = await store.createItem("tasks", m.id, {
        status: "planned",
        fields: { headline: "builds on foundation", dependsOn: ["T1"] },
      }); // T2
      const t3 = await store.createItem("tasks", m.id, {
        status: "planned",
        fields: { headline: "builds on both", dependsOn: ["tasks:T1", "T2"] },
      }); // T3
      expect(t1.id).toBe("T1");
      expect(t2.fields["dependsOn"]).toEqual(["tasks:T1"]);
      expect(t3.fields["dependsOn"]).toEqual(["tasks:T1", "tasks:T2"]);
      // A milestone dependency on an existing milestone normalizes too.
      const m2 = await store.createMilestone({ title: "later", dependsOn: ["M1"] }); // M2
      expect(store.fetchItem("milestones", m2.id).fields["dependsOn"]).toEqual([
        "milestones:M1",
      ]);
    }),
  );

  test(
    "investigate/seed: advisory sourceRefs + ledgerRefs back-links written after targets exist",
    eachAdapter(async (store) => {
      const d = await store.createItem("defects", MILESTONES_AMBIENT_ID, {
        status: "open",
        fields: { headline: "defect", severity: "high" },
      }); // D1
      // A seeded goal links the defect via advisory sourceRefs — never validated,
      // so even before any reverse link exists this is accepted.
      const g = await store.createItem("goals", MILESTONES_AMBIENT_ID, {
        status: "clarifying",
        fields: {
          title: "fix the defect",
          description: "goal seeded from D1",
          sourceRefs: [`defects:${d.id}`],
        },
      }); // G1
      // The defect-side ledgerRefs back-link is written AFTER the goal exists.
      const updated = await store.updateItem("defects", d.id, {
        fields: { ledgerRefs: [`goals:${g.id}`] },
      });
      expect(updated.fields["ledgerRefs"]).toEqual([`goals:${g.id}`]);
      expect(store.fetchItem("goals", g.id).fields["sourceRefs"]).toEqual([`defects:${d.id}`]);
    }),
  );
});

// --- D98: satisfiesDependencyStatuses ⊆ terminalStatuses --------------------

describe("T551 / D98 schema validation", () => {
  const CUSTOM_BAD: LedgerSchema = {
    statusValues: ["open", "active", "done"],
    terminalStatuses: ["done"],
    // 'active' is NON-terminal → incoherent as a satisfying status.
    satisfiesDependencyStatuses: ["active"],
    idPrefix: "W",
    fields: { headline: { type: "string", required: true } },
  };
  const CUSTOM_OK: LedgerSchema = {
    ...CUSTOM_BAD,
    satisfiesDependencyStatuses: ["done"],
  };

  test(
    "create_ledger rejects a non-terminal satisfying status",
    eachAdapter(async (store) => {
      await expect(store.createLedger("widgets", CUSTOM_BAD)).rejects.toBeInstanceOf(
        SchemaValidationError,
      );
    }),
  );

  test(
    "create_ledger accepts a satisfying status that IS terminal",
    eachAdapter(async (store) => {
      const l = await store.createLedger("widgets", CUSTOM_OK);
      expect(l.schema.satisfiesDependencyStatuses).toEqual(["done"]);
    }),
  );
});
