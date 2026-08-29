import { describe, expect, test } from "bun:test";
import {
  FULL_LEDGER_TOOL_PROFILE,
  InMemoryLedgerStore,
  createLedgerMcpTools,
  createManagementLedgerMcpTools,
} from "../src/index.js";
import { createImplementationEvidenceFixture } from "./implementationEvidenceTestSupport.js";

function textPayload(result: unknown): Record<string, unknown> {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string")
    throw new Error("implementation evidence status returned no text payload");
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("implementation evidence service status transport [BA]", () => {
  test("is management-only and derives build, head, protocol, mapping, and inventories", async () => {
    const fixture = await createImplementationEvidenceFixture();
    fixture.setHead("b".repeat(40));
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const ordinary = createLedgerMcpTools(
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
    expect(
      ordinary.some((tool) => tool.name === "get_implementation_evidence_service_status"),
    ).toBe(false);
    const management = createManagementLedgerMcpTools(
      ledger,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      FULL_LEDGER_TOOL_PROFILE,
      undefined,
      fixture.service,
    );
    const tool = management.find(
      (entry) => entry.name === "get_implementation_evidence_service_status",
    );
    if (tool === undefined) throw new Error("service status tool is absent");
    const payload = textPayload(await tool.handler({} as never, null));
    expect(payload).toMatchObject({
      version: 1,
      startupBuildCommit: "a".repeat(40),
      repositoryHead: "b".repeat(40),
      protocolVersion: 2,
      goalRef: "goals:G176",
      finalizedManifestDigest: "f".repeat(64),
      bootstrapPhase: "historical-dispatch",
      activationState: { status: "absent" },
      mappings: {
        evidenceTaskRef: "tasks:T3000",
        historicalTaskRef: "tasks:T3001",
        activationTaskRef: "tasks:T3002",
      },
    });
    expect(payload["operationInventory"]).toEqual([
      "prepare_implementation_review_panel",
      "prepare_implementation_review_attempt",
      "execute_external_implementation_review_attempt",
      "finalize_implementation_review_attempt",
      "prepare_implementation_review_fallback",
      "prepare_implementation_audit_panel",
      "prepare_implementation_audit_attempt",
      "execute_external_implementation_audit_attempt",
      "finalize_implementation_audit_attempt",
      "prepare_implementation_audit_fallback",
      "advance_implementation_evidence_bootstrap",
      "arm_implementation_evidence_activation",
      "apply_implementation_audit_manifest",
      "get_implementation_evidence_activation_status",
      "get_implementation_evidence_service_status",
      "prepare_implementation_completion",
      "record_implementation_completion",
    ]);
    expect(payload["finalizedReviewOutcomeContract"]).toEqual({
      version: 1,
      outcomeKinds: ["verdict", "operational-abstention"],
      verdictSchema: "implement-reviewer-output",
      maxOutcomesPerFinalization: 1,
    });
  });
});
