/**
 * T697 / G94 — redacted dispatch lifecycle log.
 * Behavioral-Active Blackbox-Atomic against foldDispatchLifecycleEvents.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  DISPATCH_LIFECYCLE_LOG_KIND,
  DISPATCH_LIFECYCLE_LOG_VERSION,
  LifecycleLogError,
  foldDispatchLifecycleEvents,
  type DispatchLifecycleEvent,
  type DispatchLifecycleLog,
  type DispatchLifecycleOutcomeKind,
} from "@cq/config";
import type { DispatchAbortReason } from "@cq/config";
import type { DispatchFlowFamily } from "@cq/config";
import type { PromptSurface } from "@cq/config";

const FIXTURE = JSON.parse(
  readFileSync(path.join(import.meta.dir, "fixtures", "t697", "lifecycle-cases.json"), "utf8"),
) as {
  readonly success: readonly {
    readonly surface: PromptSurface;
    readonly flowFamily: DispatchFlowFamily;
    readonly roleId: string;
  }[];
  readonly outcomes: readonly {
    readonly name: string;
    readonly outcomeKind: DispatchLifecycleOutcomeKind;
    readonly outcome: "consumed" | "aborted";
    readonly abortReason?: DispatchAbortReason;
    readonly extraKeyCount?: number;
    readonly store?: boolean;
    readonly confirm?: boolean;
    readonly fetch?: boolean;
    readonly retry?: boolean;
  }[];
  readonly recursion: readonly {
    readonly sourceRoleId: string;
    readonly roleId: string;
    readonly flowFamily: DispatchFlowFamily;
  }[];
};

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function prepare(input: {
  readonly surface: PromptSurface;
  readonly flowFamily: DispatchFlowFamily;
  readonly roleId: string;
}): Extract<DispatchLifecycleEvent, { readonly type: "prepare" }> {
  return {
    type: "prepare",
    surface: input.surface,
    flowFamily: input.flowFamily,
    lifecycleKind: "dispatched-role",
    roleId: input.roleId,
    roleVersion: 1,
    promptDigest: digest(`prompt:${input.surface}:${input.roleId}`),
    catalogHash: digest("catalog"),
    inputDigest: digest(`input:${input.roleId}`),
    attestationId: "att_T697fixture",
    generation: 1,
    inputCapabilityDigest: digest(`input-cap:${input.roleId}`),
    resultCapabilityDigest: digest(`result-cap:${input.roleId}`),
    nativeModel: `${input.surface}:fixture-model`,
  };
}

function successEvents(input: {
  readonly surface: PromptSurface;
  readonly flowFamily: DispatchFlowFamily;
  readonly roleId: string;
}): DispatchLifecycleEvent[] {
  return [
    prepare(input),
    { type: "store", storedAt: "2026-08-19T18:00:00.000Z", outputDigest: digest(`out:${input.roleId}`) },
    {
      type: "confirm",
      confirmedAt: "2026-08-19T18:00:01.000Z",
      nativeChildId: `child-${input.roleId}`,
      nativeRunId: `run-${input.surface}`,
    },
    { type: "fetch", bytes: 128 },
    {
      type: "terminal",
      outcome: "consumed",
      outcomeKind: "success",
      at: "2026-08-19T18:00:02.000Z",
    },
  ];
}

function assertRedacted(record: DispatchLifecycleLog): void {
  const serialized = JSON.stringify(record);
  expect(serialized).not.toMatch(/cq_(?:result|input|git|conflict|parent_gate)_/);
  expect(serialized).not.toContain("promptTemplate");
  expect(serialized).not.toContain("inputSchema");
  expect(serialized).not.toContain("outputSchema");
  expect(serialized).not.toMatch(/"token"\s*:/);
  expect(serialized).not.toMatch(/"output"\s*:/);
  expect(serialized).not.toMatch(/"(?:result|input)Capability"\s*:/);
  expect(record.attribution.savingsClaim).toBe(false);
  expect(record.attribution.tokenStatus).toBe("unavailable");
  expect(record.attribution.modelVisibleFullBodyCopyCount).toBeLessThanOrEqual(1);
}

describe("T697 dispatch lifecycle log", () => {
  test("success fixtures cover every flow family and surface [BA]", () => {
    const keys = FIXTURE.success.map((row) => `${row.surface}:${row.flowFamily}`);
    for (const surface of ["claude", "codex", "pi"] as const) {
      for (const family of ["plan-review", "investigate-research", "implement"] as const) {
        expect(keys).toContain(`${surface}:${family}`);
      }
    }
    const records = FIXTURE.success.map((row) => foldDispatchLifecycleEvents(successEvents(row)));
    for (const record of records) {
      expect(record.kind).toBe(DISPATCH_LIFECYCLE_LOG_KIND);
      expect(record.version).toBe(DISPATCH_LIFECYCLE_LOG_VERSION);
      expect(record.lifecycleKind).toBe("dispatched-role");
      expect(record.outcome).toEqual({
        kind: "consumed",
        outcomeKind: "success",
        at: "2026-08-19T18:00:02.000Z",
      });
      expect(record.attribution.fetchCount).toBe(1);
      expect(record.attribution.fetchBytes).toBe(128);
      expect(record.attribution.modelVisibleFullBodyCopyCount).toBe(1);
      expect(record.attribution.latencyStatus).toBe("unavailable");
      assertRedacted(record);
    }
    expect(JSON.stringify(records)).toBe(JSON.stringify(FIXTURE.success.map((row) => foldDispatchLifecycleEvents(successEvents(row)))));
  });

  test("special-outcome fixtures are deterministic and redacted [BA]", () => {
    const base = { surface: "codex" as const, flowFamily: "implement" as const, roleId: "implement-worker" };
    for (const outcome of FIXTURE.outcomes) {
      const events: DispatchLifecycleEvent[] = [prepare(base)];
      if (outcome.store === true || outcome.outcome === "consumed") {
        events.push({
          type: "store",
          storedAt: "2026-08-19T18:01:00.000Z",
          outputDigest: digest(`out:${outcome.name}`),
        });
      }
      if (outcome.confirm === true) {
        events.push({
          type: "confirm",
          confirmedAt: "2026-08-19T18:01:01.000Z",
          nativeChildId: "child-special",
          nativeRunId: "run-special",
        });
      }
      if (outcome.fetch === true) {
        events.push({ type: "fetch", bytes: 64 });
      }
      if (outcome.retry === true) {
        events.push({ type: "retry" });
      }
      events.push({
        type: "terminal",
        outcome: outcome.outcome,
        outcomeKind: outcome.outcomeKind,
        ...(outcome.abortReason === undefined ? {} : { abortReason: outcome.abortReason }),
        at: "2026-08-19T18:01:02.000Z",
        ...(outcome.extraKeyCount === undefined ? {} : { extraKeyCount: outcome.extraKeyCount }),
      });
      const record = foldDispatchLifecycleEvents(events);
      expect(record.outcome.outcomeKind).toBe(outcome.outcomeKind);
      expect(record.outcome.kind).toBe(outcome.outcome);
      if (outcome.retry === true) {
        expect(record.retryCount).toBe(1);
      }
      if (outcome.name === "echo") {
        expect(record.extraKeyCount).toBe(1);
      }
      if (outcome.name === "cancellation-after-store") {
        expect(record.storedAt).toBe("2026-08-19T18:01:00.000Z");
      }
      assertRedacted(record);
      expect(JSON.stringify(record)).toBe(JSON.stringify(foldDispatchLifecycleEvents(events)));
    }
  });

  test("idempotent terminals do not create a second outcome [BA]", () => {
    const events = successEvents({
      surface: "claude",
      flowFamily: "plan-review",
      roleId: "plan-advance",
    });
    const once = foldDispatchLifecycleEvents(events);
    const twice = foldDispatchLifecycleEvents([
      ...events,
      {
        type: "terminal",
        outcome: "consumed",
        outcomeKind: "success",
        at: "2026-08-19T18:00:02.000Z",
      },
    ]);
    expect(twice).toEqual(once);
    expect(() =>
      foldDispatchLifecycleEvents([
        ...events,
        {
          type: "terminal",
          outcome: "aborted",
          outcomeKind: "conflict",
          abortReason: "protocol-violation",
          at: "2026-08-19T18:00:03.000Z",
        },
      ]),
    ).toThrow(LifecycleLogError);
  });

  test("Pi command recursion is classified separately [BA]", () => {
    for (const row of FIXTURE.recursion) {
      const record = foldDispatchLifecycleEvents([
        {
          type: "recursion",
          surface: "pi",
          flowFamily: row.flowFamily,
          sourceRoleId: row.sourceRoleId,
          roleId: row.roleId,
          at: "2026-08-19T18:02:00.000Z",
          fetchBytes: 256,
        },
      ]);
      expect(record.lifecycleKind).toBe("pi-inline-command-recursion");
      expect(record.mechanism).toBe("inline-command-recursion");
      expect(record.surface).toBe("pi");
      expect(record.sourceRoleId).toBe(row.sourceRoleId);
      expect(record.attestationId).toBeUndefined();
      expect(record.inputCapabilityDigest).toBeUndefined();
      expect(record.outcome.kind).toBe("recursion");
      expect(record.attribution.modelVisibleFullBodyCopyCount).toBe(0);
      assertRedacted(record);
    }
  });

  test("capability tokens, prompt bodies, and a second fetch fail closed [BA]", () => {
    const base = prepare({
      surface: "pi",
      flowFamily: "plan-review",
      roleId: "plan-advance",
    });
    expect(() =>
      foldDispatchLifecycleEvents([
        { ...base, inputCapabilityDigest: "cq_input_not-a-digest" },
      ]),
    ).toThrow(/lowercase hex sha-256/);
    expect(() =>
      foldDispatchLifecycleEvents([
        { ...base, attestationId: "cq_result_secret" },
      ]),
    ).toThrow(LifecycleLogError);
    expect(() =>
      foldDispatchLifecycleEvents([
        base,
        { type: "fetch", bytes: 10 },
        { type: "fetch", bytes: 10 },
        {
          type: "terminal",
          outcome: "consumed",
          outcomeKind: "success",
          at: "2026-08-19T18:00:02.000Z",
        },
      ]),
    ).toThrow(/second fetch/);
  });
});
