/**
 * Abstract test suite for LedgerStore (msunify shape).
 *
 * Same suite runs against:
 *   - FsLedgerStore (against a freshly-created tmp dir per test)
 *   - InMemoryLedgerStore (dual-tests dummy)
 *
 * Dual-tests principle: the production adapter and the in-memory dummy must
 * be observationally indistinguishable for the behaviours exercised here.
 *
 * The milestones ledger is bootstrapped automatically by `init()`; tests
 * `createMilestone` into it as needed without seeding a `milestones`
 * entry.
 */

import { describe, it, expect } from "bun:test";
import type { LedgerSchema, LedgerStore } from "../src/index.js";
import {
  MILESTONES_LEDGER,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_AMBIENT_ID,
  CANONICAL_LEDGERS,
  isIsoTimestamp,
} from "../src/index.js";

// All canonical ledgers are bootstrapped on init(); the suite therefore
// uses NON-canonical custom ledgers (distinct idPrefixes) for the seed and
// create paths so it never collides with a bootstrapped name/prefix.
const BOOTSTRAPPED = CANONICAL_LEDGERS.map((c) => c.name).sort();

export interface AbstractStoreFactory {
  /** Build a fresh store with the given pre-registered ledgers (besides milestones). */
  build(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<LedgerStore>;
  /**
   * Build a fresh store wiring an `onMutation` hook. Same seed contract
   * as `build`. Used by D-COHERENCE coverage to assert hook firing.
   */
  buildWithHook(
    seed: Array<{ name: string; schema: LedgerSchema }>,
    onMutation: (ledgerId: string, op: "create" | "update" | "archive") => void,
  ): Promise<LedgerStore>;
  /** Optional teardown hook (e.g. remove tmp dir). */
  teardown?(store: LedgerStore): Promise<void>;
  name: string;
}

// Custom (non-canonical) ledgers, named so their default idPrefix (W, N)
// does not collide with any bootstrapped canonical prefix.
const WIDGETS = "widgets";
const NOTES = "notes";

const widgetsSchema: LedgerSchema = {
  statusValues: ["open", "in-progress", "resolved", "abandoned"],
  terminalStatuses: ["resolved", "abandoned"],
  fields: {
    severity: { type: "string", required: true },
    location: { type: "string", required: true },
    description: { type: "string", required: true },
    rootCause: { type: "string", required: false },
    relatedIds: { type: "id[]", required: false },
  },
};

const notesSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: {
    notes: { type: "string", required: false },
  },
};

