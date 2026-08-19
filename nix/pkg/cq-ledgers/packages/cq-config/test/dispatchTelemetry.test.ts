/**
 * T699–T702 / G94 — attestation-keyed telemetry schema and host mappings.
 * Behavioral-Active Blackbox-Atomic.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  TELEMETRY_PHASES,
  TelemetryContractError,
  buildDispatchTelemetry,
  mapHostTelemetryFixture,
  measured,
  type DispatchTelemetryRecord,
  type HostTelemetryFixture,
  type TelemetryPhase,
} from "@cq/config";
import type { DispatchLifecycleOutcomeKind } from "@cq/config";
import type { PromptSurface } from "@cq/config";

const META = JSON.parse(
  readFileSync(path.join(import.meta.dir, "fixtures", "t699", "host-events.json"), "utf8"),
) as {
  readonly labeledResearch: DispatchTelemetryRecord["labeledResearch"];
  readonly hosts: Record<
    PromptSurface,
    {
      readonly source: string;
      readonly storageProvenance: DispatchTelemetryRecord["storageProvenance"];
      readonly roleId: string;
      readonly model: string;
      readonly provider: string;
    }
  >;
  readonly outcomes: readonly DispatchLifecycleOutcomeKind[];
};

const PHASE_UNAVAILABLE: Record<TelemetryPhase, { readonly reason: string; readonly sourceShape: string }> =
  {
    prepareInput: { reason: "prepare envelope carries only digests", sourceShape: "DispatchPrepared.promptProvenance" },
    injectedPrompt: { reason: "child prompt never enters parent telemetry", sourceShape: "host-injected-role" },
    storeResultPayload: { reason: "store arguments remain capability-scoped", sourceShape: "store_result.output" },
    nativeCompletion: { reason: "handle-only native completion has no body bytes", sourceShape: "native-completion" },
    parentConfirmation: { reason: "confirmation is a proof, not a payload", sourceShape: "confirm_dispatch_completion" },
    typedFetch: { reason: "fetch arguments are a handle only", sourceShape: "fetch_dispatch_result" },
    fetchedOutput: { reason: "no authorized fetch on this outcome", sourceShape: "FetchDispatchResult" },
  };

function fixtureFor(
  surface: PromptSurface,
  outcomeKind: DispatchLifecycleOutcomeKind,
): HostTelemetryFixture {
  const host = META.hosts[surface];
  const success = outcomeKind === "success";
  return {
    surface,
    roleId: host.roleId,
    outcomeKind,
    attestationId: `att_T699${surface}${outcomeKind.replace(/-/g, "")}`,
    generation: 1,
    storageProvenance: host.storageProvenance,
    model: host.model,
    provider: host.provider,
    observed: success
      ? {
          prepareInput: {
            value: 196,
            source: host.source,
            field: "prepare.inputDigest-bytes",
            unit: "bytes",
            owner: "parent",
          },
          nativeCompletion: {
            value: 215,
            source: host.source,
            field: "handle-only-completion",
            unit: "bytes",
            owner: surface === "pi" ? "extension" : "bridge",
          },
          fetchedOutput: {
            value: 1131,
            source: host.source,
            field: "fetch_dispatch_result.output",
            unit: "bytes",
            owner: "parent",
          },
          fetchCount: {
            value: 1,
            source: host.source,
            field: "fetchCount",
            unit: "count",
            owner: "parent",
          },
          modelVisibleFullBodyCopyCount: {
            value: 1,
            source: host.source,
            field: "modelVisibleFullBodyCopyCount",
            unit: "count",
            owner: "parent",
          },
        }
      : {
          fetchCount: {
            value: 0,
            source: host.source,
            field: "fetchCount",
            unit: "count",
            owner: "parent",
          },
          modelVisibleFullBodyCopyCount: {
            value: 0,
            source: host.source,
            field: "modelVisibleFullBodyCopyCount",
            unit: "count",
            owner: "parent",
          },
        },
    unavailable: {
      injectedPrompt: PHASE_UNAVAILABLE.injectedPrompt,
      storeResultPayload: PHASE_UNAVAILABLE.storeResultPayload,
      parentConfirmation: PHASE_UNAVAILABLE.parentConfirmation,
      typedFetch: PHASE_UNAVAILABLE.typedFetch,
      latencyMs: {
        reason: "no injected clock on this sanitized fixture",
        sourceShape: host.source,
      },
      providerTokens: {
        reason: "provider usage not exposed on this sanitized fixture",
        sourceShape: host.source,
      },
      cachedInputTokens: {
        reason: "cache fields only when the host exposes them",
        sourceShape: host.source,
      },
      ...(success
        ? {}
        : {
            prepareInput: PHASE_UNAVAILABLE.prepareInput,
            nativeCompletion: PHASE_UNAVAILABLE.nativeCompletion,
            fetchedOutput: PHASE_UNAVAILABLE.fetchedOutput,
          }),
    },
  };
}

describe("T699 attestation-keyed telemetry schema", () => {
  test("measured zero is distinct from unavailable [BA]", () => {
    const record = mapHostTelemetryFixture(fixtureFor("claude", "echo"));
    expect(record.fetchCount).toEqual(
      measured(0, META.hosts.claude.source, "fetchCount", "count", "parent"),
    );
    expect(record.providerTokens.status).toBe("unavailable");
    if (record.providerTokens.status !== "unavailable") throw new Error("unreachable");
    expect(record.providerTokens.reason.length).toBeGreaterThan(0);
    expect(record.providerTokens.sourceShape.length).toBeGreaterThan(0);
  });

  test("rejects negative, double-counted, inferred tokens, and secrets [BA]", () => {
    const base = mapHostTelemetryFixture(fixtureFor("codex", "success"));
    expect(() =>
      buildDispatchTelemetry({
        ...base,
        fetchCount: measured(-1, "t", "fetchCount", "count", "parent"),
      }),
    ).toThrow(TelemetryContractError);
    expect(() =>
      buildDispatchTelemetry({
        ...base,
        modelVisibleFullBodyCopyCount: measured(2, "t", "copies", "count", "parent"),
      }),
    ).toThrow(/double-counted/);
    expect(() =>
      buildDispatchTelemetry({
        ...base,
        providerTokens: measured(12, "inferred-from-bytes", "tokens", "tokens", "provider"),
      }),
    ).toThrow(/inferred from bytes/);
    expect(() =>
      buildDispatchTelemetry({
        ...base,
        attestationId: "cq_result_secret",
      }),
    ).toThrow(TelemetryContractError);
  });

  test("RS4/RS5 labels stay non-aggregate [BA]", () => {
    const mapped = mapHostTelemetryFixture(fixtureFor("codex", "success"));
    const labels = META.labeledResearch;
    expect(labels).toBeDefined();
    if (labels === undefined) throw new Error("labeledResearch fixture missing");
    const record = buildDispatchTelemetry({
      ...mapped,
      labeledResearch: labels,
    });
    expect(record.labeledResearch).toEqual(META.labeledResearch);
    expect(record.labeledResearch?.every((row) => row.aggregateClaim === false)).toBe(true);
  });
});

describe("T700/T701/T702 host mappings", () => {
  for (const surface of ["claude", "codex", "pi"] as const) {
    for (const outcome of META.outcomes) {
      test(`${surface} ${outcome} enumerates every phase as measured or unavailable [BA]`, () => {
        const record = mapHostTelemetryFixture(fixtureFor(surface, outcome));
        expect(record.surface).toBe(surface);
        expect(record.outcomeKind).toBe(outcome);
        expect(record.storageProvenance).toBe(META.hosts[surface].storageProvenance);
        for (const phase of TELEMETRY_PHASES) {
          expect(["measured", "unavailable"]).toContain(record.phases[phase].status);
        }
        if (outcome === "success") {
          expect(record.fetchCount).toMatchObject({ status: "measured", value: 1 });
          expect(record.modelVisibleFullBodyCopyCount).toMatchObject({ status: "measured", value: 1 });
        } else {
          expect(record.fetchCount).toMatchObject({ status: "measured", value: 0 });
          expect(record.modelVisibleFullBodyCopyCount).toMatchObject({ status: "measured", value: 0 });
        }
        const serialized = JSON.stringify(record);
        expect(serialized).not.toMatch(/cq_(?:result|input|git|conflict|parent_gate)_/);
        expect(serialized).not.toContain("promptTemplate");
        expect(serialized).not.toMatch(/"output"\s*:/);
      });
    }
  }
});
