import { describe, expect, test } from "bun:test";
import { dispatchPayloadDigest, type DispatchJSONValue } from "@cq/config";
import {
  InvestigationCohortRunnerV1,
  InvestigationDispatchAuthenticatorV1,
  type AuthorizedInvestigationRunV1,
} from "../src/workCohortInvestigation.js";
import { parseWorkCohortPortableStateV1, type WorkCohortStore } from "../src/workCohortStore.js";
import { investigationRunnerFixture } from "./workCohortInvestigationFixture.js";
import { sha256 } from "./workCohortFixture.js";

export function workCohortInvestigationContract(
  label: string,
  create: () => Promise<{ readonly store: WorkCohortStore; readonly close: () => Promise<void> }>,
): void {
  describe(`investigation execution ${label}`, () => {
    test("parent-driven preparation exposes every independent member without claiming execution", async () => {
      const fixture = await create();
      try {
        const { plan, host, runner, lease } = await investigationRunnerFixture(fixture.store);
        host.execute = async () => undefined;
        const result = await runner.run(lease, plan);
        expect(result.members.map((member) => member.explorer?.binding.member.defectRef)).toEqual([
          "defects:D1", "defects:D2",
        ]);
        expect(result.members.every((member) => member.explorerResult === null)).toBe(true);
        expect(host.executions).toEqual([]);
        expect(result.state).toBe("awaiting-evidence");
      } finally {
        await fixture.close();
      }
    });
    test("final correction reopens earlier member evidence after later dispatches", async () => {
      const fixture = await create();
      try {
        const { plan, host, runner, lease } = await investigationRunnerFixture(fixture.store);
        let earlierSourceChanged = false;
        const execute = host.execute.bind(host);
        host.execute = async (prepared) => {
          await execute(prepared);
          if (prepared.binding.memberIndex === 1) earlierSourceChanged = true;
        };
        const resolve = host.resolveCitation.bind(host);
        host.resolveCitation = async (prepared, evidence) => {
          const observed = await resolve(prepared, evidence);
          return earlierSourceChanged && prepared.binding.memberIndex === 0
            ? { ...observed, text: "source changed after earlier adjudication" }
            : observed;
        };
        const result = await runner.run(lease, plan);
        expect(result.state).toBe("split");
        expect(result.split?.reason).toBe("invalid-citation");
        expect(result.implementationAtomDigest).toBeNull();
      } finally {
        await fixture.close();
      }
    });
    test("consumed terminal digest authenticates the completed result bytes", async () => {
      const fixture = await create();
      try {
        const { plan, host, runner, lease } = await investigationRunnerFixture(fixture.store);
        const result = await runner.run(lease, plan);
        const prepared = result.members[0]!.explorer!;
        const row = host.attestations.read(prepared.handle)!;
        if (row.kind !== "envelope") throw new Error("missing test envelope");
        const output = {
          ...(row.output as Record<string, DispatchJSONValue>),
          notes: "changed after native completion",
        };
        host.attestations.replace(row, {
          ...row,
          output,
          outputDigest: dispatchPayloadDigest(output),
        });
        expect(() =>
          new InvestigationDispatchAuthenticatorV1(host.attestations).authenticate(prepared),
        ).toThrow("terminal digest");
      } finally {
        await fixture.close();
      }
    });
    test("separate consumed explorers and bound probers produce separate cause receipts", async () => {
      const fixture = await create();
      try {
        const { plan, host, runner, lease } = await investigationRunnerFixture(fixture.store);
        host.probe = true;
        const result = await runner.run(lease, plan);
        expect(result.state).toBe("correction-ready");
        expect(host.executions.map((execution) => execution.role.roleId)).toEqual([
          "investigate-explorer",
          "investigate-prober",
          "investigate-explorer",
          "investigate-prober",
        ]);
        expect(result.members.map((member) => member.confirmedCause!.defectRef)).toEqual([
          "defects:D1",
          "defects:D2",
        ]);
        expect(
          new Set(result.members.map((member) => member.confirmedCause!.receiptDigest)).size,
        ).toBe(2);
        expect(result.members[0]!.prober!.binding.explorerReceiptDigest).toBe(
          result.members[0]!.explorerResult!.receiptDigest,
        );
        expect(result.members[1]!.prober!.binding.explorerReceiptDigest).toBe(
          result.members[1]!.explorerResult!.receiptDigest,
        );
        expect((await runner.run(lease, plan)).runDigest).toBe(result.runDigest);
        expect(host.executions.length).toBe(4);
        expect(
          parseWorkCohortPortableStateV1(
            await fixture.store.exportPortableState(),
          ).investigationRuns.at(-1),
        ).toEqual(result);
      } finally {
        await fixture.close();
      }
    });
    test("crash after one consumed result resumes without redispatching it or accepting the old epoch", async () => {
      const fixture = await create();
      try {
        const { plan, host, runner, lease } = await investigationRunnerFixture(fixture.store);
        host.interruptAfterExecution = 1;
        await expect(runner.run(lease, plan)).rejects.toThrow("simulated crash");
        const portable = parseWorkCohortPortableStateV1(await fixture.store.exportPortableState());
        expect(portable.investigationRuns.at(-1)!.members[0]!.explorerResult).toBeNull();
        await fixture.store.restorePortableState(portable);
        const resumed = new InvestigationCohortRunnerV1(fixture.store, host);
        await resumed.revalidateForResume(plan);
        await expect(resumed.run(lease, plan)).rejects.toThrow("epoch");
        const fresh = await fixture.store.acquireLease({
          holderId: "resumed",
          semanticSubject: plan.planDigest,
        });
        expect((await resumed.run(fresh, plan)).state).toBe("correction-ready");
        expect(host.executions.length).toBe(2);
      } finally {
        await fixture.close();
      }
    });
    test("invalid citation produces a durable split before any confirmed cause", async () => {
      const fixture = await create();
      try {
        const { plan, host, runner, lease } = await investigationRunnerFixture(fixture.store);
        host.invalidCitation = true;
        const result = await runner.run(lease, plan);
        expect(result.split?.reason).toBe("invalid-citation");
        expect(result.members.every((member) => member.confirmedCause === null)).toBe(true);
        expect((await fixture.store.snapshot()).portable.investigationRuns.at(-1)?.runDigest).toBe(
          result.runDigest,
        );
      } finally {
        await fixture.close();
      }
    });
    for (const [flag, reason] of [
      ["contradictory", "contradiction"],
      ["distinctCause", "non-shared-cause"],
      ["distinctBoundary", "incompatible-correction-boundary"],
      ["distinctAtom", "incompatible-correction-boundary"],
      ["inapplicableAtom", "incompatible-correction-boundary"],
    ] as const) {
      test(`${flag} splits instead of admitting a shared correction`, async () => {
        const fixture = await create();
        try {
          const { plan, host, runner, lease } = await investigationRunnerFixture(fixture.store);
          host[flag] = true;
          const result = await runner.run(lease, plan);
          expect(result.state).toBe("split");
          expect(result.split?.reason).toBe(reason);
          expect(result.implementationAtomDigest).toBeNull();
        } finally {
          await fixture.close();
        }
      });
    }
    test("unconfirmed members retain individual adjudication but cannot admit correction", async () => {
      const fixture = await create();
      try {
        const { plan, host, runner, lease } = await investigationRunnerFixture(fixture.store);
        host.uncertain = true;
        const result = await runner.run(lease, plan);
        expect(result.state).toBe("awaiting-evidence");
        expect(result.members.every((member) => member.adjudication?.verdict === "uncertain")).toBe(
          true,
        );
        expect(result.members.every((member) => member.confirmedCause === null)).toBe(true);
      } finally {
        await fixture.close();
      }
    });
    test("persisted worker assertions, reordered members and copied cause receipts fail closed", async () => {
      const fixture = await create();
      try {
        const { plan, runner, lease } = await investigationRunnerFixture(fixture.store);
        const result = await runner.run(lease, plan);
        expect(() =>
          fixture.store.recordInvestigationRun(
            lease,
            "forged",
            result as unknown as AuthorizedInvestigationRunV1,
          ),
        ).toThrow("runner-authenticated");
        const portable = JSON.parse(await fixture.store.exportPortableState());
        const latest = portable.investigationRuns.at(-1);
        latest.members[1].confirmedCause = latest.members[0].confirmedCause;
        const { runDigest: _ignored, ...payload } = latest;
        latest.runDigest = sha256(payload);
        expect(() => parseWorkCohortPortableStateV1(JSON.stringify(portable))).toThrow(
          "copied or substituted",
        );
        const reordered = JSON.parse(await fixture.store.exportPortableState());
        reordered.investigationRuns.at(-1).members.reverse();
        const { runDigest: _old, ...changed } = reordered.investigationRuns.at(-1);
        reordered.investigationRuns.at(-1).runDigest = sha256(changed);
        expect(() => parseWorkCohortPortableStateV1(JSON.stringify(reordered))).toThrow("binding");
      } finally {
        await fixture.close();
      }
    });
    test("changed authoritative input or output cannot authenticate a copied retained result", async () => {
      const fixture = await create();
      try {
        const { plan, host, runner, lease } = await investigationRunnerFixture(fixture.store);
        const result = await runner.run(lease, plan);
        const prepared = result.members[0]!.explorer!;
        const row = host.attestations.read(prepared.handle)!;
        if (row.kind !== "envelope") throw new Error("missing test envelope");
        host.attestations.replace(row, { ...row, input: { defectId: "D99" } });
        expect(() =>
          new InvestigationDispatchAuthenticatorV1(host.attestations).authenticate(prepared),
        ).toThrow("exact consumed");
        const split = await runner.run(lease, plan);
        expect(split.state).toBe("split");
        expect(split.split?.reason).toBe("stale-binding");
      } finally {
        await fixture.close();
      }
    });
  });
}
