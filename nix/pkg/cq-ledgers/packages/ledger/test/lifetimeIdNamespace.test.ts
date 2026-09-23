/**
 * D434 / questions:Q417 — the lifetime item-id namespace policy.
 *
 * The policy is asymmetric on purpose, so both arms are pinned here: live
 * ambiguity refuses the store, pointer-qualified history is reported and never
 * repaired. The shapes below are the ones measured on this project's own
 * ledger, not invented ones.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import {
  assertLifetimeIdNamespace,
  classifyLifetimeIdNamespace,
  lifetimeIdNamespaceNotice,
  type LifetimeIdCollision,
} from "../src/store/lifetimeIdNamespace.js";
import { LedgerError } from "../src/types.js";

const LABEL = "test-store";

function collect(): { lines: string[]; warn: (line: string) => void } {
  const lines: string[] = [];
  return { lines, warn: (line) => lines.push(line) };
}

describe("D434 lifetime id namespace", () => {
  test("an id that is both active and archived refuses the store", () => {
    const collisions: LifetimeIdCollision[] = [
      { ledgerId: "tasks", itemId: "T7", active: true, archivePointerIds: ["M61"] },
    ];
    const { lines, warn } = collect();
    expect(() => assertLifetimeIdNamespace(LABEL, collisions, warn)).toThrow(LedgerError);
    try {
      assertLifetimeIdNamespace(LABEL, collisions, warn);
    } catch (error) {
      const message = (error as Error).message;
      // The diagnostic has to be actionable: which ref, where the archived
      // generation lives, and which side to rename.
      expect(message).toContain("tasks:T7");
      expect(message).toContain("M61");
      expect(message).toContain("Rename the ACTIVE record");
    }
    // A refusal never also emits the advisory notice.
    expect(lines).toEqual([]);
  });

  test("two archived generations are reported once and do not refuse the store", () => {
    // The exact shape measured on cq-ledger-suite-production.
    const collisions: LifetimeIdCollision[] = [
      { ledgerId: "tasks", itemId: "T1", active: false, archivePointerIds: ["M61", "M2"] },
      { ledgerId: "reviews", itemId: "R168", active: false, archivePointerIds: ["M53", "M-AMBIENT"] },
    ];
    const { lines, warn } = collect();
    const report = assertLifetimeIdNamespace(LABEL, collisions, warn);

    expect(report.conflicting).toEqual([]);
    expect(report.archiveGenerations).toHaveLength(2);
    // Pointers are sorted, so the notice is stable across storage orderings.
    expect(report.archiveGenerations[0]!.archivePointerIds).toEqual(["M-AMBIENT", "M53"]);
    expect(report.archiveGenerations[1]!.archivePointerIds).toEqual(["M2", "M61"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("unique only among ACTIVE records");
    expect(lines[0]).toContain("<ledger>:<id>@<pointerId>");
    expect(lines[0]).toContain("reviews:R168@{M-AMBIENT,M53}");
  });

  test("a single active row or a single archived generation is not a collision", () => {
    const { lines, warn } = collect();
    const report = assertLifetimeIdNamespace(
      LABEL,
      [
        { ledgerId: "tasks", itemId: "T6586", active: true, archivePointerIds: [] },
        { ledgerId: "tasks", itemId: "T900", active: false, archivePointerIds: ["M9"] },
      ],
      warn,
    );
    expect(report).toEqual({ conflicting: [], archiveGenerations: [] });
    expect(lines).toEqual([]);
  });

  test("the notice summarizes a large set without printing all of it", () => {
    const many: LifetimeIdCollision[] = Array.from({ length: 17 }, (_, index) => ({
      ledgerId: "tasks",
      itemId: `T${String(index + 1)}`,
      active: false,
      archivePointerIds: ["M2", "M61"],
    }));
    const notice = lifetimeIdNamespaceNotice(LABEL, many);
    expect(notice).toContain("17 archived item id(s)");
    expect(notice).toContain("(+14 more)");
    // Three examples, not seventeen: a store that opens every session must not
    // print a wall of text.
    expect(notice.split("tasks:").length - 1).toBe(3);
  });

  test("classification is total over an unfiltered inventory", () => {
    // A caller may hand over everything it saw; non-collisions are ignored
    // rather than mis-filed into either arm.
    const report = classifyLifetimeIdNamespace([
      { ledgerId: "tasks", itemId: "T1", active: false, archivePointerIds: [] },
      { ledgerId: "tasks", itemId: "T2", active: true, archivePointerIds: [] },
      { ledgerId: "tasks", itemId: "T3", active: false, archivePointerIds: ["M1"] },
      { ledgerId: "tasks", itemId: "T4", active: false, archivePointerIds: ["M1", "M2"] },
      { ledgerId: "tasks", itemId: "T5", active: true, archivePointerIds: ["M1"] },
    ]);
    expect(report.conflicting.map((entry) => entry.itemId)).toEqual(["T5"]);
    expect(report.archiveGenerations.map((entry) => entry.itemId)).toEqual(["T4"]);
  });

  // The create path can no longer PRODUCE either shape (commit 027f57988), so
  // the wiring is proved by forging the durable rows the policy is about.
  test("a store refuses to open when an id is both active and archived", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "d434-wiring-"));
    try {
      const dbPath = path.join(dir, "ledger.db");
      const seed = new SqliteLedgerStore({ dbPath });
      await seed.init();
      const milestone = await seed.createMilestone({ title: "held" });
      const kept = await seed.createItem("tasks", milestone.id, {
        status: "planned",
        fields: { headline: "still active" },
      });
      await seed.dispose();

      // Forge the archived twin of a LIVE id — exactly the live-ambiguity arm.
      const raw = new Database(dbPath);
      raw
        .query(
          `INSERT INTO archived_items
             (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at)
           VALUES ('tasks', 'M-OLD', ?, 'M-OLD', 'done', '{"headline":"earlier generation"}',
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(kept.id);
      raw.close();

      const reopened = new SqliteLedgerStore({ dbPath });
      await expect(reopened.init()).rejects.toThrow(/both an active record and an archived/i);
      await expect(reopened.init()).rejects.toThrow(new RegExp(`tasks:${kept.id}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store opens, and reports, when history has two archived generations", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "d434-history-"));
    try {
      const dbPath = path.join(dir, "ledger.db");
      const seed = new SqliteLedgerStore({ dbPath });
      await seed.init();
      await seed.dispose();

      // Two archived generations of one id, no active row — the shape this
      // project's own ledger carries seventeen times.
      const raw = new Database(dbPath);
      for (const pointer of ["M2", "M61"]) {
        raw
          .query(
            `INSERT INTO archived_items
               (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at)
             VALUES ('tasks', ?, 'T1', ?, 'done', '{"headline":"a generation"}',
                     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(pointer, pointer);
      }
      raw.close();

      const reopened = new SqliteLedgerStore({ dbPath });
      await reopened.init();
      // It OPENS. That is the whole point: history is never a refusal.
      expect(reopened.enumerate()).toContain("tasks");
      await reopened.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
