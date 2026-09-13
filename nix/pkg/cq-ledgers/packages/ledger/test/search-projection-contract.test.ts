import { describe, expect, test } from "bun:test";
import type { Item } from "../src/types.js";
import { createDirectSearchProjection } from "../src/search/DirectSearchProjection.js";
import { createWorkerSearchProjection } from "../src/search/WorkerSearchProjection.js";
import type { SearchProjection } from "../src/search/SearchProjection.js";

const COMMAND_DEADLINE_MS = 5_000;
const item = (id: string, headline: string): Item => ({
  id,
  milestoneId: "M1",
  status: "planned",
  fields: { headline },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

async function hits(projection: SearchProjection, query: string, includeArchived: boolean) {
  const ack = await projection.execute({ kind: "search", query, options: { includeArchived } });
  if (ack.result.kind !== "search") throw new Error("Expected search acknowledgement");
  return ack.result.hits;
}

function searchProjectionContract(make: () => SearchProjection): void {
  test("snapshot, scoped replacements, removals and archive moves preserve unrelated documents [Blackbox-Group]", async () => {
    const projection = make();
    try {
      await projection.execute({
        kind: "snapshot",
        buckets: [
          {
            ledgerId: "tasks",
            archived: false,
            items: [item("T1", "alpha"), item("T2", "retained")],
          },
          { ledgerId: "tasks", archived: true, items: [item("T1", "archived")] },
          { ledgerId: "defects", archived: false, items: [item("D1", "retained")] },
        ],
      });
      expect((await hits(projection, "alpha", false)).map((h) => h.item.id)).toEqual(["T1"]);
      expect(await hits(projection, "archived", false)).toEqual([]);
      expect((await hits(projection, "archived", true)).map((h) => h.item.id)).toEqual(["T1"]);
      await projection.execute({
        kind: "delta",
        changes: [
          { kind: "remove", ledgerId: "tasks", archived: false, itemId: "T1" },
          { kind: "upsert", ledgerId: "tasks", archived: true, item: item("T1", "moved") },
          { kind: "remove", ledgerId: "tasks", archived: false, itemId: "T-absent" },
        ],
      });
      expect(await hits(projection, "alpha", true)).toEqual([]);
      expect(await hits(projection, "archived", true)).toEqual([]);
      expect((await hits(projection, "moved", true)).map((h) => h.item.id)).toEqual(["T1"]);
      expect((await hits(projection, "retained", false)).map((h) => h.item.id).sort()).toEqual([
        "D1",
        "T2",
      ]);
      await projection.execute({
        kind: "delta",
        changes: [
          {
            kind: "replace-bucket",
            bucket: { ledgerId: "tasks", archived: false, items: [item("T3", "replacement")] },
          },
          { kind: "remove-ledger", ledgerId: "defects" },
        ],
      });
      expect(await hits(projection, "retained", true)).toEqual([]);
      expect(
        (await hits(projection, "moved OR replacement", true)).map((h) => h.item.id).sort(),
      ).toEqual(["T1", "T3"]);
      await projection.execute({ kind: "snapshot", buckets: [] });
      expect(await hits(projection, "moved OR replacement", true)).toEqual([]);
    } finally {
      await projection.execute({ kind: "close" });
    }
  });

  test("queued commands acknowledge monotonically and a search observes preceding deltas [Blackbox-Group]", async () => {
    const projection = make();
    try {
      expect(projection.health().state).toBe("recovering");
      await projection.execute({ kind: "snapshot", buckets: [] });
      expect(projection.health().state).toBe("current");
      const acknowledgements: number[] = [];
      const delta = projection.execute({
        kind: "delta",
        changes: [
          { kind: "upsert", ledgerId: "tasks", archived: false, item: item("T1", "ordered") },
        ],
      });
      const search = projection.execute({ kind: "search", query: "ordered", options: {} });
      const health = projection.execute({ kind: "health" });
      expect(projection.health().state).toBe("pending");
      const replies = await Promise.all(
        [delta, search, health].map((command) =>
          command.then((ack) => {
            acknowledgements.push(ack.commandId);
            return ack;
          }),
        ),
      );
      expect(acknowledgements).toEqual([2, 3, 4]);
      expect(replies.map((ack) => ack.generation)).toEqual([1, 1, 1]);
      expect(replies[1]?.result.kind).toBe("search");
      const result = replies[1]!.result;
      if (result.kind !== "search") throw new Error("Expected search result");
      expect(result.hits.map((hit) => hit.item.id)).toEqual(["T1"]);
      expect(projection.health()).toMatchObject({
        state: "current",
        pendingCommands: 0,
        acknowledgedCommandId: 4,
      });
      expect(replies[2]!.result).toEqual({ kind: "health", health: projection.health() });
    } finally {
      await projection.execute({ kind: "close" });
    }
  });

  test("inputs and returned items cannot mutate the projection [Blackbox-Group]", async () => {
    const projection = make();
    try {
      const input = item("T1", "owned");
      const build = projection.execute({
        kind: "snapshot",
        buckets: [{ ledgerId: "tasks", archived: false, items: [input] }],
      });
      input.fields.headline = "aliased";
      await build;
      const found = await hits(projection, "owned", false);
      expect(found).toHaveLength(1);
      found[0]!.item.fields.headline = "aliased";
      expect((await hits(projection, "owned", false))[0]!.item.fields.headline).toBe("owned");
      expect(await hits(projection, "aliased", false)).toEqual([]);
    } finally {
      await projection.execute({ kind: "close" });
    }
  });

  test("close rejects queued commands and prevents restart [Blackbox-Group]", async () => {
    const projection = make();
    await projection.execute({ kind: "snapshot", buckets: [] });
    const pending = Promise.allSettled([
      projection.execute({ kind: "health" }),
      projection.execute({ kind: "health" }),
    ]);
    const close = await projection.execute({ kind: "close" });
    expect(close.result.kind).toBe("close");
    for (const result of await pending) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.reason).toBe("closed");
    }
    await expect(projection.execute({ kind: "snapshot", buckets: [] })).rejects.toMatchObject({
      reason: "closed",
    });
    expect(projection.health().state).toBe("closed");
  });
}

describe("direct search projection", () =>
  searchProjectionContract(() => createDirectSearchProjection(COMMAND_DEADLINE_MS)));
describe("worker search projection", () =>
  searchProjectionContract(() => createWorkerSearchProjection(COMMAND_DEADLINE_MS)));
