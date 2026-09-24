/**
 * G224 — assemble the CQ-driven dispatch driver for one single-project server.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DispatchTransportAdapterRegistry,
  isAttestationTombstone,
  loadConfig,
  type AttestationBackend,
  type Harness,
} from "@cq/config";
import {
  createCohortWorksetEffectAdmissionProvider,
  requireWorksetStore,
  resolveRetainedManagedCohortAuthority,
  worksetEffectAdmissionProviderFromStore,
  type DispatchCapability,
  type LedgerStore,
} from "@cq/ledger";
import { createDispatchDriver, type DispatchDriver } from "./dispatchDriver.js";
import { createDispatchLaunchBindings } from "./dispatchLaunchBindings.js";
import { createConfiguredDispatchModelResolver } from "./dispatchModelResolver.js";
import { FileSystemPromptArtifactStore, type PromptArtifactStore } from "./promptArtifactStore.js";
import { PROMPT_SURFACES } from "./promptSurfaceSelection.js";

export const CQ_LEDGER_COMMAND_ENV = "CQ_LEDGER_COMMAND";
export const CQ_CLAUDE_EXECUTABLE_ENV = "CQ_CLAUDE_EXECUTABLE";
export const CQ_CODEX_ROLE_COMMAND_ENV = "CQ_CODEX_ROLE_COMMAND";
export const CQ_PI_EXECUTABLE_ENV = "CQ_PI_EXECUTABLE";
const DEFAULT_LEDGER_COMMAND = "cq";
const DEFAULT_CLAUDE_EXECUTABLE = "claude";
const DEFAULT_CODEX_ROLE_COMMAND = "cq-codex-role";
const DEFAULT_PI_EXECUTABLE = "pi";
const SURFACE_MANIFEST = "surface.json";
/** The CQ Pi extension ships beside this module; Pi loads it by absolute path. */
const PI_CHILD_LEDGER_EXTENSION = fileURLToPath(new URL("./piChildLedgerExtension.ts", import.meta.url));

/** One artifact store per packaged surface under the prompt-surfaces root. */
export function targetPromptArtifactStoresFrom(
  promptSurfacesRoot: string | undefined,
): Readonly<Partial<Record<string, PromptArtifactStore>>> | undefined {
  if (promptSurfacesRoot === undefined) return undefined;
  const stores: Partial<Record<string, PromptArtifactStore>> = {};
  for (const surface of PROMPT_SURFACES) {
    const root = path.join(promptSurfacesRoot, surface);
    if (existsSync(path.join(root, SURFACE_MANIFEST))) {
      stores[surface] = new FileSystemPromptArtifactStore(surface, root);
    }
  }
  return Object.freeze(stores);
}

export interface ServerDispatchDriverInput {
  readonly capability: DispatchCapability;
  readonly backend: AttestationBackend;
  readonly store: LedgerStore;
  /** The parent's harness: the prompt surface this server serves. */
  readonly activeHarness: Harness;
  readonly configRoot: string;
  readonly promptSurfacesRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export function createServerDispatchDriver(input: ServerDispatchDriverInput): DispatchDriver {
  const readEnvelope = async (handle: { readonly attestationId: string; readonly generation: number }) =>
    await input.backend.transact({ kind: "handle", handle }, (transaction) => {
      const row = transaction.read(handle);
      return row === undefined || isAttestationTombstone(row) ? undefined : row;
    });
  const bindings = createDispatchLaunchBindings({
    ledgerCwd: input.configRoot,
    promptSurfacesRoot: input.promptSurfacesRoot,
    ledgerCommand: input.environment[CQ_LEDGER_COMMAND_ENV] ?? DEFAULT_LEDGER_COMMAND,
    claudeExecutable: input.environment[CQ_CLAUDE_EXECUTABLE_ENV] ?? DEFAULT_CLAUDE_EXECUTABLE,
    codexRoleCommand: input.environment[CQ_CODEX_ROLE_COMMAND_ENV] ?? DEFAULT_CODEX_ROLE_COMMAND,
    piExecutable: input.environment[CQ_PI_EXECUTABLE_ENV] ?? DEFAULT_PI_EXECUTABLE,
    piChildLedgerExtension: PI_CHILD_LEDGER_EXTENSION,
    effectAdmission: worksetEffectAdmissionProviderFromStore(requireWorksetStore(input.store)),
    cohortEffectAdmission: async (cohort, roleId) => {
      const cohortStore = input.store.workCohortStore?.();
      if (cohortStore === undefined) {
        throw new Error("a cohort dispatch needs this project's durable cohort store");
      }
      const retained = await resolveRetainedManagedCohortAuthority(
        input.configRoot,
        cohortStore,
        cohort as Parameters<typeof resolveRetainedManagedCohortAuthority>[2],
        {},
        roleId === "implement-conflict-resolver",
      );
      return createCohortWorksetEffectAdmissionProvider(retained.authority, requireWorksetStore(input.store));
    },
    readEnvelope,
    now: () => new Date().toISOString(),
  });
  return createDispatchDriver({
    capability: input.capability,
    readEnvelope,
    activeHarness: input.activeHarness,
    resolveModel: createConfiguredDispatchModelResolver(() =>
      loadConfig(input.configRoot, input.activeHarness),
    ),
    registry: new DispatchTransportAdapterRegistry(bindings.adapters),
    planner: bindings.planner,
    now: () => new Date().toISOString(),
  });
}
