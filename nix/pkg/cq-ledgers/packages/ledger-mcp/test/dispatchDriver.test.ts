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
  type AttestationEnvelope,
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
  DISPATCH_WAIT_MAX_MS,
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

type Capability = ReturnType<typeof createDispatchCapability>;

interface Harnessed {
  readonly backend: InMemoryAttestationBackend;
  readonly store: InMemoryAttestationStore;
  readonly launches: Array<{ adapterId: string; surface: string; model: string }>;
  /** A fresh capability over the same durable backend, as after a server restart. */
  capability(): Capability;
  driver(capability: Capability): ReturnType<typeof createDispatchDriver>;
}

function harnessed(options: {
  readonly model?: DispatchModelResolver;
  readonly adapters?: readonly Harness[];
  readonly launch?: ScriptedLaunch;
  /** Wrap the durable envelope read, e.g. to present a staged worker result. */
  readonly envelope?: (row: AttestationEnvelope | undefined) => AttestationEnvelope | undefined;
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
        qualificationIdentity: { correlationId: `nonce-${minted}`, childThreadId: `run-${minted}`, runId: `run-${minted}` },
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
  const capability = (): Capability =>
    createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("claude"),
      targetPromptArtifactStores: {
        claude: artifactStore("claude"),
        codex: artifactStore("codex"),
        pi: artifactStore("pi"),
      },
      now: () => NOW,
      randomBytes: sequentialDispatchRandomBytes(0),
    });
  return {
    backend,
    store,
    launches,
    capability,
    driver: (current: Capability) =>
      createDispatchDriver({
        capability: current,
        readEnvelope: async (handle) => {
          const row = await backend.transact({ kind: "handle", handle }, (transaction) => {
            const read = transaction.read(handle);
            return read === undefined || isAttestationTombstone(read) ? undefined : read;
          });
          return options.envelope === undefined ? row : options.envelope(row);
        },
        activeHarness: "claude",
        resolveModel,
        registry,
        planner,
        now: () => NOW,
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

/** What the parent does: one bounded waiting fetch through the dispatch capability. */
async function waitingFetch(
  driver: ReturnType<typeof createDispatchDriver>,
  capability: Capability,
  handle: DispatchHandle,
  waitMs: number,
) {
  await driver.waitFor({ ...handle, waitMs });
  return await capability.fetch(handle);
}

describe("G224 dispatch driver", () => {
  test("starts, launches through the target's process adapter, and leaves the one fetch to the parent", async () => {
    const h = harnessed({});
    const capability = h.capability();
    const driver = h.driver(capability);
    const outcome = await started(driver, "G224-consumed");
    expect(outcome.route).toEqual({ activeHarness: "claude", targetHarness: "claude", model: "claude:sonnet" });
    expect(await waitingFetch(driver, capability, outcome.handle, 5_000)).toMatchObject({
      state: "consumed",
      output: OUTPUT,
    });
    expect(h.launches).toEqual([{ adapterId: "claude:process", surface: "claude", model: "sonnet" }]);
    expect(await capability.fetch(outcome.handle)).toMatchObject({ state: "output-already-materialized" });
  });

  test("a role configured for another harness prepares that surface and routes to its process adapter", async () => {
    const h = harnessed({ model: () => ({ token: TOKENS.codex, formatted: "codex:gpt-5.6-sol:high" }) });
    const capability = h.capability();
    const driver = h.driver(capability);
    const outcome = await started(driver, "G224-cross");
    expect(outcome.route.targetHarness).toBe("codex");
    expect(await waitingFetch(driver, capability, outcome.handle, 5_000)).toMatchObject({ state: "consumed" });
    expect(h.launches).toEqual([{ adapterId: "codex:process", surface: "codex", model: "gpt-5.6-sol" }]);
    const row = h.store.read(outcome.handle);
    if (row === undefined || isAttestationTombstone(row)) throw new Error("expected envelope");
    expect(row.promptProvenance.surface).toBe("codex");
  });

  test("an adapter abort is what the parent's fetch reports", async () => {
    const h = harnessed({
      launch: async () => ({ outcome: "aborted", reason: "native-failure", details: { source: "scripted" } }),
    });
    const capability = h.capability();
    const driver = h.driver(capability);
    const outcome = await started(driver, "G224-abort");
    expect(await waitingFetch(driver, capability, outcome.handle, 5_000)).toMatchObject({
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
    const capability = h.capability();
    const driver = h.driver(capability);
    const outcome = await started(driver, "G224-no-adapter");
    expect(await waitingFetch(driver, capability, outcome.handle, 5_000)).toMatchObject({
      state: "aborted",
      reason: "native-failure",
      details: { source: "dispatch-driver" },
    });
    expect(h.launches).toEqual([]);
  });

  test("a pre-launch rejection is returned and nothing launches", async () => {
    const h = harnessed({});
    const outcome = await h.driver(h.capability()).start({ ...startInput("G224-reject"), timeoutMs: -1 });
    expect(outcome.accepted).toBe(false);
    expect(h.launches).toEqual([]);
  });

  test("a bounded wait returns while the child runs, and a later wait observes the result", async () => {
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
    const capability = h.capability();
    const driver = h.driver(capability);
    const outcome = await started(driver, "G224-running");
    expect(await waitingFetch(driver, capability, outcome.handle, 20)).toMatchObject({ state: "prepared" });
    release!();
    expect(await waitingFetch(driver, capability, outcome.handle, 5_000)).toMatchObject({
      state: "consumed",
      output: OUTPUT,
    });
  });

  test("a terminal dispatch is fetched from the durable state after a restart", async () => {
    const h = harnessed({});
    const first = h.capability();
    const driver = h.driver(first);
    const outcome = await started(driver, "G224-restart");
    await driver.waitFor({ ...outcome.handle, waitMs: 5_000 });
    const restarted = h.capability();
    expect(await waitingFetch(h.driver(restarted), restarted, outcome.handle, 0)).toMatchObject({
      state: "consumed",
      output: OUTPUT,
    });
  });

  test("an aborted dispatch reports its reason from the durable state after a restart", async () => {
    const h = harnessed({ launch: async () => ({ outcome: "aborted", reason: "cancelled" }) });
    const first = h.capability();
    const driver = h.driver(first);
    const outcome = await started(driver, "G224-restart-abort");
    await driver.waitFor({ ...outcome.handle, waitMs: 5_000 });
    const restarted = h.capability();
    expect(await restarted.fetch(outcome.handle)).toMatchObject({ state: "aborted", reason: "cancelled" });
  });

  test("refuses a wait outside its bound", async () => {
    const h = harnessed({});
    const driver = h.driver(h.capability());
    const handle = { attestationId: `att_${"a".repeat(32)}`, generation: 1 };
    await expect(driver.waitFor({ ...handle, waitMs: DISPATCH_WAIT_MAX_MS + 1 })).rejects.toThrow(/waitMs/);
    await expect(driver.waitFor({ ...handle, waitMs: -1 })).rejects.toThrow(/waitMs/);
  });

  test("a model the resolver refuses fails start before anything is prepared", async () => {
    const h = harnessed({
      model: () => {
        throw new Error("model claude:nope is not dispatchable");
      },
    });
    await expect(
      h.driver(h.capability()).start({ ...startInput("G224-bad-model"), model: "claude:nope" }),
    ).rejects.toThrow(/not dispatchable/);
    expect(h.launches).toEqual([]);
  });

  describe("staged worker parent gate", () => {
    const PARENT_GATE = { scope: "parent-gate", token: `cq_parent_${"p".repeat(43)}` } as const;
    const stagedEnvelope = (row: AttestationEnvelope | undefined) =>
      row === undefined || row.state !== "result-stored"
        ? row
        : ({ ...row, state: "gate-pending", gateSubmittedOutputDigest: "d".repeat(64) } as AttestationEnvelope);

    function withParentGate(capability: Capability, calls: Array<{ op: string; input: unknown }>, qualifyAborts: boolean) {
      return {
        ...capability,
        prepare: async (input: Parameters<Capability["prepare"]>[0]) => {
          const outcome = await capability.prepare(input);
          return outcome.accepted
            ? { ...outcome, prepared: { ...outcome.prepared, parentGateCapability: PARENT_GATE } }
            : outcome;
        },
        qualifyImplementationCandidate: async (input: unknown) => {
          calls.push({ op: "qualify", input });
          return qualifyAborts
            ? ({ state: "aborted", result: { state: "aborted", reason: "protocol-violation" } } as never)
            : ({ state: "queued" } as never);
        },
        coordinateImplementationCandidate: async (input: unknown) => {
          calls.push({ op: "coordinate", input });
          return {} as never;
        },
      } as Capability;
    }

    test("qualifies with the identity bound at prepare, then runs the parent gate with the server-held capability", async () => {
      const h = harnessed({ envelope: stagedEnvelope });
      const calls: Array<{ op: string; input: unknown }> = [];
      const capability = withParentGate(h.capability(), calls, false);
      const driver = h.driver(capability);
      const outcome = await started(driver, "G224-staged");
      await driver.waitFor({ ...outcome.handle, waitMs: 5_000 });
      expect(calls.map((call) => call.op)).toEqual(["qualify", "coordinate"]);
      expect(calls[0]!.input).toMatchObject({
        ...outcome.handle,
        roleId: ROLE_ID,
        correlationId: "nonce-1",
        childThreadId: "run-1",
        expectedRunId: "run-1",
        outcome: "completed",
        exitStatus: 0,
      });
      expect(calls[1]!.input).toMatchObject({ ...outcome.handle, parentGateCapability: PARENT_GATE });
      expect(JSON.stringify(outcome)).not.toContain(PARENT_GATE.token);
    });

    test("an aborting qualification never reaches the parent gate", async () => {
      const h = harnessed({ envelope: stagedEnvelope });
      const calls: Array<{ op: string; input: unknown }> = [];
      const driver = h.driver(withParentGate(h.capability(), calls, true));
      const outcome = await started(driver, "G224-staged-abort");
      await driver.waitFor({ ...outcome.handle, waitMs: 5_000 });
      expect(calls.map((call) => call.op)).toEqual(["qualify"]);
    });

    test("a dispatch without a parent gate is never qualified", async () => {
      const h = harnessed({});
      const calls: Array<{ op: string; input: unknown }> = [];
      const base = h.capability();
      const capability = {
        ...base,
        qualifyImplementationCandidate: async (input: unknown) => (calls.push({ op: "qualify", input }), {} as never),
      } as Capability;
      const driver = h.driver(capability);
      const outcome = await started(driver, "G224-no-gate");
      expect(await waitingFetch(driver, capability, outcome.handle, 5_000)).toMatchObject({ state: "consumed" });
      expect(calls).toEqual([]);
    });
  });
});
