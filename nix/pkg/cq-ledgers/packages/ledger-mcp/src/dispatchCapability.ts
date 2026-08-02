import {
  DISPATCH_INPUT_VALIDATION_DEFERRED,
  DISPATCH_OVERLAY_REGISTRY,
  DISPATCH_REF_ASSEMBLY_DEFERRED,
  DISPATCH_TIMEOUT_MAX_MS,
  DISPATCH_TIMEOUT_MIN_MS,
  IDEMPOTENCY_HORIZON_MS,
  AttestationKeyReuseError,
  AttestationBackendUnsupportedError,
  DispatchStateConflictError,
  abortDispatchOn,
  assembleDispatchInput,
  attestationInstantMs,
  confirmDispatchCompletionOn,
  defaultDispatchRandomBytes,
  dispatchPayloadDigest,
  dispatchPreLaunchRejection,
  fetchDispatchInputOn,
  fetchDispatchResultOn,
  isAttestationTombstone,
  loadConfig,
  prepareDispatchOn,
  prepareDispatchRequestDigest,
  storeDispatchResultOn,
  validateDispatchInput,
  type AttestationBackend,
  type DispatchNarrativeSource,
  type DispatchPrepareAccepted,
  type DispatchPreLaunchRejection,
  type PrepareDispatchOutcome,
} from "@cq/config";
import type { SQL } from "bun";
import {
  assertAttestationConstructionSupported,
  attestationNamespaceForTrustedHubProject,
  createAttestationStoreForConstruction,
  createDispatchNarrativeSource,
  resolveSingleProjectAttestationNamespace,
  type DispatchCapability,
  type LedgerStore,
  type LedgerServerConstruction,
  type ResolvedLedgerStore,
  type SingleProjectConstruction,
} from "@cq/ledger";
import type { PromptArtifactStore } from "./promptArtifactStore.js";

export interface DispatchCapabilityOptions {
  readonly backend: AttestationBackend;
  readonly promptArtifactStore: PromptArtifactStore;
  readonly narrativeSource?: DispatchNarrativeSource;
  readonly now?: () => string;
  readonly randomBytes?: (count: number) => Uint8Array;
}

/**
 * Every contract-level T976/T978 runtime handoff, mapped to the T977 path that
 * discharges it. Tests require exact key coverage so a handoff cannot disappear
 * merely because its source constant retains the historical name `DEFERRED`.
 */
export const DISPATCH_RUNTIME_DEFERRAL_DISCHARGE: ReadonlyMap<string, string> = new Map([
  [
    "live-prepare-dispatch-enforcement-path",
    "createDispatchCapability.prepare validates inline input or assembles refs before prepareDispatchOn",
  ],
  [
    "no-attestation-allocated-on-rejection-against-a-real-store",
    "typed prepare rejection returns before prepareDispatchOn; runtime and construction tests assert zero mutation",
  ],
  [
    "per-surface-claude-codex-pi-conformance",
    "dispatchCapability.test exercises the same prepare/fetch contract on claude, codex and pi",
  ],
  [
    "one-shot-child-retrieval-of-the-assembled-input-by-handle",
    "fetch_dispatch_input routes handle plus distinct input capability to fetchDispatchInputOn",
  ],
  [
    "stolen-or-foreign-capability-rejection",
    "fetchDispatchInput matches the handle-bound input-capability hash inside the namespace transaction",
  ],
  [
    "second-retrieval-failure",
    "inputMaterializedAt is compare-and-set durably and a repeated fetch throws DispatchStateConflictError",
  ],
  [
    "recorded-end-to-end-dispatch-showing-narrative-absent-from-parent-context",
    "dispatchCapability.test seeds a real ledger sentinel, passes refs only, and observes narrative only in child fetch",
  ],
]);

const DISPATCH_RUNTIME_HANDOFFS = [
  ...DISPATCH_INPUT_VALIDATION_DEFERRED,
  ...DISPATCH_REF_ASSEMBLY_DEFERRED,
].sort();
if (
  [...DISPATCH_RUNTIME_DEFERRAL_DISCHARGE.keys()].sort().join(",") !==
  DISPATCH_RUNTIME_HANDOFFS.join(",")
) {
  throw new Error("dispatch runtime deferral discharge does not cover the T976/T978 handoffs");
}

