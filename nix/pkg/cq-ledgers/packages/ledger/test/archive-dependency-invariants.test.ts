/**
 * T825 — fail-first reproduction: archiving a NON-SATISFYING dependency
 * target silently unblocks its dependents (false-unblock), across every
 * write/archive ordering.
 *
 * The invariant under test: an ACTIVE NON-TERMINAL item whose `dependsOn`
 * resolves to a target whose status is NOT in that ledger's
 * `satisfiesDependencyStatuses` (e.g. an `upstream` item in `wontfix`) must
 * keep gating — the dependency must never become "satisfied" merely because
 * the target left the active store. Today the gate is lost along THREE
 * unguarded orderings (reproduced below on fs, sqlite, AND in-memory):
 *
 *  A. archive-before-dependent-still-active: `archiveMilestone` only checks
 *     that the milestone's OWN items are terminal (applyDetachMilestoneGroup/
 *     applyDetachMilestoneItem). It never scans for INCOMING `dependsOn`
 *     edges from active items in other milestones, so a `wontfix` target is
 *     archived under a live dependent. The read-side resolver
 *     (predicates.ts dependencySatisfied) treats an unresolvable (archived)
 *     target as SATISFIED → the dependent flips from blocked to ready
 *     (false-unblock). Expected: the archive REFUSES while an active
 *     non-terminal incoming dependency on a non-satisfying item exists.
 *
 *  B. archive-before-new-write: the write-side ref check
 *     (core.ts processRefEntry → RefValidationContext.refExists) counts an
 *     ARCHIVED item as existing ("referencing an archived item is legal"),
 *     so a NEWLY-ADDED `dependsOn` on an archived `wontfix` target is
 *     accepted — and is born already "satisfied" (false-unblock). Expected:
 *     create/update adding such a ref (bare `U1` or canonical `upstream:U1`)
 *     REJECTS, mirroring the DanglingRefError family.
 *
 *  C. terminalize → archive → reopen: a dependent task may go `done`, which
 *     legitimately allows the target's archival (no ACTIVE dependent); but
 *     `reopenItem` (applyReopenItem) performs NO dependency check, so the
 *     task returns to `wip` with its retained gate pointing at an archived
 *     non-satisfying target — satisfied on arrival (false-unblock).
 *     Expected: the reopen REJECTS until the gate is explicitly removed.
 *
 *  Races: reopen vs archive has no guarded ordering. Run BOTH
 *     serializations deterministically (reopen-then-archive, archive-then-
 *     reopen) and once barrier-concurrently: exactly one of the two
 *     operations must refuse so the invariant holds in every interleaving.
 *     Today BOTH succeed in every ordering.
 *
 * Compatibility bounds (plain `test` — GREEN today, must STAY green; they
 * fence the fix away from over-blocking):
 *  - an unrelated update to an item that already carries a PRE-EXISTING
 *    archived non-satisfying dependency succeeds and preserves the entry
 *    verbatim (core.ts new-versus-existing semantics — pre-existing entries
 *    never throw);
 *  - archiving a SATISFYING (`released`) target under an active dependent is
 *    allowed and the dependent stays satisfied before/after;
 *  - a newly-added ref to an archived SATISFYING target is still accepted
 *    (the upstream analogue of the T551 archived-`done`-task rule);
 *  - removing the gate unblocks both orderings (archive allowed; reopen
 *    allowed);
 *  - a fully-terminal dependent set never blocks archival;
 *  - advisory free-text / unresolvable `dependsOn` entries neither gate nor
 *    block archival.
 *
 * The reproduction bodies run under bun `test.failing`: today they throw
 * (the false-unblock reproduces) and are reported as EXPECTED failures —
 * suite green, exit 0. When the fix lands they unexpectedly PASS and the
 * suite turns RED, prompting the fixer to flip them to plain `test`.
 *
 * Touches NO production code — reproduction + compatibility controls only.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Item } from "../src/types.js";
import {
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  UPSTREAM_LEDGER,
} from "../src/constants.js";
import type { LedgerStore } from "../src/store/LedgerStore.js";
import { FsLedgerStore } from "../src/store/FsLedgerStore.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { taskDependenciesSatisfied } from "../src/store/predicates.js";

const dirs: string[] = [];
async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// --- cross-store harness ----------------------------------------------------

interface Adapter {
  name: string;
  make: () => Promise<{ store: LedgerStore; dispose: () => Promise<void> }>;
}

const ADAPTERS: Adapter[] = [
  {
    name: "fs",
    make: async () => {
      const store = new FsLedgerStore({ root: await freshDir("t825-fs-") });
      await store.init();
      return { store, dispose: () => store.dispose() };
    },
  },
  {
    name: "sqlite",
    make: async () => {
      const dbPath = path.join(await freshDir("t825-sq-"), "ledger.db");
      const store = new SqliteLedgerStore({ dbPath });
      await store.init();
      return { store, dispose: () => store.dispose() };
    },
  },
  {
    name: "in-memory",
    make: async () => {
      const store = new InMemoryLedgerStore({});
      await store.init();
      return { store, dispose: () => store.dispose() };
    },
  },
];

// --- fixtures ----------------------------------------------------------------

/** A dependent task under the ambient milestone (never itself archived). */
function makeTask(
  store: LedgerStore,
  fields: Record<string, string | string[]>,
): Promise<Item> {
  return store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
    status: "planned",
    fields: { headline: "dependent task", ...fields },
  });
}

