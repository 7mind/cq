/**
 * T616: McpLedgerClient.archiveMilestone(milestoneId, summary) — the ONCE
 * addition deferred by G85/T604. Asserts the wire call serializes to
 * { milestone_id, summary } (server tool's argument names, `archive_milestone`
 * MCP tool per ledgerTools.ts) and the decoded { pointer } envelope is
 * unwrapped into the returned ArchivePointer.
 */
import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpLedgerClient } from "../src/mcpClient.js";
import type { ArchivePointer } from "../src/types.js";

function stubClient(pointer: ArchivePointer): { client: Client; calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  const stub = {
    callTool: async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
      calls.push({ name, args });
      if (name !== "archive_milestone") throw new Error(`unexpected tool ${name}`);
      return { content: [{ type: "text", text: JSON.stringify({ pointer }) }] };
    },
  };
  return { client: stub as unknown as Client, calls };
}

describe("McpLedgerClient.archiveMilestone (T616)", () => {
  it("invokes archive_milestone with { milestone_id, summary } and returns the decoded pointer", async () => {
    const pointer: ArchivePointer = {
      id: "M1",
      path: "./archive/milestones/M1.md",
      summary: "wrapped up",
      title: "Foundations",
      status: "done",
    };
    const { client: stub, calls } = stubClient(pointer);
    const client = new McpLedgerClient(stub);

    const result = await client.archiveMilestone("M1", "wrapped up");

    expect(calls).toEqual([{ name: "archive_milestone", args: { milestone_id: "M1", summary: "wrapped up" } }]);
    expect(result).toEqual(pointer);
  });
});
