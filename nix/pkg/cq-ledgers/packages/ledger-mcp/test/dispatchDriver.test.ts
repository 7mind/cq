/**
 * G224 / K331 / K332: the CQ-driven dispatch driver over the REAL dispatch
 * capability and attestation backend, with scripted process adapters standing
 * in for the claude/codex/pi children.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  DispatchTransportAdapterRegistry,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  isAttestationTombstone,
  sequentialDispatchRandomBytes,
  serializePromptSurfaceManifest,
  type AttestationNamespace,
  type DispatchAdapterLaunchContext,
  type DispatchAdapterLaunchResult,
  type DispatchHandle,
  type DispatchTransportAdapter,
  type Harness,
  type NativeChildIdentity,
  type ReviewerToken,
} from "@cq/config";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import {
  AWAIT_DISPATCH_MAX_WAIT_MS,
  createDispatchDriver,
  type DispatchLaunchPlanner,
  type DispatchModelResolver,
} from "../src/dispatchDriver.js";
import { InMemoryPromptArtifactStore } from "../src/promptArtifactStore.js";

const encoder = new TextEncoder();
const ROLE_ID = "plan-advance";
const NOW = "2026-09-24T12:00:00.000Z";
const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "g224-dispatch-driver" };
const OUTPUT = { mode: "default", action: "noop" } as const;
const INPUT = {
  goalId: "G224",
  activeClaim: { goalId: "G224", claimId: "claim_G224_1", generation: 1, purpose: "initial" },
  currentDraftIdentity: null,
  latestReviewId: null,
} as const;
const TOKENS: Readonly<Record<Harness, ReviewerToken>> = {
  claude: { harness: "claude", model: "sonnet", provider: null, effort: null },
  codex: { harness: "codex", model: "gpt-5.6-sol", provider: null, effort: "high" },
  pi: { harness: "pi", model: "gpt-5.6-terra", provider: "openai-codex", effort: "high" },
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactStore(surface: Harness): InMemoryPromptArtifactStore {
  const role = encoder.encode(`---\nname: ${ROLE_ID}\n---\n\nThe ${surface} role body.\n`);
  const catalog = encoder.encode(
    JSON.stringify([
      {
        roleId: ROLE_ID,
        roleKind: "dispatched-subagent",
        canonicalSource: `agents/${ROLE_ID}.md`,
        surfaces: ["claude", "codex", "pi"],
        sharedSourceBlock: { classification: "shared-prose", sourceBlock: "all", targetFragment: null },
        fragmentBindings: [],
        dispatchRelations: [],
        intentionalDifferences: [],
        sidecar: { schemaRoleId: ROLE_ID },
      },
    ]),
  );
  const schema = encoder.encode(
    JSON.stringify({ id: ROLE_ID, version: 1, inputSchema: { type: "object" }, outputSchema: { type: "object" } }),
  );
  const manifest = encoder.encode(
    serializePromptSurfaceManifest(surface, sha256(catalog), [
      { roleId: ROLE_ID, version: 1, sha256: sha256(role), schemaSha256: sha256(schema) },
    ]),
  );
  return new InMemoryPromptArtifactStore(
    surface,
    manifest,
    catalog,
    [{ roleId: ROLE_ID, bytes: role }],
    [{ roleId: ROLE_ID, bytes: schema }],
  );
}

type ScriptedLaunch = (
  context: DispatchAdapterLaunchContext,
  expectedChild: NativeChildIdentity,
) => Promise<DispatchAdapterLaunchResult>;

/** A process child that materializes its input, stores OUTPUT, and completes. */
const completingChild: ScriptedLaunch = async (context, expectedChild) => {
  await context.child.materializeInput();
  const stored = await context.child.storeResult(OUTPUT);
  if (stored.state === "aborted") return { outcome: "aborted", reason: stored.result.reason };
  return {
    outcome: "completed",
    handle: { attestationId: context.prepared.attestationId, generation: context.prepared.generation },
    nativeCompletion: {
      kind: "native-completion",
      actor: "trusted-extension",
      childId: expectedChild.childId,
      runId: expectedChild.runId,
      completedAt: new Date().toISOString(),
    },
    handleOnlyEnforcement: "structural",
  };
};

