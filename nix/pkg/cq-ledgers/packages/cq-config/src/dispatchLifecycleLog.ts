/**
 * T697 / G94 — redacted ref-first dispatch lifecycle log.
 *
 * One attestation generation folds to exactly one terminal outcome. Capability
 * tokens, prompt/schema bodies, store arguments, and output bodies are rejected
 * at the boundary. Token/latency savings are never inferred from bytes.
 */
import type { DispatchAbortReason } from "./compactDispatchProtocol.js";
import type { DispatchFlowFamily } from "./dispatchEdgeInventory.js";
import type { PromptSurface } from "./promptCatalog.js";

export const DISPATCH_LIFECYCLE_LOG_KIND = "cq-dispatch-lifecycle-log";
export const DISPATCH_LIFECYCLE_LOG_VERSION = 1;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ATTESTATION_ID = /^att_[A-Za-z0-9_-]+$/;
const CAPABILITY_TOKEN = /cq_(?:result|input|git|conflict|parent_gate)_/;

export const DISPATCH_LIFECYCLE_KINDS = [
  "dispatched-role",
  "pi-inline-command-recursion",
] as const;
export type DispatchLifecycleKind = (typeof DISPATCH_LIFECYCLE_KINDS)[number];

export const DISPATCH_LIFECYCLE_OUTCOME_KINDS = [
  "success",
  "invalid-output",
  "echo",
  "cancellation-after-store",
  "native-error",
  "expiry",
  "store-failure",
  "fetch-failure",
  "conflict",
] as const;
export type DispatchLifecycleOutcomeKind = (typeof DISPATCH_LIFECYCLE_OUTCOME_KINDS)[number];

export class LifecycleLogError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "LifecycleLogError";
  }
}

export interface DispatchLifecycleAttribution {
  readonly fetchCount: number;
  readonly fetchBytes: number;
  readonly modelVisibleFullBodyCopyCount: number;
  readonly tokenStatus: "unavailable";
  readonly tokenUnavailableReason: string;
  readonly latencyStatus: "unavailable" | "measured";
  readonly latencyMs?: number;
  readonly latencyUnavailableReason?: string;
  readonly savingsClaim: false;
}

export interface DispatchLifecycleTerminal {
  readonly kind: "consumed" | "aborted" | "recursion";
  readonly outcomeKind: DispatchLifecycleOutcomeKind;
  readonly abortReason?: DispatchAbortReason;
  readonly at: string;
}

export interface DispatchLifecycleLog {
  readonly kind: typeof DISPATCH_LIFECYCLE_LOG_KIND;
  readonly version: typeof DISPATCH_LIFECYCLE_LOG_VERSION;
  readonly lifecycleKind: DispatchLifecycleKind;
  readonly surface: PromptSurface;
  readonly flowFamily: DispatchFlowFamily;
  readonly roleId: string;
  readonly roleVersion?: number;
  readonly sourceRoleId?: string;
  readonly mechanism?: "inline-command-recursion";
  readonly promptDigest?: string;
  readonly catalogHash?: string;
  readonly inputDigest?: string;
  readonly attestationId?: string;
  readonly generation?: number;
  readonly inputCapabilityDigest?: string;
  readonly resultCapabilityDigest?: string;
  readonly nativeChildId?: string;
  readonly nativeRunId?: string;
  readonly nativeModel?: string;
  readonly storedAt?: string;
  readonly confirmedAt?: string;
  readonly outputDigest?: string;
  readonly retryCount: number;
  readonly extraKeyCount?: number;
  readonly outcome: DispatchLifecycleTerminal;
  readonly attribution: DispatchLifecycleAttribution;
}

