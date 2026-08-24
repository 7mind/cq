import { describe, expect, test } from "bun:test";
import {
  FULL_LEDGER_TOOL_PROFILE,
  InMemoryLedgerStore,
  createLedgerMcpTools,
} from "../src/index.js";
import {
  IMPLEMENTATION_RESULT,
  IMPLEMENTATION_WORKER,
  createImplementationEvidenceFixture,
} from "./implementationEvidenceTestSupport.js";

function textPayload(result: unknown): unknown {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("implementation evidence tool returned no text payload");
  }
  return JSON.parse(first.text);
}

describe("implementation evidence direct transport [Behavioral-Active Blackbox-Atomic]", () => {
  test("invokes the protected service through the canonical tool specification", async () => {
    const fixture = await createImplementationEvidenceFixture();
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const tools = createLedgerMcpTools(
      ledger,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      FULL_LEDGER_TOOL_PROFILE,
      undefined,
      undefined,
      fixture.service,
    );
    const tool = tools.find((entry) => entry.name === "prepare_implementation_review_panel");
    if (tool === undefined) throw new Error("protected implementation tool is absent");
    const result = await tool.handler(
      {
        task_ref: "tasks:T2345",
        result_commit: IMPLEMENTATION_RESULT,
        worker_dispatch: IMPLEMENTATION_WORKER,
        operation_id: "panel",
        author: "parent",
      } as never,
      null,
    );
    expect(textPayload(result)).toMatchObject({
      status: "existing",
      panelRef: fixture.panel.panelRef,
      attemptRefs: [fixture.attemptRef],
    });
  });
});