interface Harnessed {
  readonly backend: InMemoryAttestationBackend;
  readonly store: InMemoryAttestationStore;
  readonly launches: Array<{ adapterId: string; surface: string; model: string }>;
  driver(): ReturnType<typeof createDispatchDriver>;
}

function harnessed(options: {
  readonly model?: DispatchModelResolver;
  readonly adapters?: readonly Harness[];
  readonly launch?: ScriptedLaunch;
}): Harnessed {
  const store = new InMemoryAttestationStore(NAMESPACE);
  const backend = new InMemoryAttestationBackend(store);
  const launches: Harnessed["launches"] = [];
  const correlations = new Map<string, NativeChildIdentity>();
  let minted = 0;
  const planner: DispatchLaunchPlanner = {
    plan: (targetHarness, roleId) => {
      minted += 1;
      const expectedChild = { childId: `${roleId}#${targetHarness}-${minted}`, runId: `run-${minted}` };
      return {
        expectedChild,
        bind: (handle: DispatchHandle) => correlations.set(handle.attestationId, expectedChild),
        release: (handle: DispatchHandle) => correlations.delete(handle.attestationId),
      };
    },
  };
  const script = options.launch ?? completingChild;
  const adapters: DispatchTransportAdapter[] = (options.adapters ?? ["claude", "codex", "pi"]).map(
    (targetHarness) => ({
      id: `${targetHarness}:process`,
      targetHarness,
      transport: "process",
      launch: async (context) => {
        const expectedChild = correlations.get(context.prepared.attestationId);
        if (expectedChild === undefined) throw new Error("launch before its correlation was bound");
        launches.push({
          adapterId: context.route.adapterId,
          surface: context.prepared.promptProvenance.surface,
          model: context.resolvedModel.model,
        });
        return await script(context, expectedChild);
      },
    }),
  );
  const registry = new DispatchTransportAdapterRegistry(adapters);
  const resolveModel: DispatchModelResolver =
    options.model ?? (() => ({ token: TOKENS.claude, formatted: "claude:sonnet" }));
  return {
    backend,
    store,
    launches,
    driver: () =>
      createDispatchDriver({
        capability: createDispatchCapability({
          backend,
          promptArtifactStore: artifactStore("claude"),
          targetPromptArtifactStores: {
            claude: artifactStore("claude"),
            codex: artifactStore("codex"),
            pi: artifactStore("pi"),
          },
          now: () => NOW,
          randomBytes: sequentialDispatchRandomBytes(0),
        }),
        readEnvelope: async (handle) =>
          await backend.transact({ kind: "handle", handle }, (transaction) => {
            const row = transaction.read(handle);
            return row === undefined || isAttestationTombstone(row) ? undefined : row;
          }),
        activeHarness: "claude",
        resolveModel,
        registry,
        planner,
      }),
  };
}

function startInput(key: string) {
  return { roleId: ROLE_ID, input: INPUT, idempotencyKey: key, timeoutMs: 120_000 };
}

async function started(driver: ReturnType<typeof createDispatchDriver>, key: string) {
  const outcome = await driver.start(startInput(key));
  if (!outcome.accepted) throw new Error(`unexpected rejection: ${outcome.detail}`);
  return outcome;
}

