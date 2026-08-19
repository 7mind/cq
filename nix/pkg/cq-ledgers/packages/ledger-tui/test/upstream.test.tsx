import { describe, expect, it } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import { FakeClient } from "./fakeClient.js";
import type {
  FetchedLedger,
  ItemProjection,
  LedgerSchema,
  LedgerSummary,
} from "../src/types.js";

const TS = "2026-01-01T00:00:00.000Z";
const schema: LedgerSchema = {
  statusValues: ["open", "reported", "released", "wontfix"],
  terminalStatuses: ["released", "wontfix"],
  idPrefix: "U",
  fields: {
    headline: { type: "string", required: true },
    package: { type: "string", required: true },
  },
};

class UpstreamClient extends FakeClient {
  override async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "upstream", itemCount: 1 }];
  }

  override async fetchLedger(id: string, projection: ItemProjection): Promise<FetchedLedger> {
    if (id !== "upstream") return super.fetchLedger(id, projection);
    return {
      id,
      schema,
      counters: { milestone: 1, item: 1 },
      milestones: [
        {
          id: "M-AMBIENT",
          milestone: { id: "M-AMBIENT", status: "open", title: "ambient", description: "" },
          items: [
            {
              id: "U1",
              milestoneId: "M-AMBIENT",
              status: "open",
              fields: { headline: "pkg bug", package: "example" },
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
async function waitFor(getFrame: () => string, text: string): Promise<void> {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    if (getFrame().includes(text)) return;
    await tick();
  }
  throw new Error(`waitFor: '${text}' never appeared`);
}

describe("T818 TUI presents the upstream ledger", () => {
  it("lists upstream from enumerate and shows package through MCP [BA]", async () => {
    const rendered = render(<App client={new UpstreamClient()} />);
    const frame = (): string => rendered.lastFrame() ?? "";
    await waitFor(frame, "upstream");
    rendered.stdin.write("\r");
    await waitFor(frame, "U1");
    expect(frame()).toContain("example");
    rendered.unmount();
  });
});
