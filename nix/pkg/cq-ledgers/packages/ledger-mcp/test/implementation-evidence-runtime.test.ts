import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  InMemoryLedgerStore,
  createInMemoryImplementationEvidenceStore,
  type DispatchCapability,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import { createProductionImplementationEvidenceService } from "../src/implementationEvidenceRuntime.js";

const RESULT = "b".repeat(40);
const WORKER = { attestationId: "att_runtime_worker", generation: 1 } as const;
const previousHarness = process.env["CQ_HARNESS"];

beforeEach(() => {
  process.env["CQ_HARNESS"] = "codex";
});

afterEach(() => {
  if (previousHarness === undefined) delete process.env["CQ_HARNESS"];
  else process.env["CQ_HARNESS"] = previousHarness;
});

describe("production implementation evidence runtime [Behavioral-Active Blackbox-Atomic]", () => {
  test("wires the default external reviewer to a trusted process seam", async () => {
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const resolved = {
      store: ledger,
      implementationEvidenceStore: createInMemoryImplementationEvidenceStore(),
    } as unknown as ResolvedLedgerStore;
    const observed: Array<{ adapterIdentity: string; prompt: string }> = [];
    const dispatchCapability = {
      prepare: async () => {
        throw new Error("native fallback is not exercised by this adapter test");
      },
      observeEvidence: async () => ({
        state: "consumed" as const,
        roleId: "implement-worker",
        input: {
          acceptance: "the protected runtime executes the configured reviewer",
          startingCommit: "a".repeat(40),
        },
        output: { status: "pass", resultCommit: RESULT },
        retainedAttestation: WORKER.attestationId,
      }),
    } as unknown as DispatchCapability;
    const service = createProductionImplementationEvidenceService({
      resolved,
      dispatchCapability,
      repositoryRoot: process.cwd(),
      environment: { CQ_HARNESS: "codex" },
      externalReviewRunner: async ({ identity, prompt }) => {
        observed.push({ adapterIdentity: identity.adapterId, prompt });
        return {
          adapterIdentity: identity.adapterId,
          stdout: "{}",
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "runtime-panel",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    const attempt = await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "runtime-attempt",
      author: "parent",
    });
    expect(attempt.launch).toBe("adapter");
    await service.executeExternalReviewAttempt({
      attemptRef,
      operationId: "runtime-execute",
      author: "parent",
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]!.adapterIdentity).toBe("pi:process");
    expect(observed[0]!.prompt).toContain("Output JSON Schema");
    expect(observed[0]!.prompt).toContain("protected runtime executes the configured reviewer");
  });

  test("constructs one production service and passes it to both standalone transports", async () => {
    const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source.match(/createProductionImplementationEvidenceService\(/gu)).toHaveLength(1);
    expect(source).toContain("implementationEvidence,\n    );");
    expect(source).toContain("{ implementationEvidence }");
  });
});