export function createDispatchCapability(options: DispatchCapabilityOptions): DispatchCapability {
  const now = options.now ?? (() => new Date().toISOString());
  const randomBytes = options.randomBytes ?? defaultDispatchRandomBytes;
  const namespace = options.backend.namespace;
  interface CachedPrepare {
    readonly fingerprint: string;
    readonly promise: Promise<DispatchPrepareAccepted>;
    reuseAfterMs?: number;
  }
  const prepares = new Map<string, CachedPrepare>();
  const preparesByHandle = new Map<string, CachedPrepare>();

  function cacheHandleKey(handle: {
    readonly attestationId: string;
    readonly generation: number;
  }): string {
    return `${handle.attestationId}#${handle.generation}`;
  }

  function rememberTerminal(
    handle: { readonly attestationId: string; readonly generation: number },
    terminalAt: string,
  ): void {
    const cached = preparesByHandle.get(cacheHandleKey(handle));
    if (cached !== undefined) {
      cached.reuseAfterMs =
        attestationInstantMs(terminalAt, "terminalAt") + IDEMPOTENCY_HORIZON_MS;
    }
  }

  async function cachedPrepareRemainsHeld(
    idempotencyKey: string,
    cachedRequestDigest: string,
    accepted: DispatchPrepareAccepted,
    cached: CachedPrepare,
  ): Promise<boolean> {
    const atMs = attestationInstantMs(now(), "now");
    return await options.backend.transact(
      { kind: "handle", handle: accepted.handle },
      (store) => {
        const row = store.read(accepted.handle);
        if (row === undefined) {
          if (cached.reuseAfterMs !== undefined && atMs >= cached.reuseAfterMs) {
            return false;
          }
          throw new DispatchStateConflictError(
            "prepare_dispatch",
            "prepared",
            `cached prepare replay for "${idempotencyKey}" lost its durable row before its reuse horizon`,
          );
        }
        if (isAttestationTombstone(row)) {
          const reuseAfterMs = attestationInstantMs(row.reuseAfter, "reuseAfter");
          cached.reuseAfterMs = reuseAfterMs;
          if (atMs >= reuseAfterMs) {
            return false;
          }
          throw new DispatchStateConflictError(
            "prepare_dispatch",
            "terminal-envelope-expired",
            `cached prepare replay for "${idempotencyKey}" no longer matches its durable row`,
          );
        }
        if (row.terminalAt !== undefined) {
          const reuseAfterMs =
            attestationInstantMs(row.terminalAt, "terminalAt") + IDEMPOTENCY_HORIZON_MS;
          cached.reuseAfterMs = reuseAfterMs;
          if (atMs >= reuseAfterMs) {
            return false;
          }
        }
        if (
          row.idempotencyKey !== idempotencyKey ||
          row.promptProvenance.inputDigest !== accepted.prepared.promptProvenance.inputDigest ||
          row.prepareRequestDigest !== cachedRequestDigest
        ) {
          throw new DispatchStateConflictError(
            "prepare_dispatch",
            row.state,
            `cached prepare replay for "${idempotencyKey}" no longer matches its durable row`,
          );
        }
        return true;
      },
    );
  }

  function rejectLaunch(path: string, detail: string): DispatchPreLaunchRejection {
    return dispatchPreLaunchRejection("invalid-launch-envelope", path, detail);
  }

  return {
    prepare: async (input) => {
      if (
        typeof input.idempotencyKey !== "string" ||
        input.idempotencyKey.trim() === "" ||
        input.idempotencyKey.length > 256
      ) {
        return rejectLaunch(
          "idempotencyKey",
          "expected a non-empty idempotency key of at most 256 characters",
        );
      }
      if (
        !Number.isInteger(input.timeoutMs) ||
        input.timeoutMs < DISPATCH_TIMEOUT_MIN_MS ||
        input.timeoutMs > DISPATCH_TIMEOUT_MAX_MS
      ) {
        return rejectLaunch(
          "timeoutMs",
          `expected an integer timeout within [${DISPATCH_TIMEOUT_MIN_MS}, ${DISPATCH_TIMEOUT_MAX_MS}] ms`,
        );
      }
      let roleId: string;
      let dispatchInput: Parameters<typeof dispatchPayloadDigest>[0];
      let requestedSurface: string | undefined;
      if (input.refs !== undefined) {
        if (input.roleId !== undefined || input.input !== undefined) {
          return rejectLaunch(
            "refs",
            "refs-only prepare must not also carry roleId or inline input",
          );
        }
        if (options.narrativeSource === undefined) {
          return dispatchPreLaunchRejection(
            "unresolvable-ref",
            "refs",
            "this dispatch runtime has no project-bound narrative source",
          );
        }
        const assembly = assembleDispatchInput(input.refs, {
          source: options.narrativeSource,
          registry: DISPATCH_OVERLAY_REGISTRY,
          ...(input.overlays === undefined ? {} : { overlays: input.overlays }),
        });
        if (!assembly.accepted) {
          return assembly;
        }
        roleId = assembly.roleId;
        dispatchInput = assembly.input;
        requestedSurface = assembly.surface;
      } else {
        if (input.roleId === undefined || input.input === undefined) {
          return rejectLaunch(
            input.roleId === undefined ? "roleId" : "input",
            "prepare requires either refs or both roleId and structured input",
          );
        }
        roleId = input.roleId;
        dispatchInput = input.input;
      }

      const manifest = options.promptArtifactStore.readManifest();
      const manifestSurface = manifest.promptSurface;
      if (manifestSurface === undefined) {
        throw new Error("prepare_dispatch requires an attested prompt surface");
      }
      if (requestedSurface !== undefined && requestedSurface !== manifestSurface) {
        return rejectLaunch(
          "refs.surface",
          `requested prompt surface "${requestedSurface}" does not match attested manifest surface "${manifestSurface}"`,
        );
      }
      if (input.refs === undefined) {
        const validation = validateDispatchInput({
          roleId,
          input: dispatchInput,
          surface: manifestSurface,
          ...(input.overlays === undefined ? {} : { overlays: input.overlays }),
          registry: DISPATCH_OVERLAY_REGISTRY,
        });
        if (!validation.accepted) {
          return validation;
        }
      }

      // Resolve the catalog artifact only after the role/input/overlay boundary
      // has produced a typed acceptance. Unknown roles therefore never escape
      // as artifact lookup errors.
      const artifact = options.promptArtifactStore.readRole(roleId);
      const promptDigest = artifact.metadata.promptDigest;
      const catalogHash = manifest.catalogHash;
      const artifactSurface = artifact.metadata.promptSurface;
      if (
        artifact.metadata.roleKind !== "dispatched-subagent" ||
        promptDigest === undefined ||
        catalogHash === undefined ||
        artifactSurface === undefined
      ) {
        throw new Error(
          `prepare_dispatch requires an attested dispatched-role artifact for "${roleId}"`,
        );
      }
      if (artifactSurface !== manifestSurface) {
        return rejectLaunch(
          `roles.${roleId}.promptSurface`,
          `role-artifact surface "${artifactSurface}" does not match attested manifest surface "${manifestSurface}"`,
        );
      }
      const request = {
          namespace,
          roleId,
          surface: manifestSurface,
          input: dispatchInput,
          idempotencyKey: input.idempotencyKey,
          timeoutMs: input.timeoutMs,
          ...(input.overlays === undefined ? {} : { overlays: input.overlays }),
          registry: DISPATCH_OVERLAY_REGISTRY,
          promptDigest,
          catalogHash,
          expectedChild: input.expectedChild,
          ...(input.reprepareOf === undefined ? {} : { reprepareOf: input.reprepareOf }),
      } as const;
      const fingerprint = prepareDispatchRequestDigest(request);
      while (true) {
        const existing = prepares.get(input.idempotencyKey);
        if (existing !== undefined) {
          const accepted = await existing.promise;
          if (
            await cachedPrepareRemainsHeld(
              input.idempotencyKey,
              existing.fingerprint,
              accepted,
              existing,
            )
          ) {
            if (existing.fingerprint !== fingerprint) {
              throw new AttestationKeyReuseError(input.idempotencyKey, accepted.handle);
            }
            return accepted;
          }
          if (prepares.get(input.idempotencyKey) === existing) {
            prepares.delete(input.idempotencyKey);
            preparesByHandle.delete(cacheHandleKey(accepted.handle));
          }
          continue;
        }
        const pending = prepareDispatchOn(options.backend, request, {
          now,
          randomBytes,
        }).then((outcome: PrepareDispatchOutcome) => {
          if (!outcome.accepted) {
            throw new Error("validated prepare unexpectedly returned a pre-launch rejection");
          }
          return outcome;
        });
        const entry: CachedPrepare = { fingerprint, promise: pending };
        prepares.set(input.idempotencyKey, entry);
        try {
          const accepted = await pending;
          preparesByHandle.set(cacheHandleKey(accepted.handle), entry);
          return accepted;
        } catch (error) {
          if (prepares.get(input.idempotencyKey) === entry) {
            prepares.delete(input.idempotencyKey);
          }
          throw error;
        }
      }
    },
    fetchInput: (input) =>
      fetchDispatchInputOn(options.backend, { namespace, ...input }, { now }),
    storeResult: async (input) => {
      const outcome = await storeDispatchResultOn(options.backend, input, { now });
      if (outcome.state === "aborted") {
        rememberTerminal(outcome.result, outcome.result.abortedAt);
      }
      return outcome;
    },
    confirmCompletion: async (input) => {
      const outcome = await confirmDispatchCompletionOn(
        options.backend,
        { namespace, ...input },
        { now },
      );
      rememberTerminal(
        outcome.result,
        outcome.state === "consumed" ? outcome.result.consumedAt : outcome.result.abortedAt,
      );
      return outcome;
    },
    abort: async (input) => {
      const result = await abortDispatchOn(
        options.backend,
        { namespace, actor: "trusted-parent", ...input },
        { now },
      );
      rememberTerminal(result, result.abortedAt);
      return result;
    },
    fetch: (input) =>
      fetchDispatchResultOn(
        options.backend,
        { namespace, actor: "trusted-parent", ...input },
        { now },
      ),
  };
}

