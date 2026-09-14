import { describe, expect, test } from "bun:test";
import type { Item } from "../src/types.js";
import type { OperatorActionLifecycleMutation, OperatorActionLifecycleMutationResult } from "../src/store/operatorActionLifecycle.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

export interface OperatorActionSeedRow { readonly ledgerId: string; readonly item: Item }
export const OPERATOR_ACTION_ROWS: readonly OperatorActionSeedRow[] = [
  { ledgerId: "operatorActions", item: {
    id: "OA1", milestoneId: "M1", status: "pending", createdAt: LIFECYCLE_NOW, updatedAt: LIFECYCLE_NOW,
    fields: { headline: "operator action", revision: "1", expectedOutputIdentity: "identity-1", expectedEvidence: ["probe"], taskRef: "tasks:T1" },
  } },
  { ledgerId: "tasks", item: {
    id: "T1", milestoneId: "M1", status: "planned", createdAt: LIFECYCLE_NOW, updatedAt: LIFECYCLE_NOW,
    fields: { headline: "operator task" },
  } },
  { ledgerId: "handoffs", item: {
    id: "HO1", milestoneId: "M1", status: "user-action-required", createdAt: LIFECYCLE_NOW, updatedAt: LIFECYCLE_NOW,
    fields: { summary: "operator handoff" },
  } },
];

export const OPERATOR_ACKNOWLEDGE = {
  kind: "acknowledge", actionId: "OA1", expectedRevision: 1,
  outputIdentity: "identity-1", acknowledgedAt: LIFECYCLE_NOW,
} as const satisfies OperatorActionLifecycleMutation;
export const OPERATOR_EVIDENCE = {
  kind: "record-evidence", actionId: "OA1", expectedRevision: 1,
  evidence: { command: "probe", stdout: "ready", stderr: "", exitCode: 0, outputIdentity: "identity-1", observedAt: LIFECYCLE_NOW },
  provenance: LIFECYCLE_PROVENANCE,
} as const satisfies OperatorActionLifecycleMutation;
export const OPERATOR_REVISE = {
  kind: "revise", actionId: "OA1", expectedRevision: 1, expectedOutputIdentity: "identity-2",
  expectedEvidence: ["probe-2"], revisedAt: LIFECYCLE_NOW, provenance: LIFECYCLE_PROVENANCE,
} as const satisfies OperatorActionLifecycleMutation;
export const OPERATOR_COMPLETE = {
  kind: "complete", actionId: "OA1", expectedRevision: 1,
  completion: "verified", provenance: LIFECYCLE_PROVENANCE,
} as const satisfies OperatorActionLifecycleMutation;
export const OPERATOR_SUPERSEDE = {
  kind: "supersede", actionId: "OA1", expectedRevision: 1,
  reason: "superseded", supersededAt: LIFECYCLE_NOW, provenance: LIFECYCLE_PROVENANCE,
} as const satisfies OperatorActionLifecycleMutation;

export interface OperatorActionContractFixture {
  mutate(input: OperatorActionLifecycleMutation): Promise<OperatorActionLifecycleMutationResult>;
  fetch(ledgerId: string, itemId: string): Item;
  dispose(): Promise<void>;
}

export function runOperatorActionLifecycleContract(
  name: string,
  build: (seed: readonly OperatorActionSeedRow[]) => Promise<OperatorActionContractFixture>,
): void {
  describe(`keyed operator-action lifecycle — ${name} [Behavioral-Active Blackbox]`, () => {
    test("identity and revision controls leave state unchanged; acknowledgement retains its epoch on exact retry", async () => {
      const fixture = await build(OPERATOR_ACTION_ROWS);
      try {
        expect(await fixture.mutate({ ...OPERATOR_ACKNOWLEDGE, outputIdentity: "wrong" })).toMatchObject({ state: "pending", reason: "identity-mismatch" });
        expect(fixture.fetch("operatorActions", "OA1")).toEqual(OPERATOR_ACTION_ROWS[0]!.item);
        await expect(fixture.mutate({ ...OPERATOR_ACKNOWLEDGE, expectedRevision: 2 })).rejects.toThrow("revision conflict");
        const acknowledged = await fixture.mutate(OPERATOR_ACKNOWLEDGE);
        expect(acknowledged).toMatchObject({ state: "acknowledged", action: { fields: { acknowledgementEpoch: "1" } } });
        expect(await fixture.mutate(OPERATOR_ACKNOWLEDGE)).toEqual(acknowledged);
      } finally { await fixture.dispose(); }
    });
    test("failed evidence, revision history and renewed verification drive the coherent task/handoff closure", async () => {
      const fixture = await build(OPERATOR_ACTION_ROWS);
      try {
        await fixture.mutate(OPERATOR_ACKNOWLEDGE);
        expect(await fixture.mutate({ ...OPERATOR_EVIDENCE, evidence: { ...OPERATOR_EVIDENCE.evidence, exitCode: 1 } }))
          .toMatchObject({ state: "pending", reason: "probe-failed" });
        expect(await fixture.mutate(OPERATOR_REVISE)).toMatchObject({ kind: "revise", action: { fields: { revision: "2" } }, task: { status: "planned" }, handoff: { status: "user-action-required" } });
        const history = fixture.fetch("operatorActions", "OA1").fields.revisionHistory;
        expect(Array.isArray(history) && history.length === 1).toBe(true);
        await fixture.mutate({ ...OPERATOR_ACKNOWLEDGE, expectedRevision: 2, outputIdentity: "identity-2" });
        expect(await fixture.mutate({ ...OPERATOR_EVIDENCE, expectedRevision: 2, evidence: { ...OPERATOR_EVIDENCE.evidence, command: "probe-2", outputIdentity: "identity-2" } }))
          .toMatchObject({ state: "verified" });
        expect(await fixture.mutate({ ...OPERATOR_COMPLETE, expectedRevision: 2 })).toMatchObject({ kind: "complete", task: { status: "done", fields: { completion: "verified" } } });
      } finally { await fixture.dispose(); }
    });
    test("supersession retains exact terminal retry and rejects changed evidence", async () => {
      const fixture = await build(OPERATOR_ACTION_ROWS);
      try {
        const result = await fixture.mutate(OPERATOR_SUPERSEDE);
        expect(result).toMatchObject({ action: { status: "superseded" }, task: { status: "abandoned" } });
        expect(await fixture.mutate(OPERATOR_SUPERSEDE)).toEqual(result);
        await expect(fixture.mutate({ ...OPERATOR_SUPERSEDE, reason: "different" })).rejects.toThrow("different evidence");
      } finally { await fixture.dispose(); }
    });
    for (const status of ["wip", "missing"] as const) {
      test(`unsafe linked task (${status}) refuses revision without changing the action`, async () => {
        const seed = OPERATOR_ACTION_ROWS.flatMap((row) => row.ledgerId !== "tasks" ? [row]
          : status === "missing" ? [] : [{ ...row, item: { ...row.item, status } }]);
        const fixture = await build(seed);
        try {
          await expect(fixture.mutate(OPERATOR_REVISE)).rejects.toThrow(status === "missing"
            ? "Item not found in ledger tasks: T1" : "may be revised only from planned or abandoned");
          expect(fixture.fetch("operatorActions", "OA1")).toEqual(OPERATOR_ACTION_ROWS[0]!.item);
        } finally { await fixture.dispose(); }
      });
    }
  });
}
