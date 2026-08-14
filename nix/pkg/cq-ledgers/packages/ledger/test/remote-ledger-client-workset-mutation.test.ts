/** T1982: RemoteLedgerClient exposes the complete guarded ordinary mutation surface. */

import { afterEach, describe, expect, it } from "bun:test";
import { RemoteLedgerClient, type LedgerSchema } from "../src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

function responseFor(name: string): unknown {
  const item = {
    id: name === "create_item" ? "T9" : "T1",
    milestoneId: "M1",
    status: "planned",
    fields: {},
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
  if (name === "create_ledger") return { ledger: { id: "custom" } };
  if (name === "archive_milestone") {
    return {
      pointer: {
        id: "M1",
        path: "./archive/milestones/M1.md",
        summary: "done",
        title: "M1",
        status: "done",
      },
    };
  }
  return { item };
}

function installMutationProbe(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "GET") return new Response("not offered", { status: 405 });
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    const body = (await request.json()) as {
      readonly id?: string | number | null;
      readonly method?: string;
      readonly params?: {
        readonly protocolVersion?: string;
        readonly name?: string;
        readonly arguments?: Record<string, unknown>;
      };
    };
    if (body.method?.startsWith("notifications/") === true) {
      return new Response(null, { status: 202 });
    }
    const headers = {
      "content-type": "application/json",
      "mcp-session-id": "t1982-remote-session",
    };
    if (body.method === "tools/call") {
      if (body.params?.name === undefined || body.params.arguments === undefined) {
        throw new Error("tools/call omitted its name or arguments");
      }
      calls.push({ name: body.params.name, arguments: body.params.arguments });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: {
            content: [
              { type: "text", text: JSON.stringify(responseFor(body.params.name)) },
            ],
          },
        }),
        { status: 200, headers },
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "t1982-remote-probe", version: "0.0.1" },
        },
      }),
      { status: 200, headers },
    );
  }) as typeof fetch;
  return calls;
}

const CUSTOM_SCHEMA: LedgerSchema = {
  idPrefix: "X",
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { headline: { type: "string", required: true } },
};

describe("RemoteLedgerClient workset-guarded ordinary mutations [Behavioral-Active Blackbox-Group]", () => {
  it("forwards each operation exactly once without serialized admission context", async () => {
    const calls = installMutationProbe();
    const remote = await RemoteLedgerClient.connect({
      serverUrl: "http://ledger.invalid",
      projectKey: "t1982",
      token: "ordinary-token",
    });
    try {
      await remote.createItem("tasks", "M1", {
        id: "T9",
        status: "planned",
        fields: { headline: "create" },
      });
      await remote.updateItem("tasks", "T1", { fields: { headline: "update" } });
      await remote.createMilestone({ id: "M9", title: "create milestone" });
      await remote.updateMilestone("M1", { title: "update milestone" });
      await remote.createLedger("custom", CUSTOM_SCHEMA);
      await remote.archiveMilestone("M1", "done");
      await remote.reopenItem("tasks", "T1", "planned");
      await remote.unarchiveItem("tasks", "M1", "T1");

      expect(calls.map(({ name }) => name)).toEqual([
        "create_item",
        "update_item",
        "create_item",
        "update_item",
        "create_ledger",
        "archive_milestone",
        "reopen_item",
        "unarchive_item",
      ]);
      for (const call of calls) {
        expect(call.arguments).not.toHaveProperty("worksetContext");
        expect(call.arguments).not.toHaveProperty("admission");
        expect(call.arguments).not.toHaveProperty("authority");
      }
    } finally {
      await remote.close();
    }
  });
});
