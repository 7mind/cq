import { describe, expect, test } from "bun:test";
import {
  AttestationKeyReuseError,
  DISPATCH_INPUT_VALIDATION_DEFERRED,
  DISPATCH_REF_ASSEMBLY_DEFERRED,
  DispatchStateConflictError,
  FakeDispatchClock,
  IDEMPOTENCY_HORIZON_MS,
  IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  REF_ASSEMBLED_ROLES,
  TERMINAL_ENVELOPE_RETENTION_MS,
  attestationRowDigest,
  dispatchPayloadDigest,
  sequentialDispatchRandomBytes,
  sweepAttestationsOn,
  type AttestationEnvelope,
  type AttestationNamespace,
  type DispatchNarrativeSource,
  type PromptSurface,
} from "@cq/config";
import {
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  createDispatchNarrativeSource,
} from "@cq/ledger";
import {
  DISPATCH_RUNTIME_DEFERRAL_DISCHARGE,
  createDispatchCapability,
  type DispatchCapabilityOptions,
} from "../src/dispatchCapability.js";
import type {
  PromptArtifactStore,
  PromptArtifactRoleMetadata,
} from "../src/promptArtifactStore.js";

const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "runtime-T977" };
const PROMPT_DIGEST = "a".repeat(64);
const CATALOG_HASH = "b".repeat(64);
const NOW = "2026-07-29T09:00:00.000Z";
const EXPECTED_CHILD = { childId: "child-t977", runId: "run-t977" } as const;
const INLINE_INPUT = Object.freeze({
  taskId: "T977",
  headline: "Implement the real compact-dispatch path",
  description: "Validate and durably prepare a ref-first dispatch.",
  acceptance: "The child retrieves its prepare-bound input once.",
  worktreePath: "/tmp/wt-T977",
  branch: "implement/T977",
  baseCommit: "fe5d747b07669be02626da96a8ac441f8e0bf550",
  round: 0,
  startingCommit: "fe5d747b07669be02626da96a8ac441f8e0bf550",
});

const REVIEWER_INPUT = Object.freeze({
  taskId: "T1696",
  acceptance: "Prepare binds one absolute reviewer phase window.",
  worktreePath: "/tmp/wt-T1696",
  branch: "implement/T1696",
  baseCommit: "e65ce042ab4093398372f886e471e57f8f3efdae",
  workerResult: {
    resultCommit: "e65ce042ab4093398372f886e471e57f8f3efdae",
    checkSummary: "REAL_CHECK_EXIT=0",
    filesTouched: [],
  },
  round: 1,
  priorCriticism: [],
});

function artifactStore(surface: PromptSurface): PromptArtifactStore {
  const metadata: PromptArtifactRoleMetadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent",
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: surface,
    promptDigest: PROMPT_DIGEST,
    schemaVersion: 1,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: surface,
      catalogHash: CATALOG_HASH,
    }),
    readRole: (roleId) => {
      if (roleId !== "implement-worker") {
        throw new Error(`unexpected role artifact read for "${roleId}"`);
      }
      return { metadata, bytes: new Uint8Array([1]) };
    },
  };
}

function reviewerArtifactStore(surface: PromptSurface): PromptArtifactStore {
  const metadata: PromptArtifactRoleMetadata = {
    roleId: "implement-reviewer",
    roleKind: "dispatched-subagent",
    artifactPath: "roles/implement-reviewer.md",
    sidecarSchemaRoleId: "implement-reviewer",
    promptSurface: surface,
    promptDigest: PROMPT_DIGEST,
    schemaVersion: 3,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: surface,
      catalogHash: CATALOG_HASH,
    }),
    readRole: (roleId) => {
      if (roleId !== "implement-reviewer") {
        throw new Error(`unexpected role artifact read for "${roleId}"`);
      }
      return { metadata, bytes: new Uint8Array([1]) };
    },
  };
}

function artifactStoreWithSurfaces(
  manifestSurface: PromptSurface,
  roleSurface: PromptSurface,
): PromptArtifactStore {
  const base = artifactStore(roleSurface);
  return {
    readManifest: () => ({
      ...base.readManifest(),
      promptSurface: manifestSurface,
    }),
    readRole: base.readRole,
  };
}

