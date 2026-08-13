import { describe, expect, it } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import { FakeClient } from "./fakeClient.js";
import type { FetchedLedger, ItemProjection, LedgerSchema, LedgerSummary } from "../src/types.js";

const DOWN = "\u001b[B";
const ENTER = "\r";
const TS = "2026-01-01T00:00:00.000Z";
const memoriesSchema: LedgerSchema = {
  statusValues: ["active", "superseded", "forgotten"],
  terminalStatuses: ["superseded", "forgotten"],
  idPrefix: "MEM",
  transitions: { active: ["superseded", "forgotten"], superseded: [], forgotten: [] },
  fields: {
    title: { type: "string", required: true },
    content: { type: "string", required: true },
  },
};

class MemoriesClient extends FakeClient {
  override async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [...(await super.enumerateLedgers()), { name: "memories", itemCount: 1 }].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  override async fetchLedger(id: string, projection: ItemProjection): Promise<FetchedLedger> {
    if (id !== "memories") return super.fetchLedger(id, projection);
    return {
      id,
      schema: memoriesSchema,
      counters: { milestone: 0, item: 1 },
      milestones: [
        {
          id: "M-AMBIENT",
          milestone: {
            id: "M-AMBIENT",
            status: "open",
            title: "ambient",
            description: "",
          },
          items: [
            {
              id: "MEM1",
              milestoneId: "M-AMBIENT",
              status: "active",
              fields: {
                title: "Canonical memory",
                ...(projection === "full"
                  ? { content: "A durable project fact rendered by the generic detail view." }
                  : {}),
              },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        },
      ],
      archivePointers: [],
    };
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

describe("ledger-tui generic memories navigation", () => {
  it("enumerates Memories and opens its item through the ordinary ledger/item views", async () => {
    const rendered = render(<App client={new MemoriesClient()} />);
    await tick();
    expect(rendered.lastFrame()).toContain("memories");

    rendered.stdin.write(DOWN);
    await tick();
    rendered.stdin.write(ENTER);
    await tick();
    expect(rendered.lastFrame()).toContain("MEM1");
    expect(rendered.lastFrame()).toContain("Canonical memory");

    rendered.stdin.write(ENTER);
    await tick();
    expect(rendered.lastFrame()).toContain("MEM1 @ memories");
    expect(rendered.lastFrame()).toContain("A durable project fact rendered by the generic");
    expect(rendered.lastFrame()).toContain("detail view.");
    rendered.unmount();
  });
});
