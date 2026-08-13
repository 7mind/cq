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

describe("ItemReferenceLookup", () => {
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