export type DispatchLifecycleEvent =
  | {
      readonly type: "prepare";
      readonly surface: PromptSurface;
      readonly flowFamily: DispatchFlowFamily;
      readonly lifecycleKind: "dispatched-role";
      readonly roleId: string;
      readonly roleVersion: number;
      readonly promptDigest: string;
      readonly catalogHash: string;
      readonly inputDigest: string;
      readonly attestationId: string;
      readonly generation: number;
      readonly inputCapabilityDigest: string;
      readonly resultCapabilityDigest: string;
      readonly nativeModel?: string;
    }
  | {
      readonly type: "recursion";
      readonly surface: "pi";
      readonly flowFamily: DispatchFlowFamily;
      readonly sourceRoleId: string;
      readonly roleId: string;
      readonly at: string;
      readonly fetchBytes: number;
    }
  | {
      readonly type: "store";
      readonly storedAt: string;
      readonly outputDigest: string;
    }
  | {
      readonly type: "confirm";
      readonly confirmedAt: string;
      readonly nativeChildId: string;
      readonly nativeRunId: string;
    }
  | {
      readonly type: "fetch";
      readonly bytes: number;
    }
  | {
      readonly type: "terminal";
      readonly outcome: "consumed" | "aborted";
      readonly outcomeKind: DispatchLifecycleOutcomeKind;
      readonly abortReason?: DispatchAbortReason;
      readonly at: string;
      readonly extraKeyCount?: number;
    }
  | {
      readonly type: "retry";
    };

const TOKEN_UNAVAILABLE_REASON =
  "no tokenizer was run for this dispatch lifecycle record";
const LATENCY_UNAVAILABLE_REASON =
  "no provider or dispatch timing was measured for this record";

function assertDigest(value: string, path: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new LifecycleLogError(path, "expected a lowercase hex sha-256 digest");
  }
  return value;
}

function assertAttestationId(value: string): string {
  if (!ATTESTATION_ID.test(value) || CAPABILITY_TOKEN.test(value)) {
    throw new LifecycleLogError("attestationId", "expected an attestation id, not a capability");
  }
  return value;
}

function assertNoCapabilityToken(value: string, path: string): void {
  if (CAPABILITY_TOKEN.test(value)) {
    throw new LifecycleLogError(path, "capability token must never enter the log");
  }
}

function sameTerminal(left: DispatchLifecycleTerminal, right: DispatchLifecycleTerminal): boolean {
  return (
    left.kind === right.kind &&
    left.outcomeKind === right.outcomeKind &&
    left.at === right.at &&
    left.abortReason === right.abortReason
  );
}

function attributionOf(input: {
  readonly fetchCount: number;
  readonly fetchBytes: number;
  readonly modelVisibleFullBodyCopyCount: number;
  readonly latencyMs?: number;
}): DispatchLifecycleAttribution {
  if (input.fetchCount < 0 || input.fetchBytes < 0 || input.modelVisibleFullBodyCopyCount < 0) {
    throw new LifecycleLogError("attribution", "counts and bytes cannot be negative");
  }
  if (input.modelVisibleFullBodyCopyCount > 1) {
    throw new LifecycleLogError(
      "attribution.modelVisibleFullBodyCopyCount",
      "a second full-body copy is a duplicate output body",
    );
  }
  if (input.latencyMs !== undefined) {
    if (!Number.isInteger(input.latencyMs) || input.latencyMs < 0) {
      throw new LifecycleLogError("attribution.latencyMs", "expected a non-negative integer");
    }
    return Object.freeze({
      fetchCount: input.fetchCount,
      fetchBytes: input.fetchBytes,
      modelVisibleFullBodyCopyCount: input.modelVisibleFullBodyCopyCount,
      tokenStatus: "unavailable",
      tokenUnavailableReason: TOKEN_UNAVAILABLE_REASON,
      latencyStatus: "measured",
      latencyMs: input.latencyMs,
      savingsClaim: false,
    });
  }
  return Object.freeze({
    fetchCount: input.fetchCount,
    fetchBytes: input.fetchBytes,
    modelVisibleFullBodyCopyCount: input.modelVisibleFullBodyCopyCount,
    tokenStatus: "unavailable",
    tokenUnavailableReason: TOKEN_UNAVAILABLE_REASON,
    latencyStatus: "unavailable",
    latencyUnavailableReason: LATENCY_UNAVAILABLE_REASON,
    savingsClaim: false,
  });
}

/**
 * Walk a finished record and refuse any secret, prompt, schema, token, store
 * argument, or output body that slipped through construction.
 */