export function runStoreAbstractSuite(factory: AbstractStoreFactory): void {
  describe(`LedgerStore (abstract suite, ${factory.name})`, () => {
    it("enumerate() lists seeded ledgers + every bootstrapped canonical ledger, sorted", async () => {
      const store = await factory.build([
        { name: WIDGETS, schema: widgetsSchema },
        { name: NOTES, schema: notesSchema },
      ]);
      try {
        // All seven canonical ledgers are bootstrapped on init() (§8, B).
        expect(store.enumerate()).toEqual([...BOOTSTRAPPED, WIDGETS, NOTES].sort());
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("createMilestone allocates M<n> from milestones-ledger item counter", async () => {
      const store = await factory.build([]);
      try {
        const m1 = await store.createMilestone({ title: "first" });
        expect(m1.id).toBe("M1");
        const m2 = await store.createMilestone({ title: "second" });
        expect(m2.id).toBe("M2");
        // Fields are persisted on the milestone-item.
        expect(m1.fields["title"]).toBe("first");
        expect(m1.status).toBe("open");
        // createdAt / updatedAt are ISO strings.
        expect(isIsoTimestamp(m1.createdAt)).toBe(true);
        expect(isIsoTimestamp(m1.updatedAt)).toBe(true);
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("createItem auto-creates the depth-2 group in a non-milestones ledger on first reference", async () => {
      const store = await factory.build([{ name: WIDGETS, schema: widgetsSchema }]);
      try {
        const m = await store.createMilestone({ title: "x" });
        const item1 = await store.createItem(WIDGETS, m.id, {
          status: "open",
          fields: { severity: "minor", location: "x.ts", description: "foo" },
        });
        expect(item1.id).toBe("W1");
        expect(item1.milestoneId).toBe(m.id);
        const item2 = await store.createItem(WIDGETS, m.id, {
          status: "open",
          fields: { severity: "nit", location: "y.ts", description: "bar" },
        });
        expect(item2.id).toBe("W2");
        const ledger = store.fetch(WIDGETS);
        // Counter only tracks items, never milestones in non-milestones ledgers.
        expect(ledger.counters).toEqual({ milestone: 0, item: 2 });
        // Resolved milestone metadata is filled from the milestones ledger.
        expect(ledger.milestones).toHaveLength(1);
        const g = ledger.milestones[0];
        expect(g?.id).toBe(m.id);
        expect(g?.milestone.title).toBe("x");
        expect(g?.milestone.status).toBe("open");
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("create_item refuses an absent / archived / terminal milestone id (strict existence)", async () => {
      const store = await factory.build([{ name: WIDGETS, schema: widgetsSchema }]);
      try {
        // Absent
        await expect(
          store.createItem(WIDGETS, "M99", {
            status: "open",
            fields: { severity: "minor", location: "x.ts", description: "foo" },
          }),
        ).rejects.toThrow(/does not exist/);
        // Terminal: milestone marked done refuses.
        const m = await store.createMilestone({ title: "done-already" });
        await store.updateMilestone(m.id, { status: "done" });
        await expect(
          store.createItem(WIDGETS, m.id, {
            status: "open",
            fields: { severity: "minor", location: "x.ts", description: "foo" },
          }),
        ).rejects.toThrow(/terminal status/);
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("caller-supplied milestone id is honoured; duplicate is refused", async () => {
      const store = await factory.build([]);
      try {
        const m = await store.createMilestone({ id: "M5", title: "x" });
        expect(m.id).toBe("M5");
        // Counter was 0; supplied M5 sets next to 6; auto-create increments
        // to 7 and issues "M7".
        const m2 = await store.createMilestone({ title: "y" });
        expect(m2.id).toBe("M7");
        await expect(
          store.createMilestone({ id: "M5", title: "dup" }),
        ).rejects.toThrow(/Duplicate item id/);
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("updateItem mutates status + fields and bumps updatedAt", async () => {
      const store = await factory.build([{ name: WIDGETS, schema: widgetsSchema }]);
      try {
        const m = await store.createMilestone({ title: "x" });
        const created = await store.createItem(WIDGETS, m.id, {
          status: "open",
          fields: { severity: "minor", location: "x.ts", description: "foo" },
        });
        // Use a tiny delay so updatedAt strictly increases under wall clock.
        await new Promise((r) => setTimeout(r, 2));
        const updated = await store.updateItem(WIDGETS, created.id, {
          status: "resolved",
          fields: { rootCause: "rc", relatedIds: ["W2"] },
        });
        expect(updated.status).toBe("resolved");
        expect(updated.fields["rootCause"]).toBe("rc");
        expect(updated.fields["relatedIds"]).toEqual(["W2"]);
        expect(updated.fields["severity"]).toBe("minor");
        expect(isIsoTimestamp(updated.updatedAt)).toBe(true);
        expect(updated.updatedAt >= created.updatedAt).toBe(true);
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("invalid status / unknown field / missing required field are rejected", async () => {
      const store = await factory.build([{ name: WIDGETS, schema: widgetsSchema }]);
      try {
        const m = await store.createMilestone({ title: "x" });
        await expect(
          store.createItem(WIDGETS, m.id, {
            status: "BOGUS",
            fields: { severity: "minor", location: "x.ts", description: "foo" },
          }),
        ).rejects.toThrow(/Invalid status/);
        await expect(
          store.createItem(WIDGETS, m.id, {
            status: "open",
            fields: { severity: "minor", location: "x.ts" /* missing description */ },
          }),
        ).rejects.toThrow(/Missing required field/);
        await expect(
          store.createItem(WIDGETS, m.id, {
            status: "open",
            fields: {
              severity: "minor",
              location: "x.ts",
              description: "ok",
              unknownThing: "x",
            },
          }),
        ).rejects.toThrow(/unknown field/);
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("search returns items matching status, string field, or array field", async () => {
      const store = await factory.build([{ name: WIDGETS, schema: widgetsSchema }]);
      try {
        const m = await store.createMilestone({ title: "x" });
        const a = await store.createItem(WIDGETS, m.id, {
          status: "open",
          fields: { severity: "minor", location: "Stream.tsx", description: "scroll bug" },
        });
        const b = await store.createItem(WIDGETS, m.id, {
          status: "resolved",
          fields: { severity: "major", location: "Header.tsx", description: "badge order" },
        });
        const c = await store.createItem(WIDGETS, m.id, {
          status: "open",
          fields: {
            severity: "nit",
            location: "Input.tsx",
            description: "labelled",
            relatedIds: ["W1"],
          },
        });
        expect(store.search(WIDGETS, "resolved").map((i) => i.id)).toEqual([b.id]);
        expect(store.search(WIDGETS, "stream").map((i) => i.id)).toEqual([a.id]);
        expect(store.search(WIDGETS, "W1").map((i) => i.id)).toEqual([c.id]);
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("archiveMilestone (global) refuses non-terminal items in ANY ledger, succeeds when all terminal", async () => {
      const store = await factory.build([
        { name: WIDGETS, schema: widgetsSchema },
        { name: NOTES, schema: notesSchema },
      ]);
      try {
        const m = await store.createMilestone({ title: "M-one" });
        const it1 = await store.createItem(WIDGETS, m.id, {
          status: "open",
          fields: { severity: "minor", location: "x.ts", description: "foo" },
        });
        await store.createItem(WIDGETS, m.id, {
          status: "resolved",
          fields: { severity: "minor", location: "y.ts", description: "bar" },
        });
        // The milestone itself is non-terminal.
        await expect(
          store.archiveMilestone(m.id, "summary"),
        ).rejects.toThrow(/not in terminal status/);
        // Resolve the open defect, but milestone-item still open.
        await store.updateItem(WIDGETS, it1.id, { status: "resolved" });
        await expect(
          store.archiveMilestone(m.id, "summary"),
        ).rejects.toThrow(/terminal status/);
        // Mark milestone done.
        await store.updateMilestone(m.id, { status: "done" });
        // Now succeeds.
        const ptr = await store.archiveMilestone(m.id, "summary one");
        expect(ptr.id).toBe(m.id);
        expect(ptr.path).toBe(`./archive/${MILESTONES_LEDGER}/${m.id}.md`);
        expect(ptr.summary).toBe("summary one");
        // Defects ledger: depth-2 group gone, archive pointer recorded.
        const defects = store.fetch(WIDGETS);
        expect(defects.milestones.map((g) => g.id)).toEqual([]);
        expect(defects.archivePointers.map((p) => p.id)).toEqual([m.id]);
        // Milestones ledger: milestone-item gone, archive pointer recorded.
        const ms = store.fetch(MILESTONES_LEDGER);
        const activeGroup = ms.milestones.find(
          (g) => g.id === MILESTONES_ACTIVE_GROUP_ID,
        );
        // Only the immortal M-AMBIENT bootstrap milestone remains (§8b);
        // the archived m.id is gone.
        expect(activeGroup?.items.map((i) => i.id)).toEqual([MILESTONES_AMBIENT_ID]);
        expect(ms.archivePointers.map((p) => p.id)).toEqual([m.id]);
        // Group archive in defects is readable.
        const defectsArchive = await store.fetchArchive(WIDGETS, m.id);
        expect(defectsArchive.kind).toBe("group");
        if (defectsArchive.kind === "group") {
          expect(defectsArchive.milestone.items.length).toBe(2);
        }
        // Milestone-item archive in the milestones ledger is readable.
        const msArchive = await store.fetchArchive(MILESTONES_LEDGER, m.id);
        expect(msArchive.kind).toBe("item");
        if (msArchive.kind === "item") {
          expect(msArchive.item.id).toBe(m.id);
          expect(msArchive.item.fields["title"]).toBe("M-one");
        }
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("archiveMilestone refuses the bootstrap group M0", async () => {
      const store = await factory.build([]);
      try {
        await expect(
          store.archiveMilestone(MILESTONES_ACTIVE_GROUP_ID, "no"),
        ).rejects.toThrow(/bootstrap/);
      } finally {
        await factory.teardown?.(store);
      }
    });

    // -----------------------------------------------------------------------
    // §8b — M-AMBIENT immortal bootstrap milestone
    // -----------------------------------------------------------------------

    describe("§8b — M-AMBIENT bootstrap milestone", () => {
      it("is bootstrapped on init (title 'ambient', status open) and resolvable", async () => {
        const store = await factory.build([]);
        try {
          const view = store.fetchMilestone(MILESTONES_AMBIENT_ID);
          expect(view.milestone.id).toBe(MILESTONES_AMBIENT_ID);
          expect(view.resolved.title).toBe("ambient");
          expect(view.resolved.status).toBe("open");
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("archive is refused (immortal)", async () => {
        const store = await factory.build([]);
        try {
          await expect(
            store.archiveMilestone(MILESTONES_AMBIENT_ID, "no"),
          ).rejects.toThrow(/immortal/);
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("moving it to a terminal status is refused (immortal)", async () => {
        const store = await factory.build([]);
        try {
          await expect(
            store.updateMilestone(MILESTONES_AMBIENT_ID, { status: "done" }),
          ).rejects.toThrow(/immortal/);
          // A non-terminal update still works (e.g. a description edit).
          const updated = await store.updateMilestone(MILESTONES_AMBIENT_ID, {
            description: "reserved bootstrap milestone",
          });
          expect(updated.fields["description"]).toBe("reserved bootstrap milestone");
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("items in other ledgers can be filed under M-AMBIENT", async () => {
        const store = await factory.build([{ name: WIDGETS, schema: widgetsSchema }]);
        try {
          const it = await store.createItem(WIDGETS, MILESTONES_AMBIENT_ID, {
            status: "open",
            fields: { severity: "nit", location: "x.ts", description: "ambient defect" },
          });
          expect(it.milestoneId).toBe(MILESTONES_AMBIENT_ID);
          const grouped = store.listMilestoneItems(MILESTONES_AMBIENT_ID);
          expect(grouped[WIDGETS]?.map((i) => i.id)).toEqual([it.id]);
        } finally {
          await factory.teardown?.(store);
        }
      });
    });

    it("createLedger adds a ledger and refuses the reserved name 'milestones'", async () => {
      const store = await factory.build([]);
      try {
        const l = await store.createLedger("xenos", {
          statusValues: ["open", "done"],
          terminalStatuses: ["done"],
          fields: { notes: { type: "string", required: false } },
        });
        expect(l.id).toBe("xenos");
        expect(store.enumerate()).toContain("xenos");
        await expect(
          store.createLedger("xenos", {
            statusValues: ["a"],
            terminalStatuses: [],
            fields: {},
          }),
        ).rejects.toThrow(/Duplicate ledger/);
        await expect(
          store.createLedger(MILESTONES_LEDGER, notesSchema),
        ).rejects.toThrow(/reserved/);
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("fetch / fetchItem throw typed errors when missing", async () => {
      const store = await factory.build([{ name: WIDGETS, schema: widgetsSchema }]);
      try {
        expect(() => store.fetch("nope")).toThrow(/Ledger not found/);
        expect(() => store.fetchItem(WIDGETS, "D99")).toThrow(/Item not found/);
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("fetchMilestone returns the resolved view + per-ledger reference counts", async () => {
      const store = await factory.build([
        { name: WIDGETS, schema: widgetsSchema },
        { name: NOTES, schema: notesSchema },
      ]);
      try {
        const m = await store.createMilestone({
          title: "thing",
          description: "a thing",
        });
        await store.createItem(WIDGETS, m.id, {
          status: "open",
          fields: { severity: "minor", location: "x.ts", description: "d1" },
        });
        await store.createItem(WIDGETS, m.id, {
          status: "open",
          fields: { severity: "minor", location: "y.ts", description: "d2" },
        });
        await store.createItem(NOTES, m.id, {
          status: "open",
          fields: { notes: "t1" },
        });
        const view = store.fetchMilestone(m.id);
        expect(view.resolved.id).toBe(m.id);
        expect(view.resolved.title).toBe("thing");
        expect(view.resolved.description).toBe("a thing");
        expect(view.resolved.status).toBe("open");
        expect(view.references).toEqual({ widgets: 2, notes: 1 });
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("listMilestoneItems groups items by ledger", async () => {
      const store = await factory.build([
        { name: WIDGETS, schema: widgetsSchema },
        { name: NOTES, schema: notesSchema },
      ]);
      try {
        const m = await store.createMilestone({ title: "x" });
        await store.createItem(WIDGETS, m.id, {
          status: "open",
          fields: { severity: "minor", location: "x.ts", description: "d1" },
        });
        await store.createItem(NOTES, m.id, {
          status: "open",
          fields: { notes: "t1" },
        });
        const grouped = store.listMilestoneItems(m.id);
        expect(Object.keys(grouped).sort()).toEqual([NOTES, WIDGETS].sort());
        expect(grouped[WIDGETS]?.length).toBe(1);
        expect(grouped[NOTES]?.length).toBe(1);
      } finally {
        await factory.teardown?.(store);
      }
    });

    it("createItem refuses the milestones ledger directly (must use createMilestone)", async () => {
      const store = await factory.build([]);
      try {
        await expect(
          store.createItem(MILESTONES_LEDGER, MILESTONES_ACTIVE_GROUP_ID, {
            status: "open",
            fields: { title: "x" },
          }),
        ).rejects.toThrow(/use createMilestone/);
      } finally {
        await factory.teardown?.(store);
      }
    });

    // D-LED-02: every adapter must reject the same set of bad schemas at
    // createLedger boundary, so a future adapter cannot drift.
    describe("D-LED-02 — createLedger rejects invalid schemas", () => {
      it("terminalStatuses must be a subset of statusValues", async () => {
        const store = await factory.build([]);
        try {
          await expect(
            store.createLedger("x", {
              statusValues: ["open"],
              terminalStatuses: ["done"],
              fields: {},
            }),
          ).rejects.toThrow(/terminalStatuses entry "done" is not in statusValues/);
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("status values containing em-dash are rejected", async () => {
        const store = await factory.build([]);
        try {
          await expect(
            store.createLedger("x", {
              statusValues: ["open", "in—progress"],
              terminalStatuses: [],
              fields: {},
            }),
          ).rejects.toThrow(/disallowed characters/);
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("reserved field names (createdAt/updatedAt) are rejected", async () => {
        const store = await factory.build([]);
        try {
          await expect(
            store.createLedger("x", {
              statusValues: ["open"],
              terminalStatuses: [],
              fields: { createdAt: { type: "timestamp", required: false } },
            }),
          ).rejects.toThrow(/reserved/);
          await expect(
            store.createLedger("y", {
              statusValues: ["open"],
              terminalStatuses: [],
              fields: { updatedAt: { type: "timestamp", required: false } },
            }),
          ).rejects.toThrow(/reserved/);
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("field names violating the identifier regex are rejected", async () => {
        const store = await factory.build([]);
        try {
          await expect(
            store.createLedger("x", {
              statusValues: ["open"],
              terminalStatuses: [],
              fields: { "bad name": { type: "string", required: false } },
            }),
          ).rejects.toThrow(/must match/);
          await expect(
            store.createLedger("y", {
              statusValues: ["open"],
              terminalStatuses: [],
              fields: { "1bad": { type: "string", required: false } },
            }),
          ).rejects.toThrow(/must match/);
        } finally {
          await factory.teardown?.(store);
        }
      });
    });

    // -----------------------------------------------------------------------
    // D-COHERENCE — onMutation hook firing matrix + invalidate semantics
    // -----------------------------------------------------------------------

    describe("D-COHERENCE — onMutation hook firing", () => {
      it("fires once per createLedger / createMilestone / createItem / updateItem / updateMilestone / archiveMilestone", async () => {
        const events: Array<[string, string]> = [];
        const store = await factory.buildWithHook(
          [{ name: WIDGETS, schema: widgetsSchema }],
          (ledgerId, op) => events.push([ledgerId, op]),
        );
        try {
          // createMilestone fires once on the milestones ledger.
          const m = await store.createMilestone({ title: "x" });
          expect(events).toEqual([[MILESTONES_LEDGER, "create"]]);
          events.length = 0;

          // createItem fires on the target ledger.
          const it = await store.createItem(WIDGETS, m.id, {
            status: "open",
            fields: { severity: "minor", location: "x.ts", description: "d" },
          });
          expect(events).toEqual([[WIDGETS, "create"]]);
          events.length = 0;

          // updateItem fires update on the target ledger.
          await store.updateItem(WIDGETS, it.id, { status: "resolved" });
          expect(events).toEqual([[WIDGETS, "update"]]);
          events.length = 0;

          // updateMilestone fires update on the milestones ledger.
          await store.updateMilestone(m.id, { status: "done" });
          expect(events).toEqual([[MILESTONES_LEDGER, "update"]]);
          events.length = 0;

          // createLedger fires create on the new ledger.
          await store.createLedger(NOTES, notesSchema);
          expect(events).toEqual([[NOTES, "create"]]);
          events.length = 0;

          // archiveMilestone fires once per participating ledger + once
          // for the milestones ledger itself. `widgets` (had a group) and
          // the milestones ledger fire. `notes` had no group for `m.id`,
          // so it does NOT fire.
          await store.archiveMilestone(m.id, "summary");
          // Order: participants in alphabetic order, then milestones.
          expect(events).toEqual([
            [WIDGETS, "archive"],
            [MILESTONES_LEDGER, "archive"],
          ]);
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("a throwing onMutation does not unwind the write", async () => {
        const store = await factory.buildWithHook(
          [{ name: WIDGETS, schema: widgetsSchema }],
          () => {
            throw new Error("simulated hook failure");
          },
        );
        try {
          const m = await store.createMilestone({ title: "x" });
          // Item was created despite the hook throwing.
          expect(m.id).toBe("M1");
          const it = await store.createItem(WIDGETS, m.id, {
            status: "open",
            fields: { severity: "minor", location: "x.ts", description: "d" },
          });
          expect(it.id).toBe("W1");
          // Re-read confirms persisted state.
          const fetched = store.fetchItem(WIDGETS, "W1");
          expect(fetched.id).toBe("W1");
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("invalidate is a no-op for unknown ledger ids (no throw)", async () => {
        const store = await factory.build([]);
        try {
          await store.invalidate("nope-not-here");
          // Still resolvable: enumerate doesn't suddenly include it.
          expect(store.enumerate()).not.toContain("nope-not-here");
        } finally {
          await factory.teardown?.(store);
        }
      });
    });

    // -----------------------------------------------------------------------
    // FTS — ftsSearch ranked cross-ledger search + includeArchived + coherence
    // -----------------------------------------------------------------------

    describe("FTS — ftsSearch", () => {
      it("ranks cross-ledger and restricts with a single-ledger filter", async () => {
        const store = await factory.build([
          { name: WIDGETS, schema: widgetsSchema },
          { name: NOTES, schema: notesSchema },
        ]);
        try {
          const m = await store.createMilestone({ title: "x" });
          await store.createItem(WIDGETS, m.id, {
            status: "open",
            fields: { severity: "minor", location: "x.ts", description: "stream scroll defect" },
          });
          await store.createItem(NOTES, m.id, {
            status: "open",
            fields: { notes: "stream notes here" },
          });
          // Cross-ledger: both ledgers' items match "stream".
          const cross = await store.ftsSearch("stream");
          expect(cross.map((h) => h.ledgerId).sort()).toEqual([NOTES, WIDGETS].sort());
          // Single-ledger restriction.
          const single = await store.ftsSearch("stream", { ledger: NOTES });
          expect(single.map((h) => h.ledgerId)).toEqual([NOTES]);
          // Hits carry the full Item + a positive score.
          expect(single[0]?.item.fields["notes"]).toBe("stream notes here");
          expect((single[0]?.score ?? 0) > 0).toBe(true);
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("a headline-field match outranks a body-only match (boosts)", async () => {
        // The widgets schema has no 'headline' field, so use the canonical
        // defects ledger whose required field IS 'headline'.
        const store = await factory.build([]);
        try {
          const m = await store.createMilestone({ title: "x" });
          await store.createItem("defects", m.id, {
            status: "open",
            fields: { headline: "widget overflow", severity: "minor", description: "x" },
          });
          await store.createItem("defects", m.id, {
            status: "open",
            fields: { headline: "unrelated heading", severity: "minor", description: "the widget here" },
          });
          const hits = await store.ftsSearch("widget", { ledger: "defects" });
          expect(hits.length).toBe(2);
          // The headline match (D1) ranks first; its score is strictly higher.
          expect(hits[0]?.item.fields["headline"]).toBe("widget overflow");
          expect((hits[0]?.score ?? 0) > (hits[1]?.score ?? 1)).toBe(true);
          expect(hits[0]?.matchedFields).toContain("headline");
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("fuzzy + prefix + status options behave", async () => {
        const store = await factory.build([{ name: WIDGETS, schema: widgetsSchema }]);
        try {
          const m = await store.createMilestone({ title: "x" });
          await store.createItem(WIDGETS, m.id, {
            status: "open",
            fields: { severity: "minor", location: "x.ts", description: "neuromancer motorcycle" },
          });
          await store.createItem(WIDGETS, m.id, {
            status: "resolved",
            fields: { severity: "major", location: "y.ts", description: "neuromancer scooter" },
          });
          // Exact misses the typo; fuzzy finds it.
          expect((await store.ftsSearch("neromancer")).length).toBe(0);
          expect((await store.ftsSearch("neromancer", { fuzzy: true })).length).toBe(2);
          // Prefix finds by term prefix.
          expect((await store.ftsSearch("motor")).length).toBe(0);
          expect((await store.ftsSearch("motor", { prefix: true })).length).toBe(1);
          // Status filter restricts.
          const open = await store.ftsSearch("neuromancer", { statusFilter: "open" });
          expect(open.map((h) => h.item.status)).toEqual(["open"]);
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("local coherence: create then update is reflected in ftsSearch", async () => {
        const store = await factory.build([{ name: WIDGETS, schema: widgetsSchema }]);
        try {
          const m = await store.createMilestone({ title: "x" });
          const it = await store.createItem(WIDGETS, m.id, {
            status: "open",
            fields: { severity: "minor", location: "x.ts", description: "aardvark" },
          });
          expect((await store.ftsSearch("aardvark")).map((h) => h.item.id)).toEqual([it.id]);
          // Update the searchable text; the old term no longer matches, the new one does.
          await store.updateItem(WIDGETS, it.id, { fields: { description: "buffalo" } });
          expect((await store.ftsSearch("aardvark")).length).toBe(0);
          expect((await store.ftsSearch("buffalo")).map((h) => h.item.id)).toEqual([it.id]);
        } finally {
          await factory.teardown?.(store);
        }
      });

      it("includeArchived: an archived item is found ONLY when include_archived=true", async () => {
        const store = await factory.build([{ name: WIDGETS, schema: widgetsSchema }]);
        try {
          const m = await store.createMilestone({ title: "x" });
          await store.createItem(WIDGETS, m.id, {
            status: "resolved",
            fields: { severity: "minor", location: "x.ts", description: "zebracrossing" },
          });
          // Before archive: active, found by default.
          expect((await store.ftsSearch("zebracrossing")).length).toBe(1);
          // Archive the milestone (item already terminal; mark milestone done).
          await store.updateMilestone(m.id, { status: "done" });
          await store.archiveMilestone(m.id, "summary");
          // After archive: default search hides it; includeArchived reveals it.
          expect((await store.ftsSearch("zebracrossing")).length).toBe(0);
          const incl = await store.ftsSearch("zebracrossing", { includeArchived: true });
          expect(incl.length).toBe(1);
          expect(incl[0]?.ledgerId).toBe(WIDGETS);
        } finally {
          await factory.teardown?.(store);
        }
      });
    });
  });
}