describe("G224 dispatch driver", () => {
  test("starts, launches through the target's process adapter, and awaits the consumed output", async () => {
    const h = harnessed({});
    const driver = h.driver();
    const outcome = await started(driver, "G224-consumed");
    expect(outcome.route).toEqual({ activeHarness: "claude", targetHarness: "claude", model: "claude:sonnet" });
    const awaited = await driver.await({ ...outcome.handle, waitMs: 5_000 });
    expect(awaited).toEqual({ state: "consumed", output: OUTPUT });
    expect(h.launches).toEqual([{ adapterId: "claude:process", surface: "claude", model: "sonnet" }]);
    expect(await driver.await({ ...outcome.handle, waitMs: 0 })).toEqual({ state: "consumed", output: OUTPUT });
  });

  test("a role configured for another harness prepares that surface and routes to its process adapter", async () => {
    const h = harnessed({ model: () => ({ token: TOKENS.codex, formatted: "codex:gpt-5.6-sol:high" }) });
    const driver = h.driver();
    const outcome = await started(driver, "G224-cross");
    expect(outcome.route.targetHarness).toBe("codex");
    expect(await driver.await({ ...outcome.handle, waitMs: 5_000 })).toMatchObject({ state: "consumed" });
    expect(h.launches).toEqual([{ adapterId: "codex:process", surface: "codex", model: "gpt-5.6-sol" }]);
    const row = h.store.read(outcome.handle);
    if (row === undefined || isAttestationTombstone(row)) throw new Error("expected envelope");
    expect(row.promptProvenance.surface).toBe("codex");
  });

  test("an adapter abort surfaces as an aborted await with its reason", async () => {
    const h = harnessed({
      launch: async () => ({ outcome: "aborted", reason: "native-failure", details: { source: "scripted" } }),
    });
    const driver = h.driver();
    const outcome = await started(driver, "G224-abort");
    expect(await driver.await({ ...outcome.handle, waitMs: 5_000 })).toEqual({
      state: "aborted",
      reason: "native-failure",
      details: { source: "scripted" },
    });
  });

  test("a missing target adapter aborts the prepared dispatch instead of leaving it prepared", async () => {
    const h = harnessed({
      adapters: ["claude"],
      model: () => ({ token: TOKENS.pi, formatted: "pi:openai-codex/gpt-5.6-terra:high" }),
    });
    const driver = h.driver();
    const outcome = await started(driver, "G224-no-adapter");
    const awaited = await driver.await({ ...outcome.handle, waitMs: 5_000 });
    expect(awaited).toMatchObject({ state: "aborted", reason: "native-failure", details: { source: "dispatch-driver" } });
    const row = h.store.read(outcome.handle);
    if (row === undefined || isAttestationTombstone(row)) throw new Error("expected envelope");
    expect(row.state).toBe("aborted");
    expect(h.launches).toEqual([]);
  });

  test("a pre-launch rejection is returned and nothing launches", async () => {
    const h = harnessed({});
    const outcome = await h.driver().start({ ...startInput("G224-reject"), timeoutMs: -1 });
    expect(outcome.accepted).toBe(false);
    expect(h.launches).toEqual([]);
  });

  test("a bounded await reports running until the child completes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harnessed({
      launch: async (context, expectedChild) => {
        await gate;
        return await completingChild(context, expectedChild);
      },
    });
    const driver = h.driver();
    const outcome = await started(driver, "G224-running");
    expect(await driver.await({ ...outcome.handle, waitMs: 20 })).toEqual({ state: "running" });
    release!();
    expect(await driver.await({ ...outcome.handle, waitMs: 5_000 })).toEqual({ state: "consumed", output: OUTPUT });
  });

  test("a terminal dispatch stays observable from the durable state after a restart", async () => {
    const h = harnessed({});
    const first = h.driver();
    const outcome = await started(first, "G224-restart");
    expect(await first.await({ ...outcome.handle, waitMs: 5_000 })).toMatchObject({ state: "consumed" });
    const restarted = h.driver();
    expect(await restarted.await({ ...outcome.handle, waitMs: 0 })).toEqual({ state: "consumed", output: OUTPUT });
  });

  test("an aborted dispatch reports its reason from the durable state after a restart", async () => {
    const h = harnessed({ launch: async () => ({ outcome: "aborted", reason: "cancelled" }) });
    const first = h.driver();
    const outcome = await started(first, "G224-restart-abort");
    await first.await({ ...outcome.handle, waitMs: 5_000 });
    expect(await h.driver().await({ ...outcome.handle, waitMs: 0 })).toMatchObject({
      state: "aborted",
      reason: "cancelled",
    });
  });

  test("refuses a wait outside its bound", async () => {
    const driver = harnessed({}).driver();
    const handle = { attestationId: `att_${"a".repeat(32)}`, generation: 1 };
    await expect(driver.await({ ...handle, waitMs: AWAIT_DISPATCH_MAX_WAIT_MS + 1 })).rejects.toThrow(/waitMs/);
    await expect(driver.await({ ...handle, waitMs: -1 })).rejects.toThrow(/waitMs/);
  });

  test("a model the resolver refuses fails start before anything is prepared", async () => {
    const h = harnessed({
      model: () => {
        throw new Error("model claude:nope is not dispatchable");
      },
    });
    await expect(h.driver().start({ ...startInput("G224-bad-model"), model: "claude:nope" })).rejects.toThrow(
      /not dispatchable/,
    );
    expect(h.launches).toEqual([]);
  });
});