export function assertDispatchLifecycleLogSafe(record: DispatchLifecycleLog): void {
  const serialized = JSON.stringify(record);
  if (CAPABILITY_TOKEN.test(serialized)) {
    throw new LifecycleLogError("record", "serialized log contains a capability token");
  }
  if (serialized.includes("promptTemplate") || serialized.includes("inputSchema")) {
    throw new LifecycleLogError("record", "serialized log contains prompt or schema material");
  }
  if (serialized.includes("outputSchema") || /"token"\s*:/.test(serialized)) {
    throw new LifecycleLogError("record", "serialized log contains schema or token material");
  }
  if (/"output"\s*:/.test(serialized)) {
    throw new LifecycleLogError("record", "serialized log contains an output body");
  }
  if (/"(?:result|input)Capability"\s*:/.test(serialized)) {
    throw new LifecycleLogError("record", "serialized log names a capability object");
  }
}

export function foldDispatchLifecycleEvents(
  events: readonly DispatchLifecycleEvent[],
): DispatchLifecycleLog {
  if (events.length === 0) {
    throw new LifecycleLogError("events", "expected at least one lifecycle event");
  }

  let prepare:
    | Extract<DispatchLifecycleEvent, { readonly type: "prepare" }>
    | undefined;
  let recursion:
    | Extract<DispatchLifecycleEvent, { readonly type: "recursion" }>
    | undefined;
  let storedAt: string | undefined;
  let outputDigest: string | undefined;
  let confirmedAt: string | undefined;
  let nativeChildId: string | undefined;
  let nativeRunId: string | undefined;
  let fetchCount = 0;
  let fetchBytes = 0;
  let retryCount = 0;
  let extraKeyCount: number | undefined;
  let terminal: DispatchLifecycleTerminal | undefined;

  for (const [index, event] of events.entries()) {
    const path = `events[${String(index)}]`;
    switch (event.type) {
      case "prepare": {
        if (recursion !== undefined) {
          throw new LifecycleLogError(path, "recursion and dispatched-role events cannot mix");
        }
        if (prepare !== undefined) {
          const same =
            prepare.attestationId === event.attestationId &&
            prepare.generation === event.generation &&
            prepare.inputDigest === event.inputDigest;
          if (!same) {
            throw new LifecycleLogError(path, "prepare identity changed");
          }
          break;
        }
        assertAttestationId(event.attestationId);
        assertDigest(event.promptDigest, `${path}.promptDigest`);
        assertDigest(event.catalogHash, `${path}.catalogHash`);
        assertDigest(event.inputDigest, `${path}.inputDigest`);
        assertDigest(event.inputCapabilityDigest, `${path}.inputCapabilityDigest`);
        assertDigest(event.resultCapabilityDigest, `${path}.resultCapabilityDigest`);
        if (!Number.isInteger(event.generation) || event.generation < 1) {
          throw new LifecycleLogError(`${path}.generation`, "expected a positive integer");
        }
        if (event.nativeModel !== undefined) {
          assertNoCapabilityToken(event.nativeModel, `${path}.nativeModel`);
        }
        prepare = event;
        break;
      }
      case "recursion": {
        if (prepare !== undefined) {
          throw new LifecycleLogError(path, "recursion and dispatched-role events cannot mix");
        }
        if (event.fetchBytes < 0) {
          throw new LifecycleLogError(`${path}.fetchBytes`, "cannot be negative");
        }
        if (recursion !== undefined && recursion.roleId !== event.roleId) {
          throw new LifecycleLogError(path, "recursion target changed");
        }
        recursion = event;
        fetchCount = 1;
        fetchBytes = event.fetchBytes;
        terminal = Object.freeze({
          kind: "recursion",
          outcomeKind: "success",
          at: event.at,
        });
        break;
      }
      case "store": {
        assertDigest(event.outputDigest, `${path}.outputDigest`);
        if (storedAt !== undefined && storedAt !== event.storedAt) {
          throw new LifecycleLogError(path, "store timestamp changed");
        }
        storedAt = event.storedAt;
        outputDigest = event.outputDigest;
        break;
      }
      case "confirm": {
        assertNoCapabilityToken(event.nativeChildId, `${path}.nativeChildId`);
        assertNoCapabilityToken(event.nativeRunId, `${path}.nativeRunId`);
        if (confirmedAt !== undefined && confirmedAt !== event.confirmedAt) {
          throw new LifecycleLogError(path, "confirm identity changed");
        }
        confirmedAt = event.confirmedAt;
        nativeChildId = event.nativeChildId;
        nativeRunId = event.nativeRunId;
        break;
      }
      case "fetch": {
        if (event.bytes < 0) {
          throw new LifecycleLogError(`${path}.bytes`, "cannot be negative");
        }
        fetchCount += 1;
        if (fetchCount > 1) {
          throw new LifecycleLogError(
            path,
            "a second fetch would duplicate the output body",
          );
        }
        fetchBytes += event.bytes;
        break;
      }
      case "retry": {
        retryCount += 1;
        break;
      }
      case "terminal": {
        if (event.outcome === "aborted" && event.abortReason === undefined) {
          throw new LifecycleLogError(`${path}.abortReason`, "an abort requires a typed reason");
        }
        if (event.outcome === "consumed" && event.outcomeKind !== "success") {
          throw new LifecycleLogError(
            `${path}.outcomeKind`,
            "consumed records are success outcomes",
          );
        }
        if (event.extraKeyCount !== undefined) {
          if (!Number.isInteger(event.extraKeyCount) || event.extraKeyCount < 0) {
            throw new LifecycleLogError(`${path}.extraKeyCount`, "expected a non-negative integer");
          }
          extraKeyCount = event.extraKeyCount;
        }
        const next: DispatchLifecycleTerminal = Object.freeze({
          kind: event.outcome,
          outcomeKind: event.outcomeKind,
          ...(event.abortReason === undefined ? {} : { abortReason: event.abortReason }),
          at: event.at,
        });
        if (terminal !== undefined) {
          if (!sameTerminal(terminal, next)) {
            throw new LifecycleLogError(path, "idempotent retry cannot change the terminal outcome");
          }
          break;
        }
        terminal = next;
        break;
      }
    }
  }

  if (terminal === undefined) {
    throw new LifecycleLogError("outcome", "no terminal outcome was recorded");
  }

  if (recursion !== undefined) {
    const record: DispatchLifecycleLog = Object.freeze({
      kind: DISPATCH_LIFECYCLE_LOG_KIND,
      version: DISPATCH_LIFECYCLE_LOG_VERSION,
      lifecycleKind: "pi-inline-command-recursion",
      surface: "pi",
      flowFamily: recursion.flowFamily,
      roleId: recursion.roleId,
      sourceRoleId: recursion.sourceRoleId,
      mechanism: "inline-command-recursion",
      retryCount,
      outcome: terminal,
      attribution: attributionOf({
        fetchCount,
        fetchBytes,
        modelVisibleFullBodyCopyCount: 0,
      }),
    });
    assertDispatchLifecycleLogSafe(record);
    return record;
  }

  if (prepare === undefined) {
    throw new LifecycleLogError("prepare", "dispatched-role logs require a prepare event");
  }

  const consumedBodyVisible = terminal.kind === "consumed" && fetchCount === 1 ? 1 : 0;
  const record: DispatchLifecycleLog = Object.freeze({
    kind: DISPATCH_LIFECYCLE_LOG_KIND,
    version: DISPATCH_LIFECYCLE_LOG_VERSION,
    lifecycleKind: "dispatched-role",
    surface: prepare.surface,
    flowFamily: prepare.flowFamily,
    roleId: prepare.roleId,
    roleVersion: prepare.roleVersion,
    promptDigest: prepare.promptDigest,
    catalogHash: prepare.catalogHash,
    inputDigest: prepare.inputDigest,
    attestationId: prepare.attestationId,
    generation: prepare.generation,
    inputCapabilityDigest: prepare.inputCapabilityDigest,
    resultCapabilityDigest: prepare.resultCapabilityDigest,
    ...(prepare.nativeModel === undefined ? {} : { nativeModel: prepare.nativeModel }),
    ...(nativeChildId === undefined ? {} : { nativeChildId }),
    ...(nativeRunId === undefined ? {} : { nativeRunId }),
    ...(storedAt === undefined ? {} : { storedAt }),
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
    ...(outputDigest === undefined ? {} : { outputDigest }),
    retryCount,
    ...(extraKeyCount === undefined ? {} : { extraKeyCount }),
    outcome: terminal,
    attribution: attributionOf({
      fetchCount,
      fetchBytes,
      modelVisibleFullBodyCopyCount: consumedBodyVisible,
    }),
  });
  assertDispatchLifecycleLogSafe(record);
  return record;
}