/** An upstream item driven to `wontfix` — TERMINAL but NON-SATISFYING. */
async function makeWontfixUpstream(store: LedgerStore, milestoneId: string): Promise<Item> {
  const item = await store.createItem(UPSTREAM_LEDGER, milestoneId, {
    status: "open",
    fields: { headline: "upstream defect", package: "libfoo" },
  });
  return store.updateItem(UPSTREAM_LEDGER, item.id, { status: "wontfix" });
}

/** An upstream item driven to `released` — TERMINAL and SATISFYING. */
async function makeReleasedUpstream(store: LedgerStore, milestoneId: string): Promise<Item> {
  const item = await store.createItem(UPSTREAM_LEDGER, milestoneId, {
    status: "open",
    fields: { headline: "upstream defect", package: "libfoo" },
  });
  await store.updateItem(UPSTREAM_LEDGER, item.id, { status: "reported" });
  return store.updateItem(UPSTREAM_LEDGER, item.id, { status: "released" });
}

/** Read-side readiness of a task (predicates.ts dependencySatisfied). */
function ready(store: LedgerStore, taskId: string): boolean {
  return taskDependenciesSatisfied(store, store.fetchItem(TASKS_LEDGER, taskId));
}

/** True iff `itemId` is still in the ACTIVE store (fetchItem is active-only). */
function isActiveItem(store: LedgerStore, ledgerId: string, itemId: string): boolean {
  try {
    store.fetchItem(ledgerId, itemId);
    return true;
  } catch {
    return false;
  }
}

/** N-party rendezvous: every caller proceeds only once all have arrived. */
function newBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await gate;
  };
}

// --- the suite ---------------------------------------------------------------

