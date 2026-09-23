import { describe, expect, it } from "bun:test";
import type { Item, ItemProjection } from "../src/types.js";
import { ItemReferenceLookup } from "../src/referenceLookup.js";
import { FakeClient } from "./fakeClient.js";

const LOCAL_TASK: Item = {
  id: "T77",
  milestoneId: "M1",
  status: "done",
  fields: { headline: "local headline", title: "ignored title" },
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

class DeferredFakeClient extends FakeClient {
  private release: (() => void) | null = null;

  override async fetchItem(ledgerId: string, itemId: string, projection: ItemProjection): Promise<Item> {
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return await super.fetchItem(ledgerId, itemId, projection);
  }

  resolveFetch(): void {
    if (this.release === null) throw new Error("no pending fetch");
    this.release();
  }
}

/** A client whose active store lost an id to the archive (D400). */
class ArchivedFakeClient extends FakeClient {
  constructor(private readonly archived: ReadonlyMap<string, { item: Item; pointerId: string }>) {
    super();
  }

  override async fetchItem(ledgerId: string, itemId: string, projection: ItemProjection): Promise<Item> {
    if (this.archived.has(`${ledgerId}:${itemId}`)) {
      throw new Error(`Item not found in ledger ${ledgerId}: ${itemId}`);
    }
    return await super.fetchItem(ledgerId, itemId, projection);
  }

  override async fetchItemIncludingArchived(
    ledgerId: string,
    itemId: string,
    projection: ItemProjection,
  ): Promise<{ item: Item; archived: readonly { pointerId: string }[] }> {
    const hit = this.archived.get(`${ledgerId}:${itemId}`);
    if (hit !== undefined) return { item: hit.item, archived: [{ pointerId: hit.pointerId }] };
    return { item: await super.fetchItem(ledgerId, itemId, projection), archived: [] };
  }
}

describe("ItemReferenceLookup", () => {
  it("D400: resolves a reference whose item was archived, carrying its provenance", async () => {
    const archivedItem: Item = {
      id: "T900",
      milestoneId: "M9",
      status: "done",
      fields: { headline: "archived work" },
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
    };
    const client = new ArchivedFakeClient(
      new Map([["tasks:T900", { item: archivedItem, pointerId: "M9" }]]),
    );
    const lookup = new ItemReferenceLookup(client);

    expect(await lookup.resolve({ ledger: "tasks", id: "T900" })).toEqual({
      kind: "found",
      ledger: "tasks",
      id: "T900",
      status: "done",
      summary: "archived work",
      archivedUnder: ["M9"],
    });
  });

  it("D400: a terminal but still-active item resolves with no archive provenance", async () => {
    const client = new ArchivedFakeClient(new Map());
    const lookup = new ItemReferenceLookup(client);
    const result = await lookup.resolve({ ledger: "tasks", id: "T1" });
    expect(result.kind).toBe("found");
    if (result.kind !== "found") throw new Error("expected found");
    expect(result.archivedUnder).toBeUndefined();
  });

  it("D400: a genuinely missing id is still not-found", async () => {
    const client = new ArchivedFakeClient(new Map());
    const lookup = new ItemReferenceLookup(client);
    expect(await lookup.resolve({ ledger: "tasks", id: "T99999" })).toEqual({
      kind: "not-found",
      ledger: "tasks",
      id: "T99999",
    });
  });

  it("uses loaded items before MCP and applies headline/title/question/summary precedence", async () => {
    const client = new FakeClient();
    const lookup = new ItemReferenceLookup(client);
    lookup.replaceLocalItems([{ ledger: "tasks", item: LOCAL_TASK }]);

    expect(await lookup.resolve({ ledger: "tasks", id: "T77" })).toEqual({
      kind: "found",
      ledger: "tasks",
      id: "T77",
      status: "done",
      summary: "local headline",
    });
    expect(client.fetchItemCalls).toHaveLength(0);
  });

  it("fetches a cold compact item once and memoizes the settled result", async () => {
    const client = new FakeClient();
    const lookup = new ItemReferenceLookup(client);

    const first = await lookup.resolve({ ledger: "tasks", id: "T1" });
    const second = await lookup.resolve({ ledger: "tasks", id: "T1" });

    expect(first).toEqual(second);
    expect(first.kind).toBe("found");
    expect(client.fetchItemCalls).toEqual([{ ledgerId: "tasks", itemId: "T1", projection: "compact" }]);
  });

  it("coalesces simultaneous same-key requests into one compact fetch", async () => {
    const client = new DeferredFakeClient();
    const lookup = new ItemReferenceLookup(client);
    const first = lookup.resolve({ ledger: "tasks", id: "T1" });
    const second = lookup.resolve({ ledger: "tasks", id: "T1" });
    await Promise.resolve();
    client.resolveFetch();

    expect(await first).toEqual(await second);
    expect(client.fetchItemCalls).toEqual([{ ledgerId: "tasks", itemId: "T1", projection: "compact" }]);
  });

  it("memoizes missing items as not-found without throwing", async () => {
    const client = new FakeClient();
    const lookup = new ItemReferenceLookup(client);

    expect(await lookup.resolve({ ledger: "tasks", id: "T999999" })).toEqual({
      kind: "not-found",
      ledger: "tasks",
      id: "T999999",
    });
    expect((await lookup.resolve({ ledger: "tasks", id: "T999999" })).kind).toBe("not-found");
    expect(client.fetchItemCalls).toHaveLength(1);
  });
});
