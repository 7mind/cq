import { describe, expect, test } from "bun:test";
import {
  queryImplementationEvidenceStatus,
  runImplementationEvidenceStatus,
} from "../src/implementationEvidenceStatus.js";

const EXPECTED_OPERATIONS = [
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
  "continue_implementation_evidence_activation",
  "get_implementation_evidence_service_status",
  "prepare_implementation_completion",
  "record_implementation_completion",
] as const;

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
    operationInventory: [...EXPECTED_OPERATIONS],
    finalizedReviewOutcomeContract: {
      version: 1,
      outcomeKinds: ["verdict", "operational-abstention"],
      verdictSchema: "implement-reviewer-output",
      maxOutcomesPerFinalization: 1,
    },
  };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    adapter: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
  };
}

describe("implementation evidence status CLI [BA]", () => {
  test("routes local backends to embedded management and remote to its authenticated client", async () => {
    const calls: string[] = [];
    const queries = {
      embedded: async (cwd: string) => {
        calls.push(`embedded:${cwd}`);
        return { transport: "embedded" };
      },
      remote: async (cwd: string) => {
        calls.push(`remote:${cwd}`);
        return { transport: "remote" };
      },
    };

    expect(await queryImplementationEvidenceStatus("/xdg", "xdg", queries)).toEqual({
      transport: "embedded",
    });
    expect(await queryImplementationEvidenceStatus("/remote", "remote", queries)).toEqual({
      transport: "remote",
    });
    expect(calls).toEqual(["embedded:/xdg", "remote:/remote"]);
  });

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
    for (const argument of [
      "--goal-ref",
      "--manifest-id",
      "--expected-head",
      "--expected-repository-head",
      "--repository-head",
    ]) {
      const captured = io();
      let queried = false;
      const result = await runImplementationEvidenceStatus(
        ["implementation-evidence", "status", "--json", argument, "caller-identity"],
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
    }
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
