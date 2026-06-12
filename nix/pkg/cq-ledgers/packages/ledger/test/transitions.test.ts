/**
 * F1 — declarative status-transition guard.
 *
 * Runs the same assertions against BOTH adapters (FsLedgerStore over a tmp
 * dir, InMemoryLedgerStore dummy) via a small per-test factory mirroring the
 * pattern in store-fs.test.ts / store-inmemory.test.ts.
 *
 * The `goals` ledger is a canonical, bootstrapped ledger; its schema carries
 * a `transitions` map (clarifying → planning → planned → building → done,
 * with abandoned reachable from each non-terminal state). We exercise the
 * guard against it directly. A custom ledger WITHOUT a `transitions` map
 * proves back-compat: any status→status move among statusValues is allowed.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  serializeRegistry,
  validateSchema,
  GOALS_LEDGER,
  DEFECTS_LEDGER,
  MILESTONES_SCHEMA,
  DEFECTS_SCHEMA,
  TASKS_SCHEMA,
  HYPOTHESIS_SCHEMA,
  QUESTIONS_SCHEMA,
  DECISIONS_SCHEMA,
  GOALS_SCHEMA,
  REVIEWS_SCHEMA,
  type LedgerSchema,
  type LedgerStore,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

interface StoreFactory {
  name: string;
  build(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<LedgerStore>;
  teardown(store: LedgerStore): Promise<void>;
}

const dirs: string[] = [];

const fsFactory: StoreFactory = {
  name: "FsLedgerStore",
  async build(seed) {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-transitions-"));
    dirs.push(dir);
    const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({ version: 1, ledgers: seed }),
      "utf8",
    );
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    return store;
  },
  async teardown(store) {
    await store.dispose();
  },
};

const inMemFactory: StoreFactory = {
  name: "InMemoryLedgerStore",
  async build(seed) {
    const store = new InMemoryLedgerStore({ seed });
    await store.init();
    return store;
  },
  async teardown(store) {
    await store.dispose();
  },
};

// A non-canonical ledger whose schema declares NO transitions map: any
// status → status move among statusValues must be permitted (back-compat).
const FREEFORM = "freeform";
const freeformSchema: LedgerSchema = {
  statusValues: ["a", "b", "c"],
  terminalStatuses: ["c"],
  idPrefix: "FF",
  fields: { note: { type: "string", required: false } },
};

async function seedDefect(store: LedgerStore): Promise<string> {
  const m = await store.createMilestone({ title: "m" });
  const d = await store.createItem(DEFECTS_LEDGER, m.id, {
    status: "open",
    fields: { headline: "d", severity: "minor" },
  });
  return d.id;
}

async function seedGoal(store: LedgerStore): Promise<string> {
  const m = await store.createMilestone({ title: "m" });
  const goal = await store.createItem(GOALS_LEDGER, m.id, {
    status: "clarifying",
    fields: { title: "g", description: "d" },
  });
  return goal.id;
}

for (const factory of [fsFactory, inMemFactory]) {
  describe(`status-transition guard (${factory.name})`, () => {
    it("1. illegal transition throws a typed transition error", async () => {
      const store = await factory.build([]);
      try {
        const id = await seedGoal(store);
        // clarifying → planned skips `planning`; not in transitions[clarifying].
        await expect(
          store.updateItem(GOALS_LEDGER, id, { status: "planned" }),
        ).rejects.toThrow(/transition/i);
      } finally {
        await factory.teardown(store);
      }
    });

    it("2. legal transition (clarifying → planning) succeeds", async () => {
      const store = await factory.build([]);
      try {
        const id = await seedGoal(store);
        const updated = await store.updateItem(GOALS_LEDGER, id, { status: "planning" });
        expect(updated.status).toBe("planning");
      } finally {
        await factory.teardown(store);
      }
    });

    it("3. field-only update (no status / unchanged status) skips the guard", async () => {
      const store = await factory.build([]);
      try {
        const id = await seedGoal(store);
        // No status in the patch — must not trigger the transition check
        // even though `clarifying` has no self-loop.
        const fieldsOnly = await store.updateItem(GOALS_LEDGER, id, {
          fields: { description: "edited" },
        });
        expect(fieldsOnly.status).toBe("clarifying");
        expect(fieldsOnly.fields["description"]).toBe("edited");
        // status present but unchanged — also a no-op for the guard.
        const sameStatus = await store.updateItem(GOALS_LEDGER, id, {
          status: "clarifying",
        });
        expect(sameStatus.status).toBe("clarifying");
      } finally {
        await factory.teardown(store);
      }
    });

    it("4. a ledger with no transitions map allows any status→status move", async () => {
      const store = await factory.build([{ name: FREEFORM, schema: freeformSchema }]);
      try {
        const m = await store.createMilestone({ title: "m" });
        const it = await store.createItem(FREEFORM, m.id, {
          status: "a",
          fields: {},
        });
        // a → c is an arbitrary jump; with no transitions map it is allowed.
        const updated = await store.updateItem(FREEFORM, it.id, { status: "c" });
        expect(updated.status).toBe("c");
      } finally {
        await factory.teardown(store);
      }
    });

    // /cq:plan:follow-up re-open. A goal that has reached `planned` (and then
    // `building`) must be able to return to `planning` to take on added scope.
    // `done`/`abandoned` stay terminal (the terminal-⇒-no-outgoing invariant).
    it("5. re-open: planned → planning succeeds (follow-up)", async () => {
      const store = await factory.build([]);
      try {
        const m = await store.createMilestone({ title: "m" });
        const goal = await store.createItem(GOALS_LEDGER, m.id, {
          status: "clarifying",
          fields: { title: "g", description: "d" },
        });
        await store.updateItem(GOALS_LEDGER, goal.id, { status: "planning" });
        // entering `planned` requires a locked decision linking the goal
        await store.createItem("decisions", m.id, {
          status: "locked",
          fields: { headline: "approved", ledgerRefs: [`goals:${goal.id}`] },
        });
        await store.updateItem(GOALS_LEDGER, goal.id, { status: "planned" });
        const reopened = await store.updateItem(GOALS_LEDGER, goal.id, { status: "planning" });
        expect(reopened.status).toBe("planning");
      } finally {
        await factory.teardown(store);
      }
    });

    it("6. re-open: building → planning succeeds (follow-up)", async () => {
      const store = await factory.build([]);
      try {
        const m = await store.createMilestone({ title: "m" });
        const goal = await store.createItem(GOALS_LEDGER, m.id, {
          status: "clarifying",
          fields: { title: "g", description: "d" },
        });
        await store.updateItem(GOALS_LEDGER, goal.id, { status: "planning" });
        await store.createItem("decisions", m.id, {
          status: "locked",
          fields: { headline: "approved", ledgerRefs: [`goals:${goal.id}`] },
        });
        await store.updateItem(GOALS_LEDGER, goal.id, { status: "planned" });
        await store.updateItem(GOALS_LEDGER, goal.id, { status: "building" });
        const reopened = await store.updateItem(GOALS_LEDGER, goal.id, { status: "planning" });
        expect(reopened.status).toBe("planning");
      } finally {
        await factory.teardown(store);
      }
    });

    // Defects locked lifecycle (Q66/Q67). The hyphenated id `root-caused` must
    // round-trip through the guard and store like any other status.
    it("7. defects: wip → root-caused → resolved is accepted", async () => {
      const store = await factory.build([]);
      try {
        const id = await seedDefect(store);
        await store.updateItem(DEFECTS_LEDGER, id, { status: "wip" });
        const rc = await store.updateItem(DEFECTS_LEDGER, id, { status: "root-caused" });
        expect(rc.status).toBe("root-caused");
        const resolved = await store.updateItem(DEFECTS_LEDGER, id, { status: "resolved" });
        expect(resolved.status).toBe("resolved");
      } finally {
        await factory.teardown(store);
      }
    });

    it("8. defects: wip → inconclusive → wip (re-open) is accepted", async () => {
      const store = await factory.build([]);
      try {
        const id = await seedDefect(store);
        await store.updateItem(DEFECTS_LEDGER, id, { status: "wip" });
        const inc = await store.updateItem(DEFECTS_LEDGER, id, { status: "inconclusive" });
        expect(inc.status).toBe("inconclusive");
        const back = await store.updateItem(DEFECTS_LEDGER, id, { status: "wip" });
        expect(back.status).toBe("wip");
      } finally {
        await factory.teardown(store);
      }
    });

    it("9. defects: open → blocked (removed status) is rejected", async () => {
      const store = await factory.build([]);
      try {
        const id = await seedDefect(store);
        // `blocked` is no longer a declared status; the patch must be rejected.
        await expect(
          store.updateItem(DEFECTS_LEDGER, id, { status: "blocked" }),
        ).rejects.toThrow();
      } finally {
        await factory.teardown(store);
      }
    });

    it("10. defects: direct open → root-caused is rejected (only reachable from wip)", async () => {
      const store = await factory.build([]);
      try {
        const id = await seedDefect(store);
        await expect(
          store.updateItem(DEFECTS_LEDGER, id, { status: "root-caused" }),
        ).rejects.toThrow(/transition/i);
      } finally {
        await factory.teardown(store);
      }
    });
  });
}

// Round-trip persistence: the canonical `transitions` map must survive a
// serialize → parse cycle, so a RESTARTED FsLedgerStore (a) does not detect
// false schema divergence against its bootstrap schema, and (b) still
// enforces the guard read back from disk.
describe("transitions survive a ledgers.yaml round-trip (FsLedgerStore restart)", () => {
  it("restart neither diverges nor drops the guard", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-transitions-rt-"));
    dirs.push(dir);
    const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({ version: 1, ledgers: [] }),
      "utf8",
    );

    // First boot writes the canonical schemas (with transitions) to disk.
    const first = new FsLedgerStore({ root: dir });
    await first.init();
    const id = await seedGoal(first);
    await first.dispose();

    // Restart: must read the persisted transitions back without a
    // BootstrapViolationError (proves serialize+parse preserved the map).
    const second = new FsLedgerStore({ root: dir });
    await second.init();
    try {
      // Guard still enforced from the round-tripped schema.
      await expect(
        second.updateItem(GOALS_LEDGER, id, { status: "planned" }),
      ).rejects.toThrow(/transition/i);
      // Legal move still allowed.
      const ok = await second.updateItem(GOALS_LEDGER, id, { status: "planning" });
      expect(ok.status).toBe("planning");
    } finally {
      await second.dispose();
    }
  });
});

// D02 — validateSchema rejects a transitions map that lets a terminal status
// carry outgoing edges (a contradiction: terminal means no outgoing moves).
describe("validateSchema — terminal status with outgoing transitions", () => {
  it("rejects a non-empty target array on a terminal-status key", () => {
    expect(() =>
      validateSchema({
        statusValues: ["open", "done"],
        terminalStatuses: ["done"],
        fields: {},
        transitions: {
          open: ["done"],
          done: ["open"], // terminal with an outgoing edge — must throw
        },
      }),
    ).toThrow(/terminal status "done" must have no outgoing transitions/);
  });

  it("accepts a terminal-status key whose target array is empty", () => {
    expect(() =>
      validateSchema({
        statusValues: ["open", "done"],
        terminalStatuses: ["done"],
        fields: {},
        transitions: {
          open: ["done"],
          done: [],
        },
      }),
    ).not.toThrow();
  });
});

// D05 — pin the exact `transitions` edges on the canonical schemas. A
// lightweight regression guard against accidental edits to constants.ts; not
// an exhaustive snapshot.
describe("canonical schema transition maps — pinned edges", () => {
  it("milestones: D03 direct postponed↔blocked edges; done is terminal", () => {
    expect(MILESTONES_SCHEMA.transitions?.["postponed"]).toContain("blocked");
    expect(MILESTONES_SCHEMA.transitions?.["blocked"]).toContain("postponed");
    expect(MILESTONES_SCHEMA.transitions?.["done"]).toEqual([]);
  });

  it("defects: locked lifecycle vocabulary and Q67 edges (statusValues/terminals/transitions)", () => {
    // statusValues / terminalStatuses deep-equal the locked target.
    expect(DEFECTS_SCHEMA.statusValues).toEqual([
      "open",
      "wip",
      "root-caused",
      "inconclusive",
      "resolved",
      "wontfix",
    ]);
    expect(DEFECTS_SCHEMA.terminalStatuses).toEqual(["resolved", "wontfix"]);
    // Q67 VERBATIM edge map — open reaches ONLY wip + the two terminals.
    expect(DEFECTS_SCHEMA.transitions).toEqual({
      open: ["wip", "resolved", "wontfix"],
      wip: ["root-caused", "inconclusive", "resolved", "wontfix"],
      "root-caused": ["resolved", "wontfix", "wip"],
      inconclusive: ["wip", "wontfix"],
      resolved: [],
      wontfix: [],
    });
    // No open→root-caused, no open→inconclusive (reachable only from wip).
    expect(DEFECTS_SCHEMA.transitions?.["open"]).not.toContain("root-caused");
    expect(DEFECTS_SCHEMA.transitions?.["open"]).not.toContain("inconclusive");
    // The dropped status is absent everywhere.
    expect(DEFECTS_SCHEMA.statusValues).not.toContain("blocked");
    expect(DEFECTS_SCHEMA.statusValues).not.toContain("abandoned");
    expect(DEFECTS_SCHEMA.transitions?.["blocked"]).toBeUndefined();
    // Both terminals carry no outgoing edges; validateSchema accepts the schema.
    expect(DEFECTS_SCHEMA.transitions?.["resolved"]).toEqual([]);
    expect(DEFECTS_SCHEMA.transitions?.["wontfix"]).toEqual([]);
    expect(() => validateSchema(DEFECTS_SCHEMA)).not.toThrow();
  });

  it("tasks: planned → wip present; done is terminal", () => {
    expect(TASKS_SCHEMA.transitions?.["planned"]).toContain("wip");
    expect(TASKS_SCHEMA.transitions?.["done"]).toEqual([]);
  });

  it("hypothesis: open → uncertain present; confirmed is terminal", () => {
    expect(HYPOTHESIS_SCHEMA.transitions?.["open"]).toContain("uncertain");
    expect(HYPOTHESIS_SCHEMA.transitions?.["confirmed"]).toEqual([]);
  });

  it("questions: open reaches both answered and withdrawn", () => {
    expect(QUESTIONS_SCHEMA.transitions?.["open"]).toContain("answered");
    expect(QUESTIONS_SCHEMA.transitions?.["open"]).toContain("withdrawn");
  });

  it("decisions: proposed → locked present; locked is terminal", () => {
    expect(DECISIONS_SCHEMA.transitions?.["proposed"]).toContain("locked");
    expect(DECISIONS_SCHEMA.transitions?.["locked"]).toEqual([]);
  });

  it("goals: clarifying → planning present, clarifying → planned absent", () => {
    expect(GOALS_SCHEMA.transitions?.["clarifying"]).toContain("planning");
    expect(GOALS_SCHEMA.transitions?.["clarifying"]).not.toContain("planned");
  });

  it("goals: follow-up re-open edges planned→planning and building→planning present; done/abandoned stay terminal", () => {
    expect(GOALS_SCHEMA.transitions?.["planned"]).toContain("planning");
    expect(GOALS_SCHEMA.transitions?.["building"]).toContain("planning");
    expect(GOALS_SCHEMA.transitions?.["done"]).toEqual([]);
    expect(GOALS_SCHEMA.transitions?.["abandoned"]).toEqual([]);
  });

  it("reviews: both verdicts (go-ahead, revise) are terminal", () => {
    expect(REVIEWS_SCHEMA.transitions?.["go-ahead"]).toEqual([]);
    expect(REVIEWS_SCHEMA.transitions?.["revise"]).toEqual([]);
  });
});

afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});
