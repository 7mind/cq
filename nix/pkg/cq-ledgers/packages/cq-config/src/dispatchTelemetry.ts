/**
 * T699 / G94 — attestation-keyed telemetry over the shared ref-first lifecycle.
 *
 * Measured zero is not unavailable. Provider tokens are never inferred from
 * bytes. Capability secrets, prompt/schema bodies, and store arguments stay
 * out of the record. RS4/RS5 labels stay separate from production totals.
 */
import type { DispatchLifecycleOutcomeKind } from "./dispatchLifecycleLog.js";
import type { PromptSurface } from "./promptCatalog.js";

export const DISPATCH_TELEMETRY_KIND = "cq-dispatch-telemetry";
export const DISPATCH_TELEMETRY_VERSION = 1;

const CAPABILITY_TOKEN = /cq_(?:result|input|git|conflict|parent_gate)_/;
const INFERRED_TOKEN_SOURCES = new Set(["inferred-from-bytes", "bytes-as-tokens"]);

export const TELEMETRY_PHASES = [
  "prepareInput",
  "injectedPrompt",
  "storeResultPayload",
  "nativeCompletion",
  "parentConfirmation",
  "typedFetch",
  "fetchedOutput",
] as const;
export type TelemetryPhase = (typeof TELEMETRY_PHASES)[number];

export const TELEMETRY_UNITS = ["bytes", "tokens", "count", "ms"] as const;
export type TelemetryUnit = (typeof TELEMETRY_UNITS)[number];

export const TELEMETRY_OWNERS = ["parent", "child", "extension", "provider", "bridge"] as const;
export type TelemetryOwner = (typeof TELEMETRY_OWNERS)[number];

export class TelemetryContractError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "TelemetryContractError";
  }
}

export interface MeasuredQuantity {
  readonly status: "measured";
  readonly value: number;
  readonly source: string;
  readonly field: string;
  readonly unit: TelemetryUnit;
  readonly owner: TelemetryOwner;
}

export interface UnavailableQuantity {
  readonly status: "unavailable";
  readonly reason: string;
  readonly sourceShape: string;
}

export type TelemetryQuantity = MeasuredQuantity | UnavailableQuantity;

export interface LabeledResearchMeasurement {
  readonly researchId: "RS4" | "RS5";
  readonly sampleSize: number;
  readonly label: string;
  readonly aggregateClaim: false;
  readonly crossHarnessClaim: false;
}

export interface DispatchTelemetryRecord {
  readonly kind: typeof DISPATCH_TELEMETRY_KIND;
  readonly version: typeof DISPATCH_TELEMETRY_VERSION;
  readonly attestationId: string;
  readonly generation: number;
  readonly surface: PromptSurface;
  readonly roleId: string;
  readonly storageProvenance: "attestation-store" | "pi-extension-local";
  readonly outcomeKind: DispatchLifecycleOutcomeKind;
  readonly phases: { readonly [K in TelemetryPhase]: TelemetryQuantity };
  readonly fetchCount: TelemetryQuantity;
  readonly modelVisibleFullBodyCopyCount: TelemetryQuantity;
  readonly latencyMs: TelemetryQuantity;
  readonly providerTokens: TelemetryQuantity;
  readonly cachedInputTokens?: TelemetryQuantity;
  readonly model?: string;
  readonly provider?: string;
  readonly labeledResearch?: readonly LabeledResearchMeasurement[];
}

