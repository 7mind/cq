import {
  DISPATCH_OVERLAY_REGISTRY,
  AttestationBackendUnsupportedError,
  abortDispatchOn,
  confirmDispatchCompletionOn,
  defaultDispatchRandomBytes,
  fetchDispatchResultOn,
  loadConfig,
  prepareDispatchOn,
  storeDispatchResultOn,
  type AttestationBackend,
} from "@cq/config";
import type { SQL } from "bun";
import {
  assertAttestationConstructionSupported,
  attestationNamespaceForTrustedHubProject,
  createAttestationStoreForConstruction,
  resolveSingleProjectAttestationNamespace,
  type DispatchCapability,
  type LedgerServerConstruction,
  type ResolvedLedgerStore,
  type SingleProjectConstruction,
} from "@cq/ledger";
import type { PromptArtifactStore } from "./promptArtifactStore.js";

export interface DispatchCapabilityOptions {
  readonly backend: AttestationBackend;
  readonly promptArtifactStore: PromptArtifactStore;
  readonly now?: () => string;
  readonly randomBytes?: (count: number) => Uint8Array;
}

export function createDispatchCapability(options: DispatchCapabilityOptions): DispatchCapability {
  const now = options.now ?? (() => new Date().toISOString());
  const randomBytes = options.randomBytes ?? defaultDispatchRandomBytes;
  const namespace = options.backend.namespace;

  return {
    prepare: async (input) => {
      const artifact = options.promptArtifactStore.readRole(input.roleId);
      const manifest = options.promptArtifactStore.readManifest();
      const promptDigest = artifact.metadata.promptDigest;
      const catalogHash = manifest.catalogHash;
      const surface = artifact.metadata.promptSurface ?? manifest.promptSurface;
      if (
        artifact.metadata.roleKind !== "dispatched-subagent" ||
        promptDigest === undefined ||
        catalogHash === undefined ||
        surface === undefined
      ) {
        throw new Error(
          `prepare_dispatch requires an attested dispatched-role artifact for "${input.roleId}"`,
        );
      }
      return prepareDispatchOn(
        options.backend,
        {
          namespace,
          roleId: input.roleId,
          surface,
          input: input.input,
          idempotencyKey: input.idempotencyKey,
          timeoutMs: input.timeoutMs,
          registry: DISPATCH_OVERLAY_REGISTRY,
          promptDigest,
          catalogHash,
          expectedChild: input.expectedChild,
          ...(input.reprepareOf === undefined ? {} : { reprepareOf: input.reprepareOf }),
        },
        { now, randomBytes },
      );
    },
    storeResult: (input) => storeDispatchResultOn(options.backend, input, { now }),
    confirmCompletion: (input) =>
      confirmDispatchCompletionOn(options.backend, { namespace, ...input }, { now }),
    abort: (input) =>
      abortDispatchOn(options.backend, { namespace, actor: "trusted-parent", ...input }, { now }),
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
): DispatchRuntime {
  return Object.freeze({
    kind: "available" as const,
    capability: createDispatchCapability({ backend, promptArtifactStore }),
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
  return available(attestationBackend, options.promptArtifactStore);
}

export interface PostgresHubDispatchRuntimeOptions {
  readonly pool: SQL;
  readonly trustedProjectKey: string;
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
  return available(backend, options.promptArtifactStore);
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
