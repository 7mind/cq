import { describe, expect, test } from "bun:test";
import {
  FINALIZED_IMPLEMENTATION_REVIEW_OUTCOME_CONTRACT,
  IMPLEMENTATION_EVIDENCE_SERVICE_OPERATION_INVENTORY,
} from "@cq/ledger";
import { runImplementationEvidenceStatus } from "../src/implementationEvidenceStatus.js";

function serviceStatus() {
  return {
    version: 1,
    startupBuildCommit: "1".repeat(40),
    repositoryHead: "2".repeat(40),
    protocolVersion: 2,
    goalRef: "goals:G176",
    finalizedManifestDigest: "3".repeat(64),
    mappings: {
      evidenceTaskRef: "tasks:T3000",
      historicalTaskRef: "tasks:T3001",
      activationTaskRef: "tasks:T3002",
    },
    bootstrapPhase: "activation-handoff",
    activationState: { status: "absent", requirementRef: null, activationRef: null },
    packagedManifestInventory: ["d347-implementation-evidence-activation-v1"],
    operationInventory: [...IMPLEMENTATION_EVIDENCE_SERVICE_OPERATION_INVENTORY],
    finalizedReviewOutcomeContract: FINALIZED_IMPLEMENTATION_REVIEW_OUTCOME_CONTRACT,
  };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, adapter: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
}

describe("implementation evidence status CLI [BA]", () => {
  test("prints authenticated service identity without consulting the local checkout", async () => {
    const captured = io();
    let queriedCwd = "";
    const result = await runImplementationEvidenceStatus(
      ["implementation-evidence", "status", "--json", "--cwd", "/checkout/that/does/not/exist"],
      captured.adapter,
      "/unused",
      async (cwd) => {
        queriedCwd = cwd;
        return serviceStatus();
      },
    );
    expect(result.exitCode).toBe(0);
    expect(queriedCwd).toBe("/checkout/that/does/not/exist");
    expect(JSON.parse(captured.out[0]!)).toMatchObject({
      startupBuildCommit: "1".repeat(40),
      repositoryHead: "2".repeat(40),
      bootstrapPhase: "activation-handoff",
    });
    expect(captured.err).toEqual([]);
  });

  test("rejects caller-asserted service identity", async () => {
    const captured = io();
    let queried = false;
    const result = await runImplementationEvidenceStatus(
      [
        "implementation-evidence",
        "status",
        "--json",
        "--expected-head",
        "1".repeat(40),
      ],
      captured.adapter,
      "/checkout",
      async () => {
        queried = true;
        return serviceStatus();
      },
    );
    expect(result.exitCode).toBe(2);
    expect(queried).toBe(false);
    expect(captured.err[0]).toContain("service-derived");
  });

  for (const [name, mutate, expected] of [
    [
      "old protocol",
      (status: ReturnType<typeof serviceStatus>) => ({ ...status, protocolVersion: 1 }),
      "protocol",
    ],
    [
      "missing operation",
      (status: ReturnType<typeof serviceStatus>) => ({ ...status, operationInventory: [] }),
      "operation inventory",
    ],
    [
      "missing finalized outcome support",
      (status: ReturnType<typeof serviceStatus>) => ({
        ...status,
        finalizedReviewOutcomeContract: null,
      }),
      "outcome contract",
    ],
  ] as const) {
    test(`rejects ${name}`, async () => {
      const captured = io();
      const result = await runImplementationEvidenceStatus(
        ["implementation-evidence", "status", "--json"],
        captured.adapter,
        "/checkout",
        async () => mutate(serviceStatus()) as never,
      );
      expect(result.exitCode).toBe(1);
      expect(captured.err[0]).toContain(expected);
    });
  }
});