function assertQuantity(quantity: TelemetryQuantity, path: string, unit: TelemetryUnit): void {
  if (quantity.status === "unavailable") {
    if (quantity.reason.trim() === "" || quantity.sourceShape.trim() === "") {
      throw new TelemetryContractError(path, "unavailable requires reason and sourceShape");
    }
    if (CAPABILITY_TOKEN.test(quantity.reason) || CAPABILITY_TOKEN.test(quantity.sourceShape)) {
      throw new TelemetryContractError(path, "capability token must never enter telemetry");
    }
    return;
  }
  if (!Number.isFinite(quantity.value) || quantity.value < 0) {
    throw new TelemetryContractError(path, "measured values cannot be negative or non-finite");
  }
  if (quantity.unit !== unit) {
    throw new TelemetryContractError(path, `expected unit ${unit}`);
  }
  if (quantity.source.trim() === "" || quantity.field.trim() === "") {
    throw new TelemetryContractError(path, "measured quantities require source and field");
  }
  if (unit === "tokens" && INFERRED_TOKEN_SOURCES.has(quantity.source)) {
    throw new TelemetryContractError(path, "provider tokens cannot be inferred from bytes");
  }
  if (CAPABILITY_TOKEN.test(quantity.source) || CAPABILITY_TOKEN.test(quantity.field)) {
    throw new TelemetryContractError(path, "capability token must never enter telemetry");
  }
}

function measuredCount(quantity: TelemetryQuantity): number | undefined {
  return quantity.status === "measured" ? quantity.value : undefined;
}

export function buildDispatchTelemetry(input: DispatchTelemetryRecord): DispatchTelemetryRecord {
  if (input.kind !== DISPATCH_TELEMETRY_KIND || input.version !== DISPATCH_TELEMETRY_VERSION) {
    throw new TelemetryContractError("kind", "expected cq-dispatch-telemetry v1");
  }
  if (!input.attestationId.startsWith("att_") || CAPABILITY_TOKEN.test(input.attestationId)) {
    throw new TelemetryContractError("attestationId", "expected an attestation id");
  }
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    throw new TelemetryContractError("generation", "expected a positive integer");
  }
  if (input.surface === "pi") {
    if (input.storageProvenance !== "pi-extension-local") {
      throw new TelemetryContractError("storageProvenance", "Pi telemetry is extension-local");
    }
  } else if (input.storageProvenance !== "attestation-store") {
    throw new TelemetryContractError("storageProvenance", "Claude/Codex telemetry uses the attestation store");
  }

  for (const phase of TELEMETRY_PHASES) {
    assertQuantity(input.phases[phase], `phases.${phase}`, "bytes");
  }
  assertQuantity(input.fetchCount, "fetchCount", "count");
  assertQuantity(input.modelVisibleFullBodyCopyCount, "modelVisibleFullBodyCopyCount", "count");
  assertQuantity(input.latencyMs, "latencyMs", "ms");
  assertQuantity(input.providerTokens, "providerTokens", "tokens");
  if (input.cachedInputTokens !== undefined) {
    assertQuantity(input.cachedInputTokens, "cachedInputTokens", "tokens");
  }

  const copies = measuredCount(input.modelVisibleFullBodyCopyCount);
  const fetches = measuredCount(input.fetchCount);
  if (copies !== undefined && copies > 1) {
    throw new TelemetryContractError(
      "modelVisibleFullBodyCopyCount",
      "a second full-body copy is double-counted",
    );
  }
  if (copies === 1 && fetches === 0) {
    throw new TelemetryContractError(
      "modelVisibleFullBodyCopyCount",
      "a body copy without a fetch is impossible",
    );
  }
  if (fetches !== undefined && copies !== undefined && copies > fetches) {
    throw new TelemetryContractError(
      "modelVisibleFullBodyCopyCount",
      "body copies cannot exceed fetch count",
    );
  }

  if (input.labeledResearch !== undefined) {
    for (const [index, label] of input.labeledResearch.entries()) {
      if (label.sampleSize < 1 || label.aggregateClaim !== false || label.crossHarnessClaim !== false) {
        throw new TelemetryContractError(
          `labeledResearch[${String(index)}]`,
          "research labels stay non-aggregate and require a sample",
        );
      }
    }
  }

  const serialized = JSON.stringify(input);
  if (CAPABILITY_TOKEN.test(serialized) || /"token"\s*:/.test(serialized)) {
    throw new TelemetryContractError("record", "serialized telemetry contains a capability secret");
  }
  if (serialized.includes("promptTemplate") || /"output"\s*:/.test(serialized)) {
    throw new TelemetryContractError("record", "serialized telemetry contains prompt or output body");
  }

  return Object.freeze({
    ...input,
    phases: Object.freeze({ ...input.phases }),
    ...(input.labeledResearch === undefined
      ? {}
      : { labeledResearch: Object.freeze([...input.labeledResearch]) }),
  });
}

