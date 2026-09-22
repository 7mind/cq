import { loadConfig } from "@cq/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAttestationStoreForConstruction, resolveSingleProjectAttestationNamespace, type ResolvedLedgerStore } from "@cq/ledger";
import { assertInvestigationCohortLaunchBindingV1, cohortValueDigestV1, investigationCohortEffectTargetRefV1,
  assertInvestigationNativeDispatchIdentityV1, type InvestigationNativeDispatchIdentityV1,
  type InvestigationCohortLaunchBindingV1, type WorksetEffectAdmissionProvider } from "@cq/process-control";
import { createDispatchCapability } from "./dispatchCapability.js";
import { resolvePromptSurface } from "./promptSurfaceSelection.js";
import { createCohortInvestigationAdvanceRuntimeV1 } from "./workCohortInvestigationAdvanceRuntime.js";
import { z } from "zod";

export interface InvestigationNativeProviderHostV1 {
  resolve(binding: InvestigationCohortLaunchBindingV1): Promise<WorksetEffectAdmissionProvider>;
  close(): Promise<void>;
}

export function assertInvestigationNativeSingletonDispatchV1(resolved: ResolvedLedgerStore, identity: InvestigationNativeDispatchIdentityV1): void {
  assertInvestigationNativeDispatchIdentityV1(identity);
  if (resolved.backend !== "xdg" || resolved.dbPath === undefined) throw new Error("investigation native admission requires its local durable primary");
  if (existsSync(join(dirname(resolved.dbPath), "cohort-investigation-dispatches", `${cohortValueDigestV1(identity.handle)}.json`))) {
    throw new Error("known investigation cohort dispatch requires its complete native launch binding");
  }
  const journals = join(dirname(resolved.dbPath), "cohort-investigations");
  if (!existsSync(journals)) return;
  const launchIndex = z.object({ version: z.literal(1), launches: z.array(z.object({ investigation: z.object({
    handle: z.object({ attestationId: z.string().min(1), generation: z.number().int().positive() }).strict(),
  }) })) });
  for (const entry of readdirSync(journals)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(entry)) continue;
    const journal = launchIndex.parse(JSON.parse(readFileSync(join(journals, entry), "utf8")));
    if (journal.launches.some((launch) => cohortValueDigestV1(launch.investigation.handle) === cohortValueDigestV1(identity.handle))) {
      throw new Error("retained investigation cohort preparation requires its complete native launch binding");
    }
  }
}

export async function createInvestigationNativeProviderHostV1(input: {
  readonly resolved: ResolvedLedgerStore;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<InvestigationNativeProviderHostV1> {
  if (input.resolved.backend !== "xdg") throw new Error("investigation native admission requires the local XDG primary");
  const selected = resolvePromptSurface({ promptSurface: undefined, promptRoot: undefined, environment: input.environment });
  if (selected === undefined) throw new Error("investigation native admission requires installed prompt artifacts");
  const namespace = await resolveSingleProjectAttestationNamespace({ construction: "direct", backend: "xdg",
    repoRoot: input.resolved.configRoot, projectId: loadConfig(input.resolved.configRoot)?.ledger?.projectId ?? null });
  const backend = await createAttestationStoreForConstruction({ backend: "xdg", namespace, env: input.environment });
  try {
    const runtime = await createCohortInvestigationAdvanceRuntimeV1({ resolved: input.resolved, backend,
      dispatch: createDispatchCapability({ backend, promptArtifactStore: selected.store }), promptArtifacts: selected.store,
      cancellationSignal: new AbortController().signal });
    if (runtime === undefined) throw new Error("investigation native admission lacks its durable cohort store");
    return { resolve: async (binding) => {
      assertInvestigationCohortLaunchBindingV1(binding);
      const authority = await runtime.resolveLaunchAuthority(binding.handle);
      if (authority === null || cohortValueDigestV1(authority.binding) !== cohortValueDigestV1(binding) ||
          authority.targetRef !== investigationCohortEffectTargetRefV1(binding)) {
        throw new Error("investigation native admission differs from its exact private prepared authority");
      }
      return authority.provider;
    }, close: () => backend.close() };
  } catch (error) { await backend.close(); throw error; }
}
