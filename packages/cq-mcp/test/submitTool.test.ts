/**
 * Unit test for the cq-mcp `submit_workflow_phase` tool factory (codexwf).
 *
 * Drives the registered handler through a minimal fake McpServer that captures
 * the handler, and asserts:
 *   - the handler relays `workflow.submit{submitId, phase, payload}` upstream
 *     verbatim (no per-phase validation on the cq-mcp side);
 *   - on ack{ok:true} it returns a non-error success result;
 *   - on ack{ok:false} it returns an isError result carrying the server's error;
 *   - it NEVER touches a ledger store (the factory takes no store at all).
 */

import { describe, it, expect } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSubmitWorkflowPhaseTool } from "../src/main";
import { CqMcpSubmitBroker } from "../src/submitBroker";

type ToolHandler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** Capture the registered tool name + handler from a fake McpServer. */
function fakeServer(): { server: McpServer; getHandler: () => ToolHandler; name: () => string } {
  let captured: ToolHandler | undefined;
  let toolName: string | undefined;
  const server = {
    registerTool(name: string, _def: unknown, handler: ToolHandler): void {
      toolName = name;
      captured = handler;
    },
  } as unknown as McpServer;
  return {
    server,
    getHandler: () => {
      if (captured === undefined) throw new Error("tool not registered");
      return captured;
    },
    name: () => toolName ?? "",
  };
}

describe("submit_workflow_phase tool (codexwf)", () => {
  it("registers under the name `submit_workflow_phase`", () => {
    const fs = fakeServer();
    const broker = new CqMcpSubmitBroker();
    registerSubmitWorkflowPhaseTool(fs.server, {
      broker,
      submitId: "s-1",
      phase: "produce",
      sendSubmit: () => {},
    });
    expect(fs.name()).toBe("submit_workflow_phase");
  });

  it("relays the payload upstream verbatim and resolves on ack{ok:true}", async () => {
    const fs = fakeServer();
    const broker = new CqMcpSubmitBroker();
    const sent: Array<{ submitId: string; phase: string; payload: unknown }> = [];
    registerSubmitWorkflowPhaseTool(fs.server, {
      broker,
      submitId: "s-7",
      phase: "plan",
      sendSubmit: (req) => sent.push(req),
    });

    const payload = { milestones: [{ title: "m", description: "d" }], tasks: [] };
    const handlerPromise = fs.getHandler()({ payload });
    // The relay fires synchronously before the handler parks.
    expect(sent).toEqual([{ submitId: "s-7", phase: "plan", payload }]);
    // Server acks ok → handler returns a non-error success result.
    broker.ack("s-7", { ok: true });
    const result = await handlerPromise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.type).toBe("text");
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true });
  });

  it("returns an isError result carrying the server error on ack{ok:false}", async () => {
    const fs = fakeServer();
    const broker = new CqMcpSubmitBroker();
    registerSubmitWorkflowPhaseTool(fs.server, {
      broker,
      submitId: "s-bad",
      phase: "clarify_review",
      sendSubmit: () => {},
    });

    const handlerPromise = fs.getHandler()({ payload: { clear: "not-a-bool" } });
    broker.ack("s-bad", { ok: false, error: "clear: expected boolean" });
    const result = await handlerPromise;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("clear: expected boolean");
    expect(result.content[0]!.text).toContain("resubmit");
  });

  it("rejects the handler when the channel drops mid-submit (broker rejectAll)", async () => {
    const fs = fakeServer();
    const broker = new CqMcpSubmitBroker();
    registerSubmitWorkflowPhaseTool(fs.server, {
      broker,
      submitId: "s-drop",
      phase: "plan_review",
      sendSubmit: () => {},
    });
    const handlerPromise = fs.getHandler()({ payload: {} });
    broker.rejectAll("channel closed");
    await expect(handlerPromise).rejects.toThrow("channel closed");
  });
});