export type DispatchRuntime =
  | {
      readonly kind: "available";
      readonly capability: DispatchCapability;
      close(): Promise<void>;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      close(): Promise<void>;
    };

function unavailable(reason: string): DispatchRuntime {
  return Object.freeze({
    kind: "unavailable" as const,
    reason,
    close: async (): Promise<void> => {},
  });
}

function available(
  backend: AttestationBackend,
  promptArtifactStore: PromptArtifactStore,
  narrativeSource?: DispatchNarrativeSource,
): DispatchRuntime {
  return Object.freeze({
    kind: "available" as const,
    capability: createDispatchCapability({
      backend,
      promptArtifactStore,
      ...(narrativeSource === undefined ? {} : { narrativeSource }),
    }),
    close: async (): Promise<void> => backend.close(),
  });
}

export interface SingleProjectDispatchRuntimeOptions {
  readonly construction: SingleProjectConstruction;
  readonly resolved: ResolvedLedgerStore;
  readonly promptArtifactStore?: PromptArtifactStore;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Bind one production single-project server to the matching durable
 * attestation backend. Unsupported construction/backend cells and launches
 * without an attested prompt surface return an unavailable registration
 * verdict; callers must omit the five lifecycle tools in that case.
 */
export async function createSingleProjectDispatchRuntime(
  options: SingleProjectDispatchRuntimeOptions,
): Promise<DispatchRuntime> {
  let backend: ReturnType<typeof assertAttestationConstructionSupported>;
  try {
    backend = assertAttestationConstructionSupported(
      options.construction,
      options.resolved.backend,
    );
  } catch (error) {
    if (error instanceof AttestationBackendUnsupportedError) {
      return unavailable(error.message);
    }
    throw error;
  }
  if (options.promptArtifactStore === undefined) {
    return unavailable("no attested prompt artifact surface is configured");
  }

  const projectId = loadConfig(options.resolved.configRoot)?.ledger?.projectId ?? null;
  const namespace = await resolveSingleProjectAttestationNamespace({
    construction: options.construction,
    backend,
    repoRoot: options.resolved.configRoot,
    projectId,
  });
  let attestationBackend: AttestationBackend;
  switch (backend) {
    case "xdg":
      attestationBackend = await createAttestationStoreForConstruction({
        backend,
        namespace,
        ...(options.environment === undefined ? {} : { env: options.environment }),
      });
      break;
    case "fs":
      attestationBackend = await createAttestationStoreForConstruction({
        backend,
        namespace,
        ledgerRoot: options.resolved.configRoot,
      });
      break;
    case "postgres": {
      if (options.resolved.pg === undefined) {
        throw new Error("postgres ledger runtime lacks its resolved pool");
      }
      attestationBackend = await createAttestationStoreForConstruction({
        backend,
        namespace,
        pool: options.resolved.pg.pool,
      });
      break;
    }
  }
  return available(
    attestationBackend,
    options.promptArtifactStore,
    createDispatchNarrativeSource(options.resolved.store, namespace.projectKey),
  );
}

export interface PostgresHubDispatchRuntimeOptions {
  readonly pool: SQL;
  readonly trustedProjectKey: string;
  readonly store?: LedgerStore;
  readonly promptArtifactStore?: PromptArtifactStore;
}

/** Bind one trusted PostgreSQL hub tenant to its namespaced attestation store. */
export async function createPostgresHubDispatchRuntime(
  options: PostgresHubDispatchRuntimeOptions,
): Promise<DispatchRuntime> {
  assertAttestationConstructionSupported("postgres-hub", "postgres");
  if (options.promptArtifactStore === undefined) {
    return unavailable("no attested prompt artifact surface is configured");
  }
  const namespace = attestationNamespaceForTrustedHubProject(options.trustedProjectKey);
  const backend = await createAttestationStoreForConstruction({
    backend: "postgres",
    namespace,
    pool: options.pool,
  });
  return available(
    backend,
    options.promptArtifactStore,
    options.store === undefined
      ? undefined
      : createDispatchNarrativeSource(options.store, namespace.projectKey),
  );
}

/**
 * Assert a named construction/backend pair cannot expose dispatch tools and
 * turn that refusal into the registration verdict used by unsupported hosts.
 */
export function refuseDispatchRuntime(
  construction: LedgerServerConstruction,
  backend: string,
): DispatchRuntime {
  try {
    assertAttestationConstructionSupported(construction, backend);
  } catch (error) {
    if (error instanceof AttestationBackendUnsupportedError) {
      return unavailable(error.message);
    }
    throw error;
  }
  throw new Error(`dispatch construction ${construction}:${backend} is supported`);
}