function runtime(
  surface: PromptSurface = "claude",
  narrativeSource?: DispatchNarrativeSource,
): {
  readonly store: InMemoryAttestationStore;
  readonly capability: ReturnType<typeof createDispatchCapability>;
} {
  const store = new InMemoryAttestationStore(NAMESPACE);
  const options: DispatchCapabilityOptions = {
    backend: new InMemoryAttestationBackend(store),
    promptArtifactStore: artifactStore(surface),
    now: () => NOW,
    randomBytes: sequentialDispatchRandomBytes(0),
    ...(narrativeSource === undefined ? {} : { narrativeSource }),
  };
  return { store, capability: createDispatchCapability(options) };
}

function inlineRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): Parameters<ReturnType<typeof createDispatchCapability>["prepare"]>[0] {
  return {
    roleId: "implement-worker",
    input: INLINE_INPUT,
    idempotencyKey: "T977-round-0",
    timeoutMs: 600_000,
    expectedChild: EXPECTED_CHILD,
    ...overrides,
  };
}

function reviewerRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): Parameters<ReturnType<typeof createDispatchCapability>["prepare"]>[0] {
  return {
    roleId: "implement-reviewer",
    input: REVIEWER_INPUT,
    idempotencyKey: "T1696-review-round-1",
    timeoutMs: IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS,
    expectedChild: EXPECTED_CHILD,
    ...overrides,
  };
}

