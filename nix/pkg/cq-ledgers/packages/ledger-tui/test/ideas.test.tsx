import { describe, expect, it } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import { FakeClient } from "./fakeClient.js";
import type {
  FetchedLedger,
  ItemInit,
  ItemMutationAckDto,
  ItemProjection,
  LedgerSchema,
  LedgerSummary,
} from "../src/types.js";

const ENTER = "\r";
const BACKSPACE = "\x7f";
const TS = "2026-01-01T00:00:00.000Z";
const ideasSchema: LedgerSchema = {
  statusValues: ["open", "planned", "discarded", "postponed"],
  terminalStatuses: ["planned", "discarded"],
  idPrefix: "I",
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: false },
  },
};

type CreateCall = { ledgerId: string; milestoneId: string; init: ItemInit };

class IdeasClient extends FakeClient {
  readonly createCalls: CreateCall[] = [];

  override async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "ideas", itemCount: 1 }];
  }

  override async fetchLedger(id: string, projection: ItemProjection): Promise<FetchedLedger> {
    if (id !== "ideas") return super.fetchLedger(id, projection);
    return {
      id,
      schema: ideasSchema,
      counters: { milestone: 1, item: 1 },
      milestones: [
        {
          id: "M-AMBIENT",
          milestone: { id: "M-AMBIENT", status: "open", title: "ambient", description: "" },
          items: [
            {
              id: "I1",
              milestoneId: "M-AMBIENT",
              status: "open",
              fields: { title: "first idea", description: "desc one" },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        },
      ],
      archivePointers: [],
    };
  }

  override async createItem(
    ledgerId: string,
    milestoneId: string,
    init: ItemInit,
  ): Promise<ItemMutationAckDto> {
    this.createCalls.push({ ledgerId, milestoneId, init });
    return {
      id: "I2",
      milestoneId,
      status: init.status,
      fields: {},
      createdAt: TS,
      updatedAt: TS,
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

async function type(write: (input: string) => void, text: string): Promise<void> {
  for (const character of text) {
    write(character);
    await tick();
  }
}

describe("ideas ambient presentation [Behavioral-Active, Blackbox-Atomic]", () => {
  it("omits work-milestone metadata from idea detail", async () => {
    const rendered = render(<App client={new IdeasClient()} />);
    const frame = (): string => rendered.lastFrame() ?? "";
    await waitFor(frame, "ideas");
    rendered.stdin.write(ENTER);
    await waitFor(frame, "I1");
    rendered.stdin.write(ENTER);
    await tick();

    expect(frame()).toContain("I1 @ ideas");
    expect(frame()).not.toContain("milestone M-AMBIENT");
    rendered.unmount();
  });

  it("creates an idea directly under M-AMBIENT without a milestone step", async () => {
    const client = new IdeasClient();
    const rendered = render(<App client={client} />);
    const frame = (): string => rendered.lastFrame() ?? "";
    await waitFor(frame, "ideas");
    rendered.stdin.write(ENTER);
    await waitFor(frame, "I1");
    rendered.stdin.write("n");
    await waitFor(frame, "open");

    expect(frame()).not.toContain("Bootstrap");
    rendered.stdin.write(ENTER);
    await waitFor(frame, "field 1/2");
    await type((input) => rendered.stdin.write(input), "second idea");
    rendered.stdin.write(ENTER);
    await waitFor(frame, "field 2/2");
    for (const _character of "second idea") {
      rendered.stdin.write(BACKSPACE);
      await tick();
    }
    rendered.stdin.write(ENTER);
    await tick();

    expect(client.createCalls).toEqual([
      {
        ledgerId: "ideas",
        milestoneId: "M-AMBIENT",
        init: {
          status: "open",
          fields: { title: "second idea" },
          author: "user",
        },
      },
    ]);
    rendered.unmount();
  });
});
