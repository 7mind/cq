/**
 * `author` / `session` intrinsic provenance fields.
 *
 * Like `createdAt` / `updatedAt`, these are intrinsic optional Item metadata
 * — NOT schema fields. `author` records who last wrote the item ("user" or a
 * model class, e.g. "opus-4.8[1m]"); `session` records the writing session
 * (e.g. CLAUDE_CODE_SESSION_ID). Modelling them as intrinsic (rather than
 * schema fields) keeps them off every schema's `fields`, so adding them never
 * trips the on-disk schema-divergence guard and they apply to every ledger
 * uniformly.
 *
 * Coverage:
 *   - serialize → parse round-trips author/session when present;
 *   - absent author/session stay absent (keys not materialised);
 *   - the names are reserved against schema `fields`;
 *   - applyCreateItem / applyUpdateItem set them from the init/patch.
 */

import { describe, it, expect } from "bun:test";
import {
  serializeLedger,
  parseLedger,
  validateSchema,
  InMemoryLedgerStore,
  type Ledger,
  type LedgerSchema,
} from "../src/index.js";

const TS = "2026-06-01T00:00:00.000Z";

const schema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  idPrefix: "W",
  fields: { headline: { type: "string", required: true } },
};

function ledgerWith(items: Ledger["milestones"][number]["items"]): Ledger {
  return {
    id: "defects",
    schema,
    counters: { milestone: 2, item: items.length + 1 },
    milestones: [{ id: "M1", title: "", description: "", items }],
    archivePointers: [],
  };
}

describe("author/session intrinsic fields", () => {
  it("round-trips author and session through serialize → parse", () => {
    const ledger = ledgerWith([
      {
        id: "D1",
        milestoneId: "M1",
        status: "open",
        fields: { headline: "leak" },
        createdAt: TS,
        updatedAt: TS,
        author: "opus-4.8[1m]",
        session: "sess-abc123",
      },
    ]);
    const text = serializeLedger(ledger);
    // `[` makes the value a YAML flow sequence unless quoted, so the
    // serializer quotes it; the value still round-trips through parse.
    expect(text).toContain(`- author: "opus-4.8[1m]"`);
    expect(text).toContain("- session: sess-abc123");
    const parsed = parseLedger(text, { schema });
    const item = parsed.milestones[0]!.items[0]!;
    expect(item.author).toBe("opus-4.8[1m]");
    expect(item.session).toBe("sess-abc123");
    expect(item.fields).toEqual({ headline: "leak" });
  });

  it("omits author/session from the serialized form when absent", () => {
    const ledger = ledgerWith([
      {
        id: "D1",
        milestoneId: "M1",
        status: "open",
        fields: { headline: "leak" },
        createdAt: TS,
        updatedAt: TS,
      },
    ]);
    const text = serializeLedger(ledger);
    expect(text).not.toContain("author:");
    expect(text).not.toContain("session:");
    const item = parseLedger(text, { schema }).milestones[0]!.items[0]!;
    expect("author" in item).toBe(false);
    expect("session" in item).toBe(false);
  });

  it("reserves the author/session field names against schemas", () => {
    expect(() =>
      validateSchema({
        statusValues: ["open"],
        terminalStatuses: [],
        fields: { author: { type: "string", required: false } },
      }),
    ).toThrow(/reserved/);
    expect(() =>
      validateSchema({
        statusValues: ["open"],
        terminalStatuses: [],
        fields: { session: { type: "string", required: false } },
      }),
    ).toThrow(/reserved/);
  });

  it("createItem records author/session; updateItem overwrites (last-writer wins)", async () => {
    const store = new InMemoryLedgerStore({ seed: [{ name: "widgets", schema }] });
    await store.init();
    try {
      const m = await store.createMilestone({ title: "x" });
      const created = await store.createItem("widgets", m.id, {
        status: "open",
        fields: { headline: "leak" },
        author: "user",
        session: "s1",
      });
      expect(created.author).toBe("user");
      expect(created.session).toBe("s1");

      const updated = await store.updateItem("widgets", created.id, {
        status: "done",
        author: "opus-4.8[1m]",
        session: "s2",
      });
      expect(updated.author).toBe("opus-4.8[1m]");
      expect(updated.session).toBe("s2");
      expect(updated.status).toBe("done");
    } finally {
      await store.dispose();
    }
  });
});
