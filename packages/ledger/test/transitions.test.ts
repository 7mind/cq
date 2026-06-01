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
  MILESTONES_SCHEMA,
  DEFECTS_SCHEMA,
  TASKS_SCHEMA,
  HYPOTHESIS_SCHEMA,
  QUESTIONS_SCHEMA,
  DECISIONS_SCHEMA,
  GOALS_SCHEMA,
  type LedgerSchema,
  type LedgerStore,
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
    const docsDir = path.join(dir, "docs");
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
    const docsDir = path.join(dir, "docs");
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

  it("defects: blocked is reversible to open/wip; resolved is terminal", () => {
    expect(DEFECTS_SCHEMA.transitions?.["blocked"]).toContain("open");
    expect(DEFECTS_SCHEMA.transitions?.["blocked"]).toContain("wip");
    expect(DEFECTS_SCHEMA.transitions?.["resolved"]).toEqual([]);
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
});

afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});