describe("live compact-dispatch capability", () => {
  test("discharges every T976/T978 runtime handoff exactly once", () => {
    expect([...DISPATCH_RUNTIME_DEFERRAL_DISCHARGE.keys()].sort()).toEqual(
      [...DISPATCH_INPUT_VALIDATION_DEFERRED, ...DISPATCH_REF_ASSEMBLY_DEFERRED].sort(),
    );
    for (const implementation of DISPATCH_RUNTIME_DEFERRAL_DISCHARGE.values()) {
      expect(implementation.length).toBeGreaterThan(0);
    }
  });

  for (const surface of ["claude", "codex", "pi"] as const) {
    test(`${surface}: prepare validates, allocates once, and gives the child one input copy`, async () => {
      const { store, capability } = runtime(surface);
      const prepared = await capability.prepare(inlineRequest());
      if (!prepared.accepted) throw new Error(`unexpected rejection: ${prepared.detail}`);
      expect(prepared.prepared.promptProvenance.surface).toBe(surface);
      expect(store.snapshot()).toHaveLength(1);

      const fetched = await capability.fetchInput({
        attestationId: prepared.prepared.attestationId,
        generation: prepared.prepared.generation,
        inputCapability: prepared.prepared.inputCapability,
      });
      expect(fetched.input).toEqual(INLINE_INPUT);
      await expect(
        capability.fetchInput({
          attestationId: prepared.prepared.attestationId,
          generation: prepared.prepared.generation,
          inputCapability: prepared.prepared.inputCapability,
        }),
      ).rejects.toBeInstanceOf(DispatchStateConflictError);
    });
  }

  test("role, input, overlay, and launch-envelope rejection precedes artifact and durable allocation", async () => {
    const store = new InMemoryAttestationStore(NAMESPACE);
    let roleReads = 0;
    const baseStore = artifactStore("claude");
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(store),
      promptArtifactStore: {
        readManifest: baseStore.readManifest,
        readRole: (roleId) => {
          roleReads += 1;
          return baseStore.readRole(roleId);
        },
      },
      now: () => NOW,
      randomBytes: sequentialDispatchRandomBytes(0),
    });
    for (const [overrides, reason] of [
      [{ roleId: "unknown-role" }, "unknown-role"],
      [{ input: { taskId: "T977" } }, "invalid-role-input"],
      [{ overlays: [{ overlayId: "undeclared", data: {} }] }, "invalid-overlay-data"],
      [{ timeoutMs: 0 }, "invalid-launch-envelope"],
    ] as const) {
      const before = store.snapshot().map(attestationRowDigest);
      const outcome = await capability.prepare(
        inlineRequest({ ...overrides, idempotencyKey: `reject-${reason}` }),
      );
      expect(outcome.accepted, reason).toBe(false);
      if (outcome.accepted) throw new Error("expected rejection");
      expect(outcome.reason).toBe(reason);
      expect(outcome.allocated).toBe(false);
      expect(store.snapshot().map(attestationRowDigest)).toEqual(before);
    }
    expect(roleReads).toBe(0);
  });

  test("a Codex request against a Claude artifact rejects before durable allocation", async () => {
    const store = new InMemoryAttestationStore(NAMESPACE);
    const source: DispatchNarrativeSource = {
      projectKey: NAMESPACE.projectKey,
      readItem: (ledger, id) =>
        ledger === TASKS_LEDGER && id === "T977"
          ? {
              id,
              status: "wip",
              fields: {
                headline: INLINE_INPUT.headline,
                description: INLINE_INPUT.description,
                acceptance: INLINE_INPUT.acceptance,
              },
            }
          : undefined,
    };
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(store),
      promptArtifactStore: artifactStore("claude"),
      narrativeSource: source,
      now: () => NOW,
      randomBytes: sequentialDispatchRandomBytes(0),
    });
    const outcome = await capability.prepare({
      refs: {
        roleId: "implement-worker",
        surface: "codex",
        projectKey: NAMESPACE.projectKey,
        taskId: "T977",
        coordinates: {
          worktreePath: INLINE_INPUT.worktreePath,
          branch: INLINE_INPUT.branch,
          baseCommit: INLINE_INPUT.baseCommit,
        },
        round: INLINE_INPUT.round,
        startingCommit: INLINE_INPUT.startingCommit,
      },
      idempotencyKey: "T977-cross-surface",
      timeoutMs: 600_000,
      expectedChild: EXPECTED_CHILD,
    });

    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) throw new Error("expected cross-surface rejection");
    expect(outcome.reason).toBe("invalid-launch-envelope");
    expect(outcome.allocated).toBe(false);
    expect(store.snapshot()).toHaveLength(0);
  });

  test("manifest and role-artifact surfaces must agree before durable allocation", async () => {
    const store = new InMemoryAttestationStore(NAMESPACE);
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(store),
      promptArtifactStore: artifactStoreWithSurfaces("codex", "claude"),
      now: () => NOW,
      randomBytes: sequentialDispatchRandomBytes(0),
    });
    const outcome = await capability.prepare(
      inlineRequest({ idempotencyKey: "T977-incoherent-artifact" }),
    );

    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) throw new Error("expected incoherent-artifact rejection");
    expect(outcome.reason).toBe("invalid-launch-envelope");
    expect(outcome.allocated).toBe(false);
    expect(store.snapshot()).toHaveLength(0);
  });

  test("identical same-runtime retries replay raw capabilities; a conflict fails closed", async () => {
    const { store, capability } = runtime();
    const request = inlineRequest();
    const [first, concurrent] = await Promise.all([
      capability.prepare(request),
      capability.prepare(request),
    ]);
    expect(concurrent).toEqual(first);
    expect(store.snapshot()).toHaveLength(1);
    const before = store.snapshot().map(attestationRowDigest);
    expect(await capability.prepare(request)).toEqual(first);
    expect(store.snapshot().map(attestationRowDigest)).toEqual(before);

    const conflicting = inlineRequest({
      input: { ...INLINE_INPUT, headline: "different but schema-valid narrative" },
    });
    await expect(capability.prepare(conflicting)).rejects.toBeInstanceOf(AttestationKeyReuseError);
    expect(store.snapshot().map(attestationRowDigest)).toEqual(before);
  });

  test("reviewer minimum and caller timing reject before allocation; 150000 ms is first accepted [BG]", async () => {
    for (const timeoutMs of [60_000, 149_999]) {
      const store = new InMemoryAttestationStore(NAMESPACE);
      let clockReads = 0;
      const capability = createDispatchCapability({
        backend: new InMemoryAttestationBackend(store),
        promptArtifactStore: reviewerArtifactStore("codex"),
        now: () => {
          clockReads += 1;
          return NOW;
        },
        randomBytes: sequentialDispatchRandomBytes(timeoutMs),
      });
      const outcome = await capability.prepare(
        reviewerRequest({ timeoutMs, idempotencyKey: `reviewer-timeout-${timeoutMs}` }),
      );
      expect(outcome.accepted).toBe(false);
      if (outcome.accepted) throw new Error("expected reviewer timeout rejection");
      expect(outcome.path).toBe("timeoutMs");
      expect(clockReads).toBe(0);
      expect(store.snapshot()).toHaveLength(0);
    }

    for (const [field, value] of [
      ["responseStoreNow", NOW],
      ["gateCompleteBy", NOW],
      ["synthesisStoreReserveMs", 60_000],
    ] as const) {
      const store = new InMemoryAttestationStore(NAMESPACE);
      let clockReads = 0;
      const capability = createDispatchCapability({
        backend: new InMemoryAttestationBackend(store),
        promptArtifactStore: reviewerArtifactStore("codex"),
        now: () => {
          clockReads += 1;
          return NOW;
        },
        randomBytes: sequentialDispatchRandomBytes(0),
      });
      const outcome = await capability.prepare(
        reviewerRequest({
          input: { ...REVIEWER_INPUT, [field]: value },
          idempotencyKey: `reviewer-caller-${field}`,
        }),
      );
      expect(outcome.accepted).toBe(false);
      if (outcome.accepted) throw new Error("expected caller timing rejection");
      expect(outcome.reason).toBe("invalid-role-input");
      expect(clockReads).toBe(0);
      expect(store.snapshot()).toHaveLength(0);
    }
  });

  test("exact reviewer replay preserves the bound input and does not reset the phase clock [BG]", async () => {
    const store = new InMemoryAttestationStore(NAMESPACE);
    let clockReads = 0;
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(store),
      promptArtifactStore: reviewerArtifactStore("codex"),
      now: () => {
        clockReads += 1;
        return NOW;
      },
      randomBytes: sequentialDispatchRandomBytes(0),
    });
    const request = reviewerRequest();
    const first = await capability.prepare(request);
    if (!first.accepted) throw new Error(first.detail);
    expect(clockReads).toBe(1);
    expect(await capability.prepare(request)).toEqual(first);
    expect(clockReads).toBe(1);

    const fetched = await capability.fetchInput({
      ...first.handle,
      inputCapability: first.prepared.inputCapability,
    });
    expect(fetched.input).toEqual({
      ...REVIEWER_INPUT,
      responseStoreNow: "2026-07-29T09:02:00.000Z",
      gateCompleteBy: "2026-07-29T09:01:00.000Z",
      synthesisStoreReserveMs: 60_000,
    });
    expect(fetched.promptProvenance.inputDigest).toBe(dispatchPayloadDigest(fetched.input));
    expect(fetched.promptProvenance.inputDigest).not.toBe(dispatchPayloadDigest(REVIEWER_INPUT));
  });

  test("legal reviewer reprepare reads the phase clock once and binds a new window [BG]", async () => {
    const store = new InMemoryAttestationStore(NAMESPACE);
    let current = NOW;
    let clockReads = 0;
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(store),
      promptArtifactStore: reviewerArtifactStore("codex"),
      now: () => {
        clockReads += 1;
        return current;
      },
      randomBytes: sequentialDispatchRandomBytes(0),
    });
    const first = await capability.prepare(reviewerRequest());
    if (!first.accepted) throw new Error(first.detail);
    await capability.abort({ ...first.handle, reason: "cancelled" });

    current = "2026-07-29T09:00:10.000Z";
    clockReads = 0;
    const second = await capability.prepare(
      reviewerRequest({ idempotencyKey: "T1696-review-round-2", reprepareOf: first.handle }),
    );
    if (!second.accepted) throw new Error(second.detail);
    expect(clockReads).toBe(1);
    expect(second.handle).toEqual({ attestationId: first.handle.attestationId, generation: 2 });
    const row = store.read(second.handle);
    if (row === undefined || row.kind !== "envelope") throw new Error("expected envelope");
    expect(row.input).toMatchObject({
      responseStoreNow: "2026-07-29T09:02:10.000Z",
      gateCompleteBy: "2026-07-29T09:01:10.000Z",
      synthesisStoreReserveMs: 60_000,
    });
  });

  test("a restart cannot replay raw capabilities and names the existing handle", async () => {
    const store = new InMemoryAttestationStore(NAMESPACE);
    const backend = new InMemoryAttestationBackend(store);
    const options = {
      backend,
      promptArtifactStore: artifactStore("claude"),
      now: () => NOW,
      randomBytes: sequentialDispatchRandomBytes(0),
    } satisfies DispatchCapabilityOptions;
    const first = await createDispatchCapability(options).prepare(inlineRequest());
    if (!first.accepted) throw new Error(`unexpected rejection: ${first.detail}`);

    try {
      await createDispatchCapability(options).prepare(inlineRequest());
      throw new Error("expected restarted prepare to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AttestationKeyReuseError);
      expect(String(error)).toContain(first.handle.attestationId);
    }
  });

  test("a cached retry verifies its durable request binding before returning raw capabilities", async () => {
    const { store, capability } = runtime();
    const first = await capability.prepare(inlineRequest());
    if (!first.accepted) throw new Error(`unexpected rejection: ${first.detail}`);
    const row = store.read(first.handle);
    if (row === undefined || row.kind !== "envelope") throw new Error("expected envelope");
    const corrupted: AttestationEnvelope = {
      ...row,
      prepareRequestDigest: "f".repeat(64),
    };
    store.replace(row, corrupted);
    await expect(capability.prepare(inlineRequest())).rejects.toBeInstanceOf(
      DispatchStateConflictError,
    );
  });

  test("reports durable dispatch and lease owners for one bound worktree", async () => {
    const { store, capability } = runtime();
    const prepared = await capability.prepare(inlineRequest());
    if (!prepared.accepted) throw new Error(`unexpected rejection: ${prepared.detail}`);
    const row = store.read(prepared.handle);
    if (row === undefined || row.kind !== "envelope") throw new Error("expected envelope");
    const bound: AttestationEnvelope = {
      ...row,
      gitEffectBinding: {
        taskId: "T977",
        handleToken: "handle-token",
        handleFingerprint: "c".repeat(64),
        repositoryRoot: "/tmp/repo",
        repositoryId: "d".repeat(64),
        commonDir: "/tmp/repo/.git",
        worktreePath: "/tmp/wt-T977",
        branch: "implement/T977",
        ref: "refs/heads/implement/T977",
        baseCommit: INLINE_INPUT.baseCommit,
      },
    };
    store.replace(row, bound);
    const owner = `${row.attestationId}#${row.generation}`;
    await expect(capability.observeWorktreeActivity!("/tmp/wt-T977")).resolves.toEqual({
      liveDispatches: [owner],
      liveLeases: [],
    });

    const output = { status: "fail" } as const;
    const leased: AttestationEnvelope = {
      ...bound,
      state: "result-stored",
      storedAt: NOW,
      output,
      outputDigest: dispatchPayloadDigest(output),
    };
    store.replace(bound, leased);
    await expect(capability.observeWorktreeActivity!("/tmp/wt-T977")).resolves.toEqual({
      liveDispatches: [],
      liveLeases: [owner],
    });
  });

  test("a missing cached durable row before the horizon fails closed without allocation", async () => {
    const { store, capability } = runtime();
    const request = inlineRequest({ idempotencyKey: "T977-missing-before-horizon" });
    const first = await capability.prepare(request);
    if (!first.accepted) throw new Error(`unexpected rejection: ${first.detail}`);
    store.remove(first.handle);

    await expect(capability.prepare(request)).rejects.toBeInstanceOf(DispatchStateConflictError);
    expect(store.snapshot()).toHaveLength(0);
  });

  test("a same-runtime terminal cache yields after a horizon sweep deletes its row", async () => {
    const clock = new FakeDispatchClock(NOW);
    const store = new InMemoryAttestationStore(NAMESPACE);
    const backend = new InMemoryAttestationBackend(store);
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("claude"),
      now: clock.now,
      randomBytes: sequentialDispatchRandomBytes(0),
    });
    const request = inlineRequest({ idempotencyKey: "T977-swept-after-horizon" });
    const first = await capability.prepare(request);
    if (!first.accepted) throw new Error(`unexpected rejection: ${first.detail}`);
    await capability.abort({ ...first.handle, reason: "cancelled" });

    clock.advance(IDEMPOTENCY_HORIZON_MS);
    const swept = await sweepAttestationsOn(backend, { now: clock.now });
    expect(swept.tombstonesRemoved).toEqual([first.handle]);
    expect(store.snapshot()).toHaveLength(0);

    const reclaimed = await capability.prepare(request);
    if (!reclaimed.accepted) throw new Error(`unexpected rejection: ${reclaimed.detail}`);
    expect(reclaimed.handle).not.toEqual(first.handle);
    expect(store.snapshot()).toHaveLength(1);
  });

  test("same-runtime cache yields to durable idempotency reclamation after 30 days", async () => {
    const clock = new FakeDispatchClock(NOW);
    const store = new InMemoryAttestationStore(NAMESPACE);
    const backend = new InMemoryAttestationBackend(store);
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("claude"),
      now: clock.now,
      randomBytes: sequentialDispatchRandomBytes(0),
    });
    const request = inlineRequest({ idempotencyKey: "T977-horizon-reclaim" });
    const first = await capability.prepare(request);
    if (!first.accepted) throw new Error(`unexpected rejection: ${first.detail}`);
    await capability.abort({ ...first.handle, reason: "cancelled" });

    clock.advance(IDEMPOTENCY_HORIZON_MS + 1);
    const [reclaimed, concurrent] = await Promise.all([
      capability.prepare(request),
      capability.prepare(request),
    ]);
    if (!reclaimed.accepted) throw new Error(`unexpected rejection: ${reclaimed.detail}`);
    expect(concurrent).toEqual(reclaimed);
    expect(reclaimed.handle).not.toEqual(first.handle);
    expect(store.snapshot()).toHaveLength(1);
    expect(store.snapshot()[0]?.attestationId).toBe(reclaimed.handle.attestationId);
  });

  test("same-runtime cache preserves holds before the horizon and refuses a tombstone replay", async () => {
    const clock = new FakeDispatchClock(NOW);
    const store = new InMemoryAttestationStore(NAMESPACE);
    const backend = new InMemoryAttestationBackend(store);
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("claude"),
      now: clock.now,
      randomBytes: sequentialDispatchRandomBytes(0),
    });
    const request = inlineRequest({ idempotencyKey: "T977-horizon-held" });
    const first = await capability.prepare(request);
    if (!first.accepted) throw new Error(`unexpected rejection: ${first.detail}`);
    await capability.abort({ ...first.handle, reason: "cancelled" });

    expect(await capability.prepare(request)).toEqual(first);
    await expect(
      capability.prepare(
        inlineRequest({
          idempotencyKey: "T977-horizon-held",
          input: { ...INLINE_INPUT, headline: "conflicting held request" },
        }),
      ),
    ).rejects.toBeInstanceOf(AttestationKeyReuseError);

    clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
    await sweepAttestationsOn(backend, { now: clock.now });
    const before = store.snapshot().map(attestationRowDigest);
    await expect(capability.prepare(request)).rejects.toBeInstanceOf(DispatchStateConflictError);
    expect(store.snapshot().map(attestationRowDigest)).toEqual(before);
  });

  test("refs keep ledger narrative out of parent input and deliver it only to the child", async () => {
    expect(REF_ASSEMBLED_ROLES).toEqual(["implement-worker"]);
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const narrative = "sentinel-narrative-f8d1e7";
    await ledger.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "T977",
      status: "wip",
      fields: {
        headline: narrative,
        description: "server-read description",
        acceptance: "server-read acceptance",
      },
    });
    const refs = {
      roleId: "implement-worker",
      surface: "claude",
      projectKey: NAMESPACE.projectKey,
      taskId: "T977",
      coordinates: {
        worktreePath: "/tmp/wt-T977",
        branch: "implement/T977",
        baseCommit: "fe5d747b07669be02626da96a8ac441f8e0bf550",
      },
      round: 0,
      startingCommit: "fe5d747b07669be02626da96a8ac441f8e0bf550",
    } as const;
    const parentRequest = {
      refs,
      idempotencyKey: "T977-refs-round-0",
      timeoutMs: 600_000,
      expectedChild: EXPECTED_CHILD,
    } as const;
    expect(JSON.stringify(parentRequest)).not.toContain(narrative);

    const { capability } = runtime(
      "claude",
      createDispatchNarrativeSource(ledger, NAMESPACE.projectKey),
    );
    const prepared = await capability.prepare(parentRequest);
    if (!prepared.accepted) throw new Error(`unexpected rejection: ${prepared.detail}`);
    expect(JSON.stringify(prepared)).not.toContain(narrative);
    const child = await capability.fetchInput({
      ...prepared.handle,
      inputCapability: prepared.prepared.inputCapability,
    });
    expect(JSON.stringify(child.input)).toContain(narrative);
    expect(child.promptProvenance.inputDigest).toBe(prepared.prepared.promptProvenance.inputDigest);
    await ledger.dispose();
  });
});