for (const adapter of ADAPTERS) {
  describe(`T825 archive/ref invariant — false-unblock (${adapter.name})`, () => {
    async function withStore(body: (store: LedgerStore) => Promise<void>): Promise<void> {
      const { store, dispose } = await adapter.make();
      try {
        await body(store);
      } finally {
        await dispose();
      }
    }

    // -- A: active nonterminal incoming dependsOn must prevent archiving a
    //       non-satisfying target. TODAY: the archive succeeds and the
    //       dependent flips blocked → ready (false-unblock).
    test("A: archive refuses while an active nonterminal incoming dependsOn targets a non-satisfying item", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeWontfixUpstream(store, m.id);
        const t = await makeTask(store, { dependsOn: [`upstream:${u.id}`] });
        // Correctly gated while the target is active.
        expect(ready(store, t.id)).toBe(false);
        await store.updateMilestone(m.id, { status: "done" });
        await expect(store.archiveMilestone(m.id, "done")).rejects.toThrow();
        // After the refused archive: target still active, dependent still gated.
        expect(isActiveItem(store, UPSTREAM_LEDGER, u.id)).toBe(true);
        expect(ready(store, t.id)).toBe(false);
      }),
    );

    // -- B: after an UNREFERENCED upstream:wontfix archival, newly adding a
    //       dependsOn (create/update × bare/canonical) must reject. TODAY:
    //       refExists counts archived items as existing, so the write is
    //       accepted and born satisfied (false-unblock).
    test("B: newly-added dependsOn on an archived non-satisfying target rejects (create/update, bare/canonical)", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeWontfixUpstream(store, m.id);
        await store.updateMilestone(m.id, { status: "done" });
        // Unreferenced → the archival itself is legal in every world.
        await store.archiveMilestone(m.id, "done");
        // create, canonical form.
        await expect(makeTask(store, { dependsOn: [`upstream:${u.id}`] })).rejects.toThrow();
        // create, bare form.
        await expect(makeTask(store, { dependsOn: [u.id] })).rejects.toThrow();
        // update, canonical form.
        const t1 = await makeTask(store, {});
        await expect(
          store.updateItem(TASKS_LEDGER, t1.id, { fields: { dependsOn: [`upstream:${u.id}`] } }),
        ).rejects.toThrow();
        // update, bare form.
        const t2 = await makeTask(store, {});
        await expect(
          store.updateItem(TASKS_LEDGER, t2.id, { fields: { dependsOn: [u.id] } }),
        ).rejects.toThrow();
      }),
    );

    // -- C: terminalize → archive → reopen. The reopen with the RETAINED gate
    //       must reject until the gate is explicitly removed. TODAY: reopen
    //       performs no dependency check; the task returns to wip already
    //       satisfied (false-unblock).
    test("C: reopening a dependent with a retained gate on an archived non-satisfying target rejects until the gate is removed", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeWontfixUpstream(store, m.id);
        const t = await makeTask(store, { dependsOn: [`upstream:${u.id}`] });
        await store.updateItem(TASKS_LEDGER, t.id, { status: "done" });
        await store.updateMilestone(m.id, { status: "done" });
        // Legal: the ONLY incoming dependent is terminal.
        await store.archiveMilestone(m.id, "done");
        // The retained gate rejects the reopen…
        await expect(store.reopenItem(TASKS_LEDGER, t.id, "wip")).rejects.toThrow();
        expect(store.fetchItem(TASKS_LEDGER, t.id).status).toBe("done");
        // …until the gate is explicitly removed.
        await store.updateItem(TASKS_LEDGER, t.id, { fields: { dependsOn: [] } });
        const reopened = await store.reopenItem(TASKS_LEDGER, t.id, "wip");
        expect(reopened.status).toBe("wip");
        expect(ready(store, t.id)).toBe(true); // no gate → legitimately ready
      }),
    );

    // -- Race, deterministic ordering 1: reopen lands FIRST, so the archive
    //       must refuse (scenario A kicks in). TODAY: both succeed.
    test("race ordering (reopen → archive): the archive refuses once the dependent is active again", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeWontfixUpstream(store, m.id);
        const t = await makeTask(store, { dependsOn: [`upstream:${u.id}`] });
        await store.updateItem(TASKS_LEDGER, t.id, { status: "done" });
        await store.updateMilestone(m.id, { status: "done" });
        // Reopen lands first — legal: the gate target is still ACTIVE (and
        // non-satisfying, so the task is correctly gated, not falsely unblocked).
        await store.reopenItem(TASKS_LEDGER, t.id, "wip");
        expect(ready(store, t.id)).toBe(false);
        // The archive must now refuse: an active nonterminal incoming
        // dependsOn targets a non-satisfying item of this milestone.
        await expect(store.archiveMilestone(m.id, "done")).rejects.toThrow();
        expect(isActiveItem(store, UPSTREAM_LEDGER, u.id)).toBe(true);
      }),
    );

    // -- Race, deterministic ordering 2: archive lands FIRST (legal — the
    //       dependent is terminal), so the reopen must refuse (scenario C).
    //       TODAY: both succeed.
    test("race ordering (archive → reopen): the reopen refuses while the gate is retained", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeWontfixUpstream(store, m.id);
        const t = await makeTask(store, { dependsOn: [`upstream:${u.id}`] });
        await store.updateItem(TASKS_LEDGER, t.id, { status: "done" });
        await store.updateMilestone(m.id, { status: "done" });
        await store.archiveMilestone(m.id, "done");
        await expect(store.reopenItem(TASKS_LEDGER, t.id, "wip")).rejects.toThrow();
        expect(store.fetchItem(TASKS_LEDGER, t.id).status).toBe("done");
      }),
    );

    // -- Race, barrier-concurrent: both operations are released together;
    //       EXACTLY ONE must refuse so the invariant holds in whichever
    //       serialization the locks choose. TODAY: both succeed.
    test("race (barrier-concurrent): exactly one of reopen/archive refuses — never an active dependent on an archived non-satisfying target", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeWontfixUpstream(store, m.id);
        const t = await makeTask(store, { dependsOn: [`upstream:${u.id}`] });
        await store.updateItem(TASKS_LEDGER, t.id, { status: "done" });
        await store.updateMilestone(m.id, { status: "done" });
        const arrive = newBarrier(2);
        const outcomes = await Promise.allSettled([
          (async () => {
            await arrive();
            await store.reopenItem(TASKS_LEDGER, t.id, "wip");
          })(),
          (async () => {
            await arrive();
            await store.archiveMilestone(m.id, "done");
          })(),
        ]);
        const rejected = outcomes.filter((o) => o.status === "rejected");
        expect(rejected.length).toBe(1);
        // The invariant, order-agnostically: either the reopen lost (task
        // still terminal under the archived target) or the archive lost
        // (target still active, still gating the reopened task).
        const tAfter = store.fetchItem(TASKS_LEDGER, t.id);
        const invariantHolds =
          tAfter.status === "done" || isActiveItem(store, UPSTREAM_LEDGER, u.id);
        expect(invariantHolds).toBe(true);
      }),
    );

    // ------------------------------------------------------------------
    // Compatibility controls — GREEN today, must STAY green post-fix.
    // ------------------------------------------------------------------

    test("control: an unrelated update preserves a pre-existing archived non-satisfying dependency verbatim", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeWontfixUpstream(store, m.id);
        const t = await makeTask(store, { dependsOn: [`upstream:${u.id}`] });
        // Terminalize the dependent so the archival is legal in BOTH the
        // current and the fixed world (scenario C's legal half).
        await store.updateItem(TASKS_LEDGER, t.id, { status: "done" });
        await store.updateMilestone(m.id, { status: "done" });
        await store.archiveMilestone(m.id, "done");
        // (i) An unrelated field-only update never re-validates the gate.
        const renamed = await store.updateItem(TASKS_LEDGER, t.id, {
          fields: { headline: "renamed" },
        });
        expect(renamed.fields["dependsOn"]).toEqual([`upstream:${u.id}`]);
        // (ii) A UI-style round-trip re-submitting the pre-existing entry
        // alongside the unrelated change is new-versus-existing tolerant:
        // the entry is NOT newly-added → preserved verbatim, never throws.
        const resubmitted = await store.updateItem(TASKS_LEDGER, t.id, {
          fields: { headline: "renamed again", dependsOn: [`upstream:${u.id}`] },
        });
        expect(resubmitted.fields["dependsOn"]).toEqual([`upstream:${u.id}`]);
        expect(store.fetchItem(TASKS_LEDGER, t.id).fields["dependsOn"]).toEqual([
          `upstream:${u.id}`,
        ]);
      }),
    );

    test("control: archiving a SATISFYING (released) target under an active dependent is allowed; the dependent stays satisfied", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeReleasedUpstream(store, m.id);
        const t = await makeTask(store, { dependsOn: [`upstream:${u.id}`] });
        // Released satisfies the gate — legitimately ready BEFORE archival.
        expect(ready(store, t.id)).toBe(true);
        await store.updateMilestone(m.id, { status: "done" });
        await store.archiveMilestone(m.id, "done");
        // …and still satisfied after — a correct unblock, not a false one.
        expect(ready(store, t.id)).toBe(true);
      }),
    );

    test("control: a newly-added dependsOn on an archived SATISFYING (released) target is accepted and satisfied", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeReleasedUpstream(store, m.id);
        await store.updateMilestone(m.id, { status: "done" });
        await store.archiveMilestone(m.id, "done");
        // The upstream analogue of the T551 archived-`done`-task rule:
        // referencing an archived SATISFYING item stays legal.
        const t = await makeTask(store, { dependsOn: [`upstream:${u.id}`] });
        expect(t.fields["dependsOn"]).toEqual([`upstream:${u.id}`]);
        expect(ready(store, t.id)).toBe(true);
      }),
    );

    test("control: removing the gate unblocks both orderings (archive allowed; reopen allowed)", () =>
      withStore(async (store) => {
        // (i) Dependent drops the gate while the target is active → archive allowed.
        const m1 = await store.createMilestone({ title: "first" });
        const u1 = await makeWontfixUpstream(store, m1.id);
        const t1 = await makeTask(store, { dependsOn: [`upstream:${u1.id}`] });
        await store.updateItem(TASKS_LEDGER, t1.id, { fields: { dependsOn: [] } });
        await store.updateMilestone(m1.id, { status: "done" });
        await store.archiveMilestone(m1.id, "done");
        expect(isActiveItem(store, UPSTREAM_LEDGER, u1.id)).toBe(false);
        // (ii) Gate removed after archival (dependent terminal) → reopen allowed.
        const m2 = await store.createMilestone({ title: "second" });
        const u2 = await makeWontfixUpstream(store, m2.id);
        const t2 = await makeTask(store, { dependsOn: [`upstream:${u2.id}`] });
        await store.updateItem(TASKS_LEDGER, t2.id, { status: "done" });
        await store.updateMilestone(m2.id, { status: "done" });
        await store.archiveMilestone(m2.id, "done");
        await store.updateItem(TASKS_LEDGER, t2.id, { fields: { dependsOn: [] } });
        const reopened = await store.reopenItem(TASKS_LEDGER, t2.id, "wip");
        expect(reopened.status).toBe("wip");
        expect(ready(store, t2.id)).toBe(true);
      }),
    );

    test("control: a fully-terminal dependent set never blocks archival of a non-satisfying target", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeWontfixUpstream(store, m.id);
        const t1 = await makeTask(store, { dependsOn: [`upstream:${u.id}`] });
        const t2 = await makeTask(store, { dependsOn: [`upstream:${u.id}`] });
        await store.updateItem(TASKS_LEDGER, t1.id, { status: "done" });
        await store.updateItem(TASKS_LEDGER, t2.id, { status: "abandoned" });
        await store.updateMilestone(m.id, { status: "done" });
        await store.archiveMilestone(m.id, "done");
        expect(isActiveItem(store, UPSTREAM_LEDGER, u.id)).toBe(false);
      }),
    );

    test("control: advisory free-text / unresolvable dependsOn entries neither gate nor block archival", () =>
      withStore(async (store) => {
        const m = await store.createMilestone({ title: "upstream fixes" });
        const u = await makeWontfixUpstream(store, m.id);
        // Free text and an unknown-prefix id: advisory pass-through, never a
        // gate (the read-side resolver treats them as satisfied).
        const t = await makeTask(store, {
          dependsOn: ["waiting on upstream to cut a release", "ZZ9"],
        });
        expect(ready(store, t.id)).toBe(true);
        await store.updateMilestone(m.id, { status: "done" });
        // The active task's advisory entries do not reference U → no block.
        await store.archiveMilestone(m.id, "done");
        expect(isActiveItem(store, UPSTREAM_LEDGER, u.id)).toBe(false);
        expect(ready(store, t.id)).toBe(true);
      }),
    );
  });
}