export function unavailable(reason: string, sourceShape: string): UnavailableQuantity {
  return Object.freeze({ status: "unavailable", reason, sourceShape });
}

export function measured(
  value: number,
  source: string,
  field: string,
  unit: TelemetryUnit,
  owner: TelemetryOwner,
): MeasuredQuantity {
  return Object.freeze({ status: "measured", value, source, field, unit, owner });
}

export interface HostTelemetryFixture {
  readonly surface: PromptSurface;
  readonly roleId: string;
  readonly outcomeKind: DispatchLifecycleOutcomeKind;
  readonly attestationId: string;
  readonly generation: number;
  readonly storageProvenance: DispatchTelemetryRecord["storageProvenance"];
  readonly observed: {
    readonly [K in TelemetryPhase | "fetchCount" | "modelVisibleFullBodyCopyCount" | "latencyMs" | "providerTokens" | "cachedInputTokens"]?: {
      readonly value: number;
      readonly source: string;
      readonly field: string;
      readonly unit: TelemetryUnit;
      readonly owner: TelemetryOwner;
    };
  };
  readonly unavailable: {
    readonly [K in TelemetryPhase | "fetchCount" | "modelVisibleFullBodyCopyCount" | "latencyMs" | "providerTokens" | "cachedInputTokens"]?: {
      readonly reason: string;
      readonly sourceShape: string;
    };
  };
  readonly model?: string;
  readonly provider?: string;
}

function quantityOf(
  fixture: HostTelemetryFixture,
  key: keyof HostTelemetryFixture["observed"],
  unit: TelemetryUnit,
): TelemetryQuantity {
  const observed = fixture.observed[key];
  if (observed !== undefined) {
    return measured(observed.value, observed.source, observed.field, unit, observed.owner);
  }
  const missing = fixture.unavailable[key];
  if (missing === undefined) {
    throw new TelemetryContractError(String(key), "fixture must mark the field measured or unavailable");
  }
  return unavailable(missing.reason, missing.sourceShape);
}

export function mapHostTelemetryFixture(fixture: HostTelemetryFixture): DispatchTelemetryRecord {
  const phases = Object.fromEntries(
    TELEMETRY_PHASES.map((phase) => [phase, quantityOf(fixture, phase, "bytes")]),
  ) as DispatchTelemetryRecord["phases"];
  return buildDispatchTelemetry({
    kind: DISPATCH_TELEMETRY_KIND,
    version: DISPATCH_TELEMETRY_VERSION,
    attestationId: fixture.attestationId,
    generation: fixture.generation,
    surface: fixture.surface,
    roleId: fixture.roleId,
    storageProvenance: fixture.storageProvenance,
    outcomeKind: fixture.outcomeKind,
    phases,
    fetchCount: quantityOf(fixture, "fetchCount", "count"),
    modelVisibleFullBodyCopyCount: quantityOf(fixture, "modelVisibleFullBodyCopyCount", "count"),
    latencyMs: quantityOf(fixture, "latencyMs", "ms"),
    providerTokens: quantityOf(fixture, "providerTokens", "tokens"),
    ...(fixture.observed.cachedInputTokens !== undefined || fixture.unavailable.cachedInputTokens !== undefined
      ? { cachedInputTokens: quantityOf(fixture, "cachedInputTokens", "tokens") }
      : {}),
    ...(fixture.model === undefined ? {} : { model: fixture.model }),
    ...(fixture.provider === undefined ? {} : { provider: fixture.provider }),
  });
}
