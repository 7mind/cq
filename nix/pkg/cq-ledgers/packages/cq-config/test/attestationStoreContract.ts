/**
 * THE shared {@link AttestationStore} adapter contract (T720, goal G94).
 *
 * ONE abstract suite, executed against every attestation backend — the
 * bun:sqlite/XDG store, the cross-process-safe filesystem store, PostgreSQL,
 * AND T685's strict in-memory dummy — so the dummy and the production adapters
 * are held to IDENTICAL assertions. T685 deliberately did not build this
 * (it judged an abstract store suite speculative at contract level); the
 * production adapters make it load-bearing, because "it works in memory" is
 * exactly the claim a durable store must not be allowed to inherit.
 *
 * Three constructions in here exist because of failure modes this package has
 * already produced:
 *
 *  - **Adapter refusal vs service refusal.** T685's strict dummy MASKED
 *    service-side guards until it was paired with a guardless `LyingStore`.
 *    The inverse hazard applies here: a PERMISSIVE adapter looks correct as long
 *    as the service refuses first. Every durable guard in this suite is
 *    therefore reached with the SERVICE OUT OF THE WAY — a hand-built row
 *    inserted through a unit of work whose loaded scope cannot see the row it
 *    conflicts with, so only the backend's own constraint can refuse it.
 *  - **A mutation table cannot see an over-wide return, or a declaration with
 *    nothing behind it.** T685 passed 119 mutations and still shipped D173 (a
 *    confirm ack carrying the whole body) and D174 (a declared `trusted-parent`
 *    scope on `fetch_dispatch_result` with no check implementing it). So this
 *    suite asserts, separately and mechanically: what each returned surface must
 *    NOT contain, and that every operation DECLARED `trusted-parent` really
 *    rejects a foreign namespace and an untrusted actor when driven through the
 *    backend.
 *  - **Prototype pollution.** This package has produced four instances, the
 *    latest inside `store_result`. Attestation ids, capability hashes and
 *    idempotency keys are all caller-influenceable keys, so every one of them is
 *    driven with `constructor` / `toString` / `valueOf` / `hasOwnProperty` /
 *    `__proto__` against every lookup an adapter offers.
 *
 * Timing is a FAKE clock throughout ({@link FakeDispatchClock}), so the launch
 * deadline and the 24h/30d retention boundaries are asserted EXACTLY rather than
 * approximately, and every "operation-time check is independent of sweeps" case
 * runs with no sweep ever performed.
 */

import { describe, expect, test } from "bun:test";
import {
  AttestationBindingError,
  AttestationKeyReuseError,
  AttestationNamespaceError,
  AttestationNotFoundError,
  AttestationStorageError,
  AttestationTransportError,
  DISPATCH_OVERLAY_REGISTRY,
  DISPATCH_PROTOCOL_OPERATIONS,
  DispatchAuthorizationError,
  DispatchStateConflictError,
  FakeDispatchClock,
  IDEMPOTENCY_HORIZON_MS,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  LAUNCH_DEADLINE_MS,
  RESPONSE_STORE_LEAD_MS,
  TERMINAL_ENVELOPE_RETENTION_MS,
  TOMBSTONE_FORBIDDEN_FIELDS,
  TOMBSTONE_RETAINED_FIELDS,
  TRUSTED_DISPATCH_ACTORS,
  abortDispatchOn,
  attestationRowDigest,
  claimParentGateOn,
  confirmDispatchCompletionOn,
  completeParentGateOn,
  defaultDispatchRandomBytes,
  dispatchOperationScope,
  dispatchPayloadDigest,
  fetchDispatchInputOn,
  fetchDispatchResultOn,
  inputCapabilityHash,
  invalidOutputDetailsOf,
  isAttestationTombstone,
  prepareDispatchOn,
  provenanceBindingOf,
  resultCapabilityHash,
  storeDispatchResultOn,
  sweepAttestationsOn,
  type AbortDispatchRequest,
  type AttestationBackend,
  type AttestationNamespace,
  type AttestationRow,
  type ConfirmDispatchCompletionRequest,
  type DispatchHandle,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
  type DispatchPrepared,
  type FetchDispatchResultRequest,
  type InputCapability,
  type LedgerBackend,
  type NativeCompletionProof,
  type PrepareDispatchOutcome,
  type PrepareDispatchRequest,
  type ResultCapability,
  type TrustedDispatchActor,
} from "@cq/config";

// ---------------------------------------------------------------------------
// What a backend must provide to be judged by this suite
// ---------------------------------------------------------------------------

export interface AttestationContractFixture {
  /** The primary handle over this fixture's durable location. */
  readonly backend: AttestationBackend;
  /** A SECOND handle over the SAME location — a peer process. */
  peer(): Promise<AttestationBackend>;
  /** Reopen the location from scratch — a restart. */
  restart(): Promise<AttestationBackend>;
  /** A handle over a DIFFERENT namespace at the SAME location. */
  sibling(projectKey: string): Promise<AttestationBackend>;
  /** Everything this namespace durably holds. */
  rows(): Promise<readonly AttestationRow[]>;
  /** Every persisted byte, for asserting what the store does NOT hold. */
  dump(): Promise<string>;
  /** The storage artifacts (tables / files) this namespace occupies. */
  artifacts(): Promise<readonly string[]>;
  /**
   * Make the backend genuinely unreachable OUT OF BAND — not by closing the
   * handle under test, which would only prove the `closed` flag works. Each
   * fixture drops the medium from underneath a live handle (the table, the
   * directory, an injected fault), so reads AND writes must fail explicitly.
   */
  breakBackend(): Promise<void>;
  /**
   * SYNCHRONOUSLY replace one row's durable revision WITHOUT taking the
   * namespace lock — an out-of-band writer, which is the only way the journal's
   * digest predicate can ever be reached.
   *
   * Present only where a backend can be written to synchronously AND its lock
   * does not exclude the writer: the filesystem store qualifies (a plain
   * `writeFileSync` ignores the lockfile) and so does the in-memory reference.
   * bun:sqlite's `BEGIN IMMEDIATE` excludes every other writer for the whole
   * unit of work, and PostgreSQL cannot be written to without awaiting, so the
   * hook is absent for both and their digest predicate is defence-in-depth that
   * no test can reach.
   */
  outOfBandReplaceSync?(row: AttestationRow): void;
  dispose(): Promise<void>;
}

export interface AttestationContractFactory {
  readonly name: string;
  /** The ledger backend the namespaces this fixture serves are keyed by. */
  readonly namespaceBackend: LedgerBackend;
  readonly skip?: boolean;
  build(projectKey: string): Promise<AttestationContractFixture>;
  /** Opening with wrong credentials / an unusable location must fail loudly. */
  openWithBadCredentials?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Fixed inputs
// ---------------------------------------------------------------------------

/** Every `Object.prototype` property name a naive membership test admits. */
export const PROTOTYPE_NAMES = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
] as const;

const T0 = "2026-07-27T09:00:00.000Z";
const PROMPT_DIGEST = "a".repeat(64);
const CATALOG_HASH = "b".repeat(64);
const TIMEOUT_MS = 600_000;
// bun's 5 s default per-test timeout bound the 12-round sweep loop below its
// needs under full-gate parallel load (D278 — observed 5683 ms). Only the
// wall-clock budget is generous here; the boundedness assertions stay exact.
const STORAGE_SWEEP_TEST_TIMEOUT_MS = 60_000;
const CHILD = { childId: "child-t720", runId: "run-0001" } as const;
const INPUT_MARKER = "input-marker-64bf13";

const INPUT: DispatchJSONValue = {
  taskId: "T720",
  headline: "Implement namespaced production AttestationStore adapters",
  description: `One shared adapter contract over three production stores (${INPUT_MARKER}).`,
  acceptance: "The abstract suite passes against every backend.",
  worktreePath: "/tmp/wt-T720",
  branch: "implement/T720",
  baseCommit: "8a8f94424a3eda1c2cb3aa1b0ccd47d5eca4ea2e",
  round: 0,
  startingCommit: "8a8f94424a3eda1c2cb3aa1b0ccd47d5eca4ea2e",
};

/**
 * A marker that appears in the OUTPUT and nowhere else, so a raw storage dump
 * (and any returned surface) can be searched for it.
 */
const OUTPUT_MARKER = "output-marker-8f2c1d";

const OUTPUT: DispatchJSONValue = {
  taskId: "T720",
  status: "pass",
  resultCommit: "8a8f94424a3eda1c2cb3aa1b0ccd47d5eca4ea2e",
  branch: "implement/T720",
  actualWorktreePath: "/tmp/wt-actual",
  filesTouched: ["packages/cq-config/src/dispatchAttestationBackend.ts"],
  checkSummary: "adapters green",
  summary: `Adapters landed (${OUTPUT_MARKER}).`,
  gateDurationMs: 1,
  baseVerification: {
    status: "verified",
    relation: "descendant",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
  },
};

const PARENT_GATE_BINDING: DispatchGitEffectBinding = Object.freeze({
  taskId: "T720",
  handleToken: "server-held-worktree-handle",
  handleFingerprint: "d".repeat(64),
  repositoryRoot: "/repo",
  repositoryId: "e".repeat(64),
  commonDir: "/repo/.git",
  worktreePath: "/repo/.claude/worktrees/T720",
  branch: "implement/T720",
  ref: "refs/heads/implement/T720",
  baseCommit: "8a8f94424a3eda1c2cb3aa1b0ccd47d5eca4ea2e",
});

const PARENT_GATE_STAGED_OUTPUT: DispatchJSONValue = {
  taskId: "T720",
  status: "pass",
  resultCommit: "b".repeat(40),
  branch: "implement/T720",
  actualWorktreePath: "/repo/.claude/worktrees/T720",
  filesTouched: ["packages/cq-config/src/dispatchAttestation.ts"],
  checkSummary: "focused checks pass",
  summary: "Ready for the parent-owned gate.",
  baseVerification: {
    status: "verified",
    relation: "descendant",
    baseCommit: "8a8f94424a3eda1c2cb3aa1b0ccd47d5eca4ea2e",
    headCommit: "b".repeat(40),
  },
};

function parentGateFinalOutput(p: DispatchPrepared): DispatchJSONValue {
  return {
    ...(PARENT_GATE_STAGED_OUTPUT as Readonly<Record<string, DispatchJSONValue>>),
    supervisedGateEvidence: {
      kind: "cq-supervised-gate-evidence",
      version: 1,
      attestationId: p.attestationId,
      generation: p.generation,
      roleId: "implement-worker",
      roleVersion: p.promptProvenance.version,
      surface: "codex",
      promptDigest: p.promptProvenance.promptDigest,
      catalogHash: p.promptProvenance.catalogHash,
      inputDigest: p.promptProvenance.inputDigest,
      taskId: "T720",
      worktreePath: "/repo/.claude/worktrees/T720",
      branch: "implement/T720",
      baseCommit: "8a8f94424a3eda1c2cb3aa1b0ccd47d5eca4ea2e",
      startingCommit: "8a8f94424a3eda1c2cb3aa1b0ccd47d5eca4ea2e",
      resultCommit: "b".repeat(40),
      clean: true,
      command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
      gateExitCode: 0,
      passCount: 1,
      failCount: 0,
      gateDurationMs: 1,
      capturedAt: T0,
      filesTouchedDigest: "f".repeat(64),
      gitReceiptsDigest: "0".repeat(64),
      mutationTableDigest: "1".repeat(64),
    },
  };
}

const OTHER_OUTPUT: DispatchJSONValue = {
  ...(OUTPUT as object),
  status: "fail",
  blockedReason: "a different result entirely",
} as DispatchJSONValue;

const INVALID_OUTPUT: DispatchJSONValue = { taskId: "T720", status: "maybe" };

function completion(overrides: Partial<NativeCompletionProof> = {}): NativeCompletionProof {
  return {
    kind: "native-completion",
    actor: "trusted-parent",
    childId: CHILD.childId,
    runId: CHILD.runId,
    completedAt: "2026-07-27T09:05:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A driver over one backend
// ---------------------------------------------------------------------------

/**
 * Drives one backend through the ref-first lifecycle. Entropy is REAL
 * (`defaultDispatchRandomBytes`) so two handles over one location never mint a
 * colliding id; only the CLOCK is faked, because only time is asserted.
 */
export class AttestationDriver {
  constructor(
    readonly backend: AttestationBackend,
    readonly clock: FakeDispatchClock,
  ) {}

  get namespace(): AttestationNamespace {
    return this.backend.namespace;
  }

  request(overrides: Readonly<Record<string, unknown>> = {}): PrepareDispatchRequest {
    return {
      namespace: this.namespace,
      roleId: "implement-worker",
      surface: "claude",
      input: INPUT,
      idempotencyKey: "T720-round-0",
      timeoutMs: TIMEOUT_MS,
      registry: DISPATCH_OVERLAY_REGISTRY,
      promptDigest: PROMPT_DIGEST,
      catalogHash: CATALOG_HASH,
      expectedChild: CHILD,
      ...overrides,
    } as PrepareDispatchRequest;
  }

  prepareOutcome(
    overrides: Readonly<Record<string, unknown>> = {},
  ): Promise<PrepareDispatchOutcome> {
    return prepareDispatchOn(this.backend, this.request(overrides), {
      now: this.clock.now,
      randomBytes: defaultDispatchRandomBytes,
    });
  }

  async prepare(overrides: Readonly<Record<string, unknown>> = {}): Promise<DispatchPrepared> {
    const outcome = await this.prepareOutcome(overrides);
    if (!outcome.accepted) {
      throw new Error(`expected a prepared dispatch, got ${outcome.reason}: ${outcome.detail}`);
    }
    return outcome.prepared;
  }

  store(capability: ResultCapability, output: DispatchJSONValue = OUTPUT) {
    return storeDispatchResultOn(
      this.backend,
      { resultCapability: capability, output },
      { now: this.clock.now },
    );
  }

  fetchInput(
    p: DispatchPrepared,
    capability: InputCapability = p.inputCapability,
    namespace: AttestationNamespace = this.namespace,
  ) {
    return fetchDispatchInputOn(
      this.backend,
      {
        namespace,
        ...handleOf(p),
        inputCapability: capability,
      },
      { now: this.clock.now },
    );
  }

  confirm(p: DispatchPrepared, overrides: Partial<ConfirmDispatchCompletionRequest> = {}) {
    return confirmDispatchCompletionOn(
      this.backend,
      {
        namespace: this.namespace,
        attestationId: p.attestationId,
        generation: p.generation,
        nativeCompletion: completion(),
        expectedProvenance: provenanceBindingOf(p),
        ...overrides,
      },
      { now: this.clock.now },
    );
  }

  abort(p: DispatchPrepared, overrides: Partial<AbortDispatchRequest> = {}) {
    return abortDispatchOn(
      this.backend,
      {
        namespace: this.namespace,
        attestationId: p.attestationId,
        generation: p.generation,
        actor: "trusted-parent",
        reason: "cancelled",
        ...overrides,
      },
      { now: this.clock.now },
    );
  }

  /** D174: fetch carries the namespace it claims AND the actor performing it. */
  fetchRequest(
    handle: DispatchHandle,
    overrides: Partial<FetchDispatchResultRequest> = {},
  ): FetchDispatchResultRequest {
    return {
      namespace: this.namespace,
      attestationId: handle.attestationId,
      generation: handle.generation,
      actor: "trusted-parent",
      ...overrides,
    };
  }

  fetch(handle: DispatchHandle, overrides: Partial<FetchDispatchResultRequest> = {}) {
    return fetchDispatchResultOn(this.backend, this.fetchRequest(handle, overrides), {
      now: this.clock.now,
    });
  }

  sweep() {
    return sweepAttestationsOn(this.backend, { now: this.clock.now });
  }
}

export function handleOf(p: DispatchPrepared): DispatchHandle {
  return { attestationId: p.attestationId, generation: p.generation };
}

let projectCounter = 0;

/** A fresh project key per case, so no two cases share durable rows. */
function nextProjectKey(prefix: string): string {
  projectCounter += 1;
  return `${prefix}-${String(projectCounter)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function settle<T>(
  operation: () => Promise<T>,
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
> {
  return operation().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export function runAttestationStoreContract(factory: AttestationContractFactory): void {
  const suite = factory.skip === true ? describe.skip : describe;
  const keyPrefix = `t720-${factory.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  interface Case {
    readonly fixture: AttestationContractFixture;
    readonly driver: AttestationDriver;
    readonly clock: FakeDispatchClock;
  }

  async function withCase(run: (c: Case) => Promise<void>): Promise<void> {
    const fixture = await factory.build(nextProjectKey(keyPrefix));
    const clock = new FakeDispatchClock(T0);
    try {
      await run({ fixture, driver: new AttestationDriver(fixture.backend, clock), clock });
    } finally {
      await fixture.dispose();
    }
  }

  suite(`AttestationStore contract — ${factory.name}`, () => {
    // -- the happy path, durably ------------------------------------------
    test("prepared -> result-stored -> consumed survives a restart at every step", () =>
      withCase(async ({ fixture, driver, clock }) => {
        const p = await driver.prepare();
        expect(await fixture.rows()).toHaveLength(1);

        const afterPrepare = new AttestationDriver(await fixture.restart(), clock);
        expect((await afterPrepare.fetch(handleOf(p))).state).toBe("prepared");

        const stored = await afterPrepare.store(p.resultCapability);
        expect(stored.state).toBe("result-stored");

        // A restart AFTER result storage still authorizes the ORIGINAL
        // capability: the store holds its hash, never its token.
        const afterStore = new AttestationDriver(await fixture.restart(), clock);
        expect((await afterStore.fetch(handleOf(p))).state).toBe("result-stored");
        const idempotent = await afterStore.store(p.resultCapability);
        expect(idempotent.state).toBe("result-stored");

        const consumed = await afterStore.confirm(p);
        expect(consumed.state).toBe("consumed");
        if (consumed.state !== "consumed") throw new Error("unreachable");
        // D173: confirm's ack is HANDLE-ONLY. It binds the promotion to the
        // payload by DIGEST; the body arrives on the one authorized read.
        expect(consumed.result.outputDigest).toBe(dispatchPayloadDigest(OUTPUT));
        expect(Object.keys(consumed.result).sort()).toEqual([
          "attestationId",
          "consumedAt",
          "generation",
          "outputDigest",
          "state",
        ]);

        const afterConsume = new AttestationDriver(await fixture.restart(), clock);
        const fetched = await afterConsume.fetch(handleOf(p));
        expect(fetched.state).toBe("consumed");
        if (fetched.state !== "consumed") throw new Error("unreachable");
        expect(fetched.output).toEqual(OUTPUT);
        expect(fetched.promptProvenance.inputDigest).toBe(p.promptProvenance.inputDigest);
        expect(fetched.nativeCompletion.childId).toBe(CHILD.childId);
      }));

    test("parent-owned gate staging, reclaim, stale-epoch refusal, and exact replay survive restarts", () =>
      withCase(async ({ fixture, driver, clock }) => {
        const p = await driver.prepare({
          surface: "codex",
          gitEffectBinding: PARENT_GATE_BINDING,
        });
        if (p.parentGateCapability === undefined) {
          throw new Error("Codex worker prepare omitted parent gate authority");
        }
        expect(await fixture.dump()).not.toContain(p.parentGateCapability.token);
        await driver.fetchInput(p);
        const staged = await driver.store(p.resultCapability, PARENT_GATE_STAGED_OUTPUT);
        expect(staged.state).toBe("gate-pending");
        const beforeForgery = (await fixture.rows()).map(attestationRowDigest);
        await expect(
          claimParentGateOn(
            driver.backend,
            {
              ...handleOf(p),
              parentGateCapability: {
                scope: "parent-gate",
                token: `cq_parent_gate_${"Z".repeat(43)}`,
              },
            },
            { now: clock.now },
          ),
        ).rejects.toThrow(DispatchAuthorizationError);
        expect((await fixture.rows()).map(attestationRowDigest)).toEqual(beforeForgery);

        const afterStage = new AttestationDriver(await fixture.restart(), clock);
        expect((await afterStage.fetch(handleOf(p))).state).toBe("gate-pending");
        expect(await afterStage.store(p.resultCapability, PARENT_GATE_STAGED_OUTPUT)).toEqual(
          staged,
        );
        const first = await claimParentGateOn(
          afterStage.backend,
          { ...handleOf(p), parentGateCapability: p.parentGateCapability },
          { now: clock.now },
        );
        if (first.state !== "gate-running") throw new Error("expected first gate claim");

        const afterCrash = new AttestationDriver(await fixture.restart(), clock);
        expect((await afterCrash.fetch(handleOf(p))).state).toBe("gate-running");
        const reclaimed = await claimParentGateOn(
          afterCrash.backend,
          { ...handleOf(p), parentGateCapability: p.parentGateCapability },
          { now: clock.now },
        );
        if (reclaimed.state !== "gate-running") throw new Error("expected reclaimed gate");
        expect(reclaimed.gateEpoch).toBe(first.gateEpoch + 1);

        const output = parentGateFinalOutput(p);
        await expect(
          completeParentGateOn(
            afterCrash.backend,
            {
              ...handleOf(p),
              parentGateCapability: p.parentGateCapability,
              gateEpoch: first.gateEpoch,
              output,
            },
            { now: clock.now },
          ),
        ).rejects.toThrow(DispatchStateConflictError);
        const completed = await completeParentGateOn(
          afterCrash.backend,
          {
            ...handleOf(p),
            parentGateCapability: p.parentGateCapability,
            gateEpoch: reclaimed.gateEpoch,
            output,
          },
          { now: clock.now },
        );
        await expect(
          completeParentGateOn(
            afterCrash.backend,
            {
              ...handleOf(p),
              parentGateCapability: p.parentGateCapability,
              gateEpoch: first.gateEpoch,
              output,
            },
            { now: clock.now },
          ),
        ).rejects.toThrow(DispatchStateConflictError);
        const replayed = await completeParentGateOn(
          afterCrash.backend,
          {
            ...handleOf(p),
            parentGateCapability: p.parentGateCapability,
            gateEpoch: reclaimed.gateEpoch,
            output,
          },
          { now: clock.now },
        );
        expect(replayed).toEqual(completed);
        const afterComplete = new AttestationDriver(await fixture.restart(), clock);
        expect((await afterComplete.fetch(handleOf(p))).state).toBe("result-stored");
        expect(await afterComplete.store(p.resultCapability, PARENT_GATE_STAGED_OUTPUT)).toEqual(
          staged,
        );
        await expect(afterComplete.abort(p, { reason: "native-failure" })).rejects.toThrow(
          DispatchStateConflictError,
        );
        expect((await afterComplete.fetch(handleOf(p))).state).toBe("result-stored");
      }));

    // -- every abort path --------------------------------------------------
    test("every explicit abort reason wins from prepared and is terminal", () =>
      withCase(async ({ fixture, driver }) => {
        for (const reason of [
          "cancelled",
          "native-failure",
          "protocol-violation",
          "parent-lost",
        ] as const) {
          const p = await driver.prepare({ idempotencyKey: `key-${reason}` });
          const aborted = await driver.abort(p, { reason, details: { note: reason } });
          expect(aborted.reason).toBe(reason);
          // An IDENTICAL retry is idempotent; a different body conflicts.
          expect((await driver.abort(p, { reason, details: { note: reason } })).abortedAt).toBe(
            aborted.abortedAt,
          );
          await expect(driver.abort(p, { reason, details: { note: "other" } })).rejects.toThrow(
            DispatchStateConflictError,
          );
          // A confirmation can never promote an aborted record, whatever completed.
          await expect(driver.confirm(p)).rejects.toThrow(DispatchStateConflictError);
        }
        expect(await fixture.rows()).toHaveLength(4);
      }));

    test("invalid output aborts atomically — no revision is ever result-stored", () =>
      withCase(async ({ fixture, driver }) => {
        const p = await driver.prepare();
        const outcome = await driver.store(p.resultCapability, INVALID_OUTPUT);
        expect(outcome.state).toBe("aborted");
        if (outcome.state !== "aborted") throw new Error("unreachable");
        expect(outcome.result.reason).toBe("invalid-output");
        const details = invalidOutputDetailsOf(outcome.result);
        expect(details?.errors.length).toBeGreaterThan(0);
        expect(details?.roleId).toBe("implement-worker");
        // The DURABLE row went straight from prepared to aborted; the invalid
        // output was never persisted at all.
        const [row] = await fixture.rows();
        if (row === undefined || isAttestationTombstone(row)) throw new Error("expected envelope");
        expect(row.state).toBe("aborted");
        expect(row.output).toBeUndefined();
        expect(await fixture.dump()).not.toContain('"maybe"');
      }));

    test("a native completion with no stored result aborts missing-result", () =>
      withCase(async ({ driver }) => {
        const p = await driver.prepare();
        const outcome = await driver.confirm(p);
        expect(outcome.state).toBe("aborted");
        if (outcome.state !== "aborted") throw new Error("unreachable");
        expect(outcome.result.reason).toBe("missing-result");
      }));

    test("a submission after childCancelAt aborts deadline-exceeded", () =>
      withCase(async ({ driver, clock }) => {
        const p = await driver.prepare();
        clock.set(p.childCancelAt).advance(1);
        const outcome = await driver.store(p.resultCapability);
        expect(outcome.state).toBe("aborted");
        if (outcome.state !== "aborted") throw new Error("unreachable");
        expect(outcome.result.reason).toBe("deadline-exceeded");
      }));

    test("cancellation after a stored result is terminal and blocks a later confirm", () =>
      withCase(async ({ fixture, driver }) => {
        const p = await driver.prepare();
        expect((await driver.store(p.resultCapability)).state).toBe("result-stored");
        const aborted = await driver.abort(p, { reason: "cancelled" });
        expect(aborted.reason).toBe("cancelled");
        await expect(driver.confirm(p)).rejects.toThrow(DispatchStateConflictError);
        // The stored output stays VISIBLE for the 24h envelope but is not
        // consumable: only `consumed` carries output out of a fetch.
        const fetched = await driver.fetch(handleOf(p));
        expect(fetched.state).toBe("aborted");
        expect(Object.hasOwn(fetched, "output")).toBe(false);
        const [row] = await fixture.rows();
        if (row === undefined || isAttestationTombstone(row)) throw new Error("expected envelope");
        expect(row.output).toEqual(OUTPUT);
      }));

    // -- capability scope --------------------------------------------------
    test("a capability stolen from another project resolves nothing", () =>
      withCase(async ({ fixture, driver, clock }) => {
        const mine = await driver.prepare();
        const other = new AttestationDriver(
          await fixture.sibling(nextProjectKey(`${keyPrefix}-other`)),
          clock,
        );
        const theirs = await other.prepare({ idempotencyKey: "T720-other" });

        // Cross-project in BOTH directions: neither namespace can resolve the
        // other's capability even though both live at one location.
        await expect(driver.store(theirs.resultCapability)).rejects.toThrow(
          DispatchAuthorizationError,
        );
        await expect(other.store(mine.resultCapability)).rejects.toThrow(
          DispatchAuthorizationError,
        );
        await expect(driver.fetchInput(mine, theirs.inputCapability)).rejects.toThrow(
          DispatchAuthorizationError,
        );
        await expect(other.fetchInput(theirs, mine.inputCapability)).rejects.toThrow(
          DispatchAuthorizationError,
        );
        // …and neither can even see the other's handle.
        expect((await driver.fetch(handleOf(theirs))).state).toBe("attestation-not-found");
        expect((await other.fetch(handleOf(mine))).state).toBe("attestation-not-found");
      }));

    test("a capability bound to a sibling attestation cannot store this one's result", () =>
      withCase(async ({ driver }) => {
        const first = await driver.prepare({ idempotencyKey: "key-first" });
        const second = await driver.prepare({ idempotencyKey: "key-second" });
        await expect(driver.fetchInput(first, second.inputCapability)).rejects.toThrow(
          DispatchAuthorizationError,
        );
        await driver.store(second.resultCapability);
        // `first` is untouched: a capability resolves exactly ONE record.
        expect((await driver.fetch(handleOf(first))).state).toBe("prepared");
        expect((await driver.fetch(handleOf(second))).state).toBe("result-stored");
      }));

    test("assembled input materializes once across restart, then the durable marker refuses it", () =>
      withCase(async ({ fixture, driver, clock }) => {
        const p = await driver.prepare();
        const afterPrepare = new AttestationDriver(await fixture.restart(), clock);
        const first = await afterPrepare.fetchInput(p);
        expect(first.input).toEqual(INPUT);
        expect(first.promptProvenance).toEqual(p.promptProvenance);
        expect(JSON.stringify(first)).toContain(INPUT_MARKER);
        expect(JSON.stringify(first)).not.toContain(p.inputCapability.token);

        const afterMaterialize = new AttestationDriver(await fixture.restart(), clock);
        await expect(afterMaterialize.fetchInput(p)).rejects.toThrow(
          DispatchStateConflictError,
        );
        const dump = await fixture.dump();
        expect(dump).not.toContain(p.inputCapability.token);
        expect(dump).toContain(inputCapabilityHash(p.inputCapability.token));
      }));

    test("a different-output retry conflicts; an identical retry is idempotent", () =>
      withCase(async ({ driver }) => {
        const p = await driver.prepare();
        const first = await driver.store(p.resultCapability);
        if (first.state !== "result-stored") throw new Error("unreachable");
        const again = await driver.store(p.resultCapability);
        if (again.state !== "result-stored") throw new Error("unreachable");
        expect(again.result.storedAt).toBe(first.result.storedAt);
        expect(again.result.outputDigest).toBe(first.result.outputDigest);
        await expect(driver.store(p.resultCapability, OTHER_OUTPUT)).rejects.toThrow(
          DispatchStateConflictError,
        );
        // The conflict changed nothing.
        expect((await driver.fetch(handleOf(p))).state).toBe("result-stored");
      }));

    // -- generations -------------------------------------------------------
    test("a stale generation is unreachable while its successor is live", () =>
      withCase(async ({ driver }) => {
        const first = await driver.prepare({ idempotencyKey: "key-gen-1" });
        await driver.abort(first, { reason: "native-failure" });
        const second = await driver.prepare({
          idempotencyKey: "key-gen-2",
          reprepareOf: handleOf(first),
        });
        expect(second.generation).toBe(first.generation + 1);
        expect(second.attestationId).toBe(first.attestationId);

        // The OLD generation keeps its own terminal answer, and its capability
        // is dead: the new generation minted a new one.
        expect((await driver.fetch(handleOf(first))).state).toBe("aborted");
        await expect(driver.store(first.resultCapability)).rejects.toThrow(
          DispatchStateConflictError,
        );
        expect((await driver.store(second.resultCapability)).state).toBe("result-stored");
        // A generation that never existed is not-found, not an error.
        expect(
          (await driver.fetch({ attestationId: second.attestationId, generation: 9 })).state,
        ).toBe("attestation-not-found");
      }));

    test("re-preparing a LIVE generation is refused", () =>
      withCase(async ({ driver }) => {
        const first = await driver.prepare({ idempotencyKey: "key-live" });
        await expect(
          driver.prepareOutcome({ idempotencyKey: "key-live-2", reprepareOf: handleOf(first) }),
        ).rejects.toThrow(DispatchStateConflictError);
      }));

    // -- completion binding ------------------------------------------------
    test("a mismatched child, run or provenance can never promote a stored result", () =>
      withCase(async ({ driver }) => {
        const p = await driver.prepare();
        await driver.store(p.resultCapability);

        await expect(
          driver.confirm(p, { nativeCompletion: completion({ childId: "someone-else" }) }),
        ).rejects.toThrow(AttestationBindingError);
        await expect(
          driver.confirm(p, { nativeCompletion: completion({ runId: "run-9999" }) }),
        ).rejects.toThrow(AttestationBindingError);
        for (const field of ["roleId", "version", "promptDigest", "inputDigest"] as const) {
          const bound = provenanceBindingOf(p);
          await expect(
            driver.confirm(p, {
              expectedProvenance: {
                ...bound,
                [field]: field === "version" ? bound.version + 1 : "not-the-bound-value",
              },
            }),
          ).rejects.toThrow(AttestationBindingError);
        }
        // An untrusted actor cannot claim a completion at all.
        await expect(
          driver.confirm(p, {
            nativeCompletion: completion({ actor: "child" as never }),
          }),
        ).rejects.toThrow(DispatchAuthorizationError);
        // Still exactly `result-stored` after every refusal.
        expect((await driver.fetch(handleOf(p))).state).toBe("result-stored");
        expect((await driver.confirm(p)).state).toBe("consumed");
      }));

    test("an identical confirmation is idempotent; a different proof conflicts", () =>
      withCase(async ({ driver }) => {
        const p = await driver.prepare();
        await driver.store(p.resultCapability);
        const first = await driver.confirm(p);
        if (first.state !== "consumed") throw new Error("unreachable");
        const again = await driver.confirm(p);
        if (again.state !== "consumed") throw new Error("unreachable");
        expect(again.result.consumedAt).toBe(first.result.consumedAt);
        await expect(
          driver.confirm(p, {
            nativeCompletion: completion({ completedAt: "2026-07-27T09:06:00.000Z" }),
          }),
        ).rejects.toThrow(DispatchStateConflictError);
      }));

    // -- one-copy fetch ----------------------------------------------------
    test("a fetch hands out one frozen copy, then only the materialization marker", () =>
      withCase(async ({ fixture, driver }) => {
        const p = await driver.prepare();
        await driver.store(p.resultCapability);
        await driver.confirm(p);
        const first = await driver.fetch(handleOf(p));
        if (first.state !== "consumed") throw new Error("unreachable");
        expect(Object.isFrozen(first)).toBe(true);
        // Writing to the delivered result must not reach storage, whether it
        // throws (frozen) or is silently dropped.
        try {
          (first as unknown as Record<string, unknown>)["output"] = { tampered: true };
        } catch {
          // A frozen result refuses the write outright.
        }
        const second = await driver.fetch(handleOf(p));
        expect(second.state).toBe("output-already-materialized");
        expect(JSON.stringify(second)).not.toContain(OUTPUT_MARKER);
        // Exactly ONE copy of the output is persisted, in the attestation row.
        const dump = await fixture.dump();
        expect(dump.split(OUTPUT_MARKER)).toHaveLength(2);
      }));

    // -- D173: what each returned surface must NOT contain ------------------
    test("only fetch-after-confirm carries the body; no surface carries the token", () =>
      withCase(async ({ fixture, driver }) => {
        const p = await driver.prepare();
        const token = p.resultCapability.token;
        const inputToken = p.inputCapability.token;

        const materializedInput = await driver.fetchInput(p);
        const stored = await driver.store(p.resultCapability);
        const beforeConfirm = await driver.fetch(handleOf(p));
        const confirmed = await driver.confirm(p);
        const afterConfirm = await driver.fetch(handleOf(p));
        const report = await driver.sweep();
        const aborted = await settle(() => driver.abort(p));

        // `prepared` is the ONE surface that legitimately carries the raw
        // capabilities: they are minted there and handed to the parent to pass
        // on. Everything else must carry neither token.
        const preparedJson = JSON.stringify(p);
        expect(preparedJson.split(token)).toHaveLength(2);
        expect(preparedJson.split(inputToken)).toHaveLength(2);
        expect(preparedJson).not.toContain(OUTPUT_MARKER);
        expect(preparedJson).not.toContain(INPUT_MARKER);
        expect(JSON.stringify(materializedInput)).toContain(INPUT_MARKER);

        const surfaces: Readonly<Record<string, unknown>> = {
          materializedInput,
          storeAck: stored,
          fetchResultStored: beforeConfirm,
          confirmAck: confirmed,
          sweepReport: report,
          abortConflict: aborted.ok ? aborted.value : String(aborted.error),
        };
        for (const [name, surface] of Object.entries(surfaces)) {
          expect(JSON.stringify(surface) ?? "", `${name} must not carry the body`).not.toContain(
            OUTPUT_MARKER,
          );
          expect(JSON.stringify(surface) ?? "", `${name} must not carry the token`).not.toContain(
            token,
          );
          expect(
            JSON.stringify(surface) ?? "",
            `${name} must not carry the input token`,
          ).not.toContain(inputToken);
        }
        // The ONE authorized read does carry it — and nothing else does.
        expect(JSON.stringify(afterConfirm)).toContain(OUTPUT_MARKER);
        expect(JSON.stringify(afterConfirm)).not.toContain(token);
        // The mandatory promotion surface stays strictly smaller than the one
        // authorized read: an independent signal from the marker check.
        expect(JSON.stringify(confirmed).length).toBeLessThan(JSON.stringify(afterConfirm).length);

        // The store holds the HASH, so the record stays resolvable without the
        // token ever being persisted.
        const dump = await fixture.dump();
        expect(dump).not.toContain(token);
        expect(dump).not.toContain(inputToken);
        expect(dump).toContain(resultCapabilityHash(token));
        expect(dump).toContain(inputCapabilityHash(inputToken));
        expect(JSON.stringify(await fixture.rows())).not.toContain(token);
        expect(JSON.stringify(await fixture.rows())).not.toContain(inputToken);
      }));

    // -- D174: every DECLARED trusted-parent scope is really enforced -------
    test("every trusted-parent operation rejects a FOREIGN namespace through the backend", () =>
      withCase(async ({ driver }) => {
        const foreign: AttestationNamespace = {
          backend: factory.namespaceBackend,
          projectKey: "someone-elses-project",
        };
        const p = await driver.prepare();
        await driver.store(p.resultCapability);

        const probes = new Map<string, () => Promise<unknown>>([
          [
            "prepare_dispatch",
            () => driver.prepareOutcome({ namespace: foreign, idempotencyKey: "ns" }),
          ],
          ["confirm_dispatch_completion", () => driver.confirm(p, { namespace: foreign })],
          ["abort_dispatch", () => driver.abort(p, { namespace: foreign })],
          ["fetch_dispatch_result", () => driver.fetch(handleOf(p), { namespace: foreign })],
        ]);
        const trusted = DISPATCH_PROTOCOL_OPERATIONS.filter(
          (operation) => dispatchOperationScope(operation) === "trusted-parent",
        );
        expect(trusted.length).toBeGreaterThan(0);
        for (const operation of trusted) {
          const probe = probes.get(operation);
          expect(probe, `no foreign-namespace probe for "${operation}"`).toBeDefined();
          const settled = await settle(probe!);
          expect(settled.ok, operation).toBe(false);
          if (settled.ok) throw new Error("unreachable");
          expect(settled.error, operation).toBeInstanceOf(AttestationNamespaceError);
        }
      }));

    test("every trusted-parent operation on an EXISTING record rejects an untrusted actor", () =>
      withCase(async ({ driver }) => {
        // prepare_dispatch is excluded BY DESIGN: it creates the record, so
        // there is no prior actor binding to verify. Everything that touches an
        // existing record must verify one, or the declared scope is decoration.
        const p = await driver.prepare();
        await driver.store(p.resultCapability);
        for (const actor of [...PROTOTYPE_NAMES, "", "parent", "child"]) {
          await expect(
            driver.confirm(p, {
              nativeCompletion: completion({ actor: actor as TrustedDispatchActor }),
            }),
            `confirm/${actor}`,
          ).rejects.toThrow(DispatchAuthorizationError);
          await expect(
            driver.abort(p, { actor: actor as TrustedDispatchActor }),
            `abort/${actor}`,
          ).rejects.toThrow(DispatchAuthorizationError);
          await expect(
            driver.fetch(handleOf(p), { actor: actor as TrustedDispatchActor }),
            `fetch/${actor}`,
          ).rejects.toThrow(DispatchAuthorizationError);
        }
        // Every legitimately trusted actor still reads.
        for (const actor of TRUSTED_DISPATCH_ACTORS) {
          expect((await driver.fetch(handleOf(p), { actor })).state).toBe("result-stored");
        }
      }));

    // -- explicit backend / auth failures ----------------------------------
    test("an unreachable backend is an explicit error, never a lifecycle answer", () =>
      withCase(async ({ fixture, driver }) => {
        const p = await driver.prepare();
        await fixture.breakBackend();
        const operations: readonly (readonly [string, () => Promise<unknown>])[] = [
          ["fetch", () => driver.fetch(handleOf(p))],
          ["store", () => driver.store(p.resultCapability)],
          ["confirm", () => driver.confirm(p)],
          ["abort", () => driver.abort(p)],
          ["sweep", () => driver.sweep()],
          ["prepare", () => driver.prepareOutcome({ idempotencyKey: "after-break" })],
        ];
        for (const [name, operation] of operations) {
          const settled = await settle(operation);
          expect(settled.ok, name).toBe(false);
          if (settled.ok) throw new Error("unreachable");
          expect(
            settled.error instanceof AttestationTransportError ||
              settled.error instanceof AttestationStorageError,
            `${name}: ${String(settled.error)}`,
          ).toBe(true);
        }
      }));

    if (factory.openWithBadCredentials !== undefined) {
      const openWithBadCredentials = factory.openWithBadCredentials.bind(factory);
      test("opening with unusable credentials fails at open, not at a dispatch", async () => {
        await expect(openWithBadCredentials()).rejects.toThrow();
      });
    }

    // -- exact phase boundaries --------------------------------------------
    test("the launch deadline and the child deadlines are exact", () =>
      withCase(async ({ clock, driver }) => {
        const at = clock.epochMs;
        const p = await driver.prepare();
        expect(Date.parse(p.launchDeadline) - at).toBe(LAUNCH_DEADLINE_MS);
        expect(Date.parse(p.childCancelAt) - at).toBe(TIMEOUT_MS);
        expect(Date.parse(p.childCancelAt) - Date.parse(p.responseStoreNow)).toBe(
          RESPONSE_STORE_LEAD_MS,
        );
        // A submission at EXACTLY childCancelAt is still in time; one 1ms later
        // is not (asserted by the deadline-exceeded case above).
        clock.set(p.childCancelAt);
        expect((await driver.store(p.resultCapability)).state).toBe("result-stored");
      }));

    test("the 24h envelope and 30d horizon boundaries are exact and need no sweep", () =>
      withCase(async ({ driver, clock }) => {
        const p = await driver.prepare();
        await driver.store(p.resultCapability);
        const consumed = await driver.confirm(p);
        if (consumed.state !== "consumed") throw new Error("unreachable");
        const terminalMs = Date.parse(consumed.result.consumedAt);

        clock.set(new Date(terminalMs + TERMINAL_ENVELOPE_RETENTION_MS - 1).toISOString());
        expect((await driver.fetch(handleOf(p))).state).toBe("consumed");

        // Exactly at +24h the envelope is expired — decided by the OPERATION,
        // with no sweep having run.
        clock.set(new Date(terminalMs + TERMINAL_ENVELOPE_RETENTION_MS).toISOString());
        const expired = await driver.fetch(handleOf(p));
        expect(expired.state).toBe("terminal-envelope-expired");
        if (expired.state !== "terminal-envelope-expired") throw new Error("unreachable");
        expect(expired.terminalKind).toBe("consumed");
        expect(Date.parse(expired.reuseAfter) - terminalMs).toBe(IDEMPOTENCY_HORIZON_MS);

        clock.set(new Date(terminalMs + IDEMPOTENCY_HORIZON_MS - 1).toISOString());
        expect((await driver.fetch(handleOf(p))).state).toBe("terminal-envelope-expired");
        clock.set(new Date(terminalMs + IDEMPOTENCY_HORIZON_MS).toISOString());
        expect((await driver.fetch(handleOf(p))).state).toBe("attestation-not-found");
      }));

    test("an expired envelope refuses store, confirm and abort explicitly", () =>
      withCase(async ({ driver, clock }) => {
        const p = await driver.prepare();
        await driver.store(p.resultCapability);
        const consumed = await driver.confirm(p);
        if (consumed.state !== "consumed") throw new Error("unreachable");
        clock.set(consumed.result.consumedAt).advance(TERMINAL_ENVELOPE_RETENTION_MS);
        await driver.sweep();
        await expect(driver.store(p.resultCapability)).rejects.toThrow(DispatchAuthorizationError);
        await expect(driver.confirm(p)).rejects.toThrow(DispatchStateConflictError);
        await expect(driver.abort(p)).rejects.toThrow(DispatchStateConflictError);
      }));

    // -- the sweep and its races -------------------------------------------
    test("a sweep collapses at exactly 24h, drops at exactly 30d, and is idempotent", () =>
      withCase(async ({ fixture, driver, clock }) => {
        const p = await driver.prepare();
        await driver.abort(p, { reason: "cancelled", details: { why: "no longer needed" } });
        const terminalMs = clock.epochMs;

        clock.set(new Date(terminalMs + TERMINAL_ENVELOPE_RETENTION_MS - 1).toISOString());
        expect((await driver.sweep()).envelopesCollapsed).toHaveLength(0);

        clock.set(new Date(terminalMs + TERMINAL_ENVELOPE_RETENTION_MS).toISOString());
        const collapse = await driver.sweep();
        expect(collapse.envelopesCollapsed).toHaveLength(1);
        expect(collapse.rowsRemaining).toBe(1);
        expect((await driver.sweep()).envelopesCollapsed).toHaveLength(0);

        clock.set(new Date(terminalMs + IDEMPOTENCY_HORIZON_MS - 1).toISOString());
        expect((await driver.sweep()).tombstonesRemoved).toHaveLength(0);
        clock.set(new Date(terminalMs + IDEMPOTENCY_HORIZON_MS).toISOString());
        const drop = await driver.sweep();
        expect(drop.tombstonesRemoved).toHaveLength(1);
        expect(drop.rowsRemaining).toBe(0);
        expect(await fixture.rows()).toHaveLength(0);
        expect((await driver.sweep()).tombstonesRemoved).toHaveLength(0);
      }));

    test("a collapsed tombstone retains exactly the minimal fields", () =>
      withCase(async ({ fixture, driver, clock }) => {
        const p = await driver.prepare();
        await driver.store(p.resultCapability);
        await driver.confirm(p);
        clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
        await driver.sweep();

        const [row] = await fixture.rows();
        if (row === undefined || !isAttestationTombstone(row)) {
          throw new Error("expected a tombstone");
        }
        expect(Object.keys(row).sort()).toEqual([...TOMBSTONE_RETAINED_FIELDS].sort());
        for (const forbidden of TOMBSTONE_FORBIDDEN_FIELDS) {
          expect(Object.hasOwn(row, forbidden), forbidden).toBe(false);
        }
        expect(row.inputDigest).toBe(p.promptProvenance.inputDigest);
        // The output, the capability hash and the completion proof are GONE from
        // storage, not merely hidden.
        const dump = await fixture.dump();
        expect(dump).not.toContain(OUTPUT_MARKER);
        expect(dump).not.toContain(resultCapabilityHash(p.resultCapability.token));
        expect(dump).not.toContain(CHILD.childId);
      }));

    test("cleanup versus store, confirm, fetch and retry", () =>
      withCase(async ({ driver, clock }) => {
        // The sweep runs FIRST at each boundary; every operation that follows
        // must give the same answer the operation-time check would have.
        const p = await driver.prepare();
        await driver.store(p.resultCapability);
        const consumed = await driver.confirm(p);
        if (consumed.state !== "consumed") throw new Error("unreachable");
        const terminalMs = Date.parse(consumed.result.consumedAt);

        clock.set(new Date(terminalMs + TERMINAL_ENVELOPE_RETENTION_MS).toISOString());
        await driver.sweep();
        // A capability retry after the collapse cannot resolve its record at all
        // (a tombstone keeps no capability hash), and a confirm/abort/fetch each
        // report the expiry rather than a wrong state.
        await expect(driver.store(p.resultCapability)).rejects.toThrow(DispatchAuthorizationError);
        await expect(driver.confirm(p)).rejects.toThrow(DispatchStateConflictError);
        await expect(driver.abort(p)).rejects.toThrow(DispatchStateConflictError);
        expect((await driver.fetch(handleOf(p))).state).toBe("terminal-envelope-expired");

        clock.set(new Date(terminalMs + IDEMPOTENCY_HORIZON_MS).toISOString());
        await driver.sweep();
        expect((await driver.fetch(handleOf(p))).state).toBe("attestation-not-found");
        await expect(driver.confirm(p)).rejects.toThrow(AttestationNotFoundError);
        await expect(driver.abort(p)).rejects.toThrow(AttestationNotFoundError);
      }));

    test("a restart after compaction and after tombstone deletion answers identically", () =>
      withCase(async ({ fixture, driver, clock }) => {
        const p = await driver.prepare();
        await driver.abort(p, { reason: "parent-lost" });
        const terminalMs = clock.epochMs;

        clock.set(new Date(terminalMs + TERMINAL_ENVELOPE_RETENTION_MS).toISOString());
        await driver.sweep();
        const afterCompaction = new AttestationDriver(await fixture.restart(), clock);
        expect((await afterCompaction.fetch(handleOf(p))).state).toBe("terminal-envelope-expired");

        clock.set(new Date(terminalMs + IDEMPOTENCY_HORIZON_MS).toISOString());
        await afterCompaction.sweep();
        const afterDeletion = new AttestationDriver(await fixture.restart(), clock);
        expect((await afterDeletion.fetch(handleOf(p))).state).toBe("attestation-not-found");
        // The key is reusable now that its tombstone is gone.
        const reused = await afterDeletion.prepare({ idempotencyKey: "T720-round-0" });
        expect(reused.attestationId).not.toBe(p.attestationId);
      }));

    test(
      "storage stays bounded across many swept dispatches",
      () =>
        withCase(async ({ fixture, driver, clock }) => {
          const rounds = 12;
          for (let round = 0; round < rounds; round += 1) {
            const p = await driver.prepare({ idempotencyKey: `bounded-${String(round)}` });
            await driver.store(p.resultCapability);
            await driver.confirm(p);
            // Each round advances a full horizon, so every prior round's tombstone
            // is droppable by the time this one goes terminal.
            clock.advance(IDEMPOTENCY_HORIZON_MS);
            await driver.sweep();
            // At most: this round's own terminal envelope. Nothing accumulates.
            expect((await fixture.rows()).length).toBeLessThanOrEqual(1);
          }
          clock.advance(IDEMPOTENCY_HORIZON_MS);
          await driver.sweep();
          expect(await fixture.rows()).toHaveLength(0);
        }),
      STORAGE_SWEEP_TEST_TIMEOUT_MS,
    );

    // -- key reuse ---------------------------------------------------------
    test("an idempotency key is held by a live row and by its tombstone", () =>
      withCase(async ({ driver, clock }) => {
        const p = await driver.prepare();
        // Live: refused.
        await expect(driver.prepareOutcome()).rejects.toThrow(AttestationKeyReuseError);
        await driver.abort(p, { reason: "cancelled" });
        const terminalMs = clock.epochMs;
        // Terminal but within the horizon: still refused.
        await expect(driver.prepareOutcome()).rejects.toThrow(AttestationKeyReuseError);
        clock.set(new Date(terminalMs + TERMINAL_ENVELOPE_RETENTION_MS).toISOString());
        await driver.sweep();
        await expect(driver.prepareOutcome()).rejects.toThrow(AttestationKeyReuseError);
        // At exactly the horizon the key is free again, sweep or no sweep.
        clock.set(new Date(terminalMs + IDEMPOTENCY_HORIZON_MS).toISOString());
        const reused = await driver.prepare();
        expect(reused.attestationId).not.toBe(p.attestationId);
      }));

    test("an UN-COLLAPSED terminal row releases its key at the horizon, with NO sweep", () =>
      withCase(async ({ fixture, driver, clock }) => {
        // The acceptance criterion's "operation-time checks independent of
        // sweeps", applied to the key: this record goes terminal and is NEVER
        // swept, so at +30d it is still physically an ENVELOPE rather than a
        // tombstone. `fetchDispatchResult` already answers `attestation-not-found`
        // for it, so the key must be free too — otherwise the record is gone
        // according to every lookup and present according to the store, until an
        // unrelated sweep happens to run. (Mutation M43.)
        const p = await driver.prepare({ idempotencyKey: "no-sweep-key" });
        await driver.abort(p, { reason: "cancelled" });
        const terminalMs = clock.epochMs;

        clock.set(new Date(terminalMs + IDEMPOTENCY_HORIZON_MS - 1).toISOString());
        const [beforeHorizon] = await fixture.rows();
        expect(beforeHorizon === undefined ? true : isAttestationTombstone(beforeHorizon)).toBe(
          false,
        );
        await expect(driver.prepareOutcome({ idempotencyKey: "no-sweep-key" })).rejects.toThrow(
          AttestationKeyReuseError,
        );

        clock.set(new Date(terminalMs + IDEMPOTENCY_HORIZON_MS).toISOString());
        expect((await driver.fetch(handleOf(p))).state).toBe("attestation-not-found");
        const reused = await driver.prepare({ idempotencyKey: "no-sweep-key" });
        expect(reused.attestationId).not.toBe(p.attestationId);
        // The expired row was RECLAIMED by the prepare that reused its key, so
        // storage did not simply grow a second row holding the same key.
        const rows = await fixture.rows();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.attestationId).toBe(reused.attestationId);
      }));

    test("two units of work racing one idempotency key produce exactly one winner", () =>
      withCase(async ({ fixture, driver }) => {
        // Issued CONCURRENTLY on one handle: the backend's unit-of-work
        // serialization decides them, so exactly one row can ever land. (The
        // cross-PROCESS form of this race, where the backend's own lock is the
        // only arbiter, is driven from spawned peers in the per-adapter suites.)
        const results = await Promise.allSettled([
          driver.prepareOutcome({ idempotencyKey: "raced" }),
          driver.prepareOutcome({ idempotencyKey: "raced" }),
        ]);
        const won = results.filter((r) => r.status === "fulfilled");
        const lost = results.filter((r) => r.status === "rejected");
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(AttestationStorageError);
        expect(await fixture.rows()).toHaveLength(1);
      }));

    test("a peer handle observes a committed transition immediately", () =>
      withCase(async ({ fixture, driver, clock }) => {
        const peer = new AttestationDriver(await fixture.peer(), clock);
        const p = await driver.prepare();
        expect((await peer.fetch(handleOf(p))).state).toBe("prepared");
        await driver.store(p.resultCapability);
        expect((await peer.fetch(handleOf(p))).state).toBe("result-stored");
        // …and the peer can carry the lifecycle forward from there.
        expect((await peer.confirm(p)).state).toBe("consumed");
        expect((await driver.fetch(handleOf(p))).state).toBe("consumed");
      }));

    // -- durable guards reached with the SERVICE OUT OF THE WAY -------------
    test("the STORE refuses a duplicate idempotency key the service never saw", () =>
      withCase(async ({ fixture, driver }) => {
        const p = await driver.prepare({ idempotencyKey: "held-key" });
        const [existing] = await fixture.rows();
        if (existing === undefined || isAttestationTombstone(existing)) {
          throw new Error("expected an envelope");
        }
        // The unit of work loads ONLY rows holding "unrelated-key", so the
        // service-side reuse check cannot see the conflict — the only thing left
        // to refuse this insert is the STORE's own durable guard.
        await expect(
          fixture.backend.transact(
            { kind: "prepare", idempotencyKey: "unrelated-key" },
            (store) => {
              store.insert({
                ...existing,
                attestationId: `${existing.attestationId}x`,
                generation: 1,
                resultCapabilityHash: "c".repeat(64),
              });
            },
          ),
        ).rejects.toThrow(AttestationStorageError);
        // Nothing landed.
        expect(await fixture.rows()).toHaveLength(1);
        expect((await driver.fetch(handleOf(p))).state).toBe("prepared");
      }));

    test("the STORE refuses a duplicate capability hash the service never saw", () =>
      withCase(async ({ fixture, driver }) => {
        await driver.prepare({ idempotencyKey: "cap-key" });
        const [existing] = await fixture.rows();
        if (existing === undefined || isAttestationTombstone(existing)) {
          throw new Error("expected an envelope");
        }
        await expect(
          fixture.backend.transact(
            { kind: "prepare", idempotencyKey: "unrelated-key" },
            (store) => {
              store.insert({
                ...existing,
                attestationId: `${existing.attestationId}y`,
                idempotencyKey: "a-free-key",
              });
            },
          ),
        ).rejects.toThrow(AttestationStorageError);
        expect(await fixture.rows()).toHaveLength(1);
      }));

    test("the STORE refuses a duplicate handle the service never saw", () =>
      withCase(async ({ fixture, driver }) => {
        await driver.prepare({ idempotencyKey: "dup-handle" });
        const [existing] = await fixture.rows();
        if (existing === undefined || isAttestationTombstone(existing)) {
          throw new Error("expected an envelope");
        }
        await expect(
          fixture.backend.transact(
            { kind: "prepare", idempotencyKey: "unrelated-key" },
            (store) => {
              store.insert({
                ...existing,
                idempotencyKey: "another-free-key",
                resultCapabilityHash: "d".repeat(64),
              });
            },
          ),
        ).rejects.toThrow(AttestationStorageError);
        expect(await fixture.rows()).toHaveLength(1);
      }));

    test("a lookup outside the loaded scope is refused, never answered absent", () =>
      withCase(async ({ fixture, driver }) => {
        const p = await driver.prepare({ idempotencyKey: "scoped" });
        // A `capability` unit of work may not read a handle, scan the namespace,
        // or ask about an idempotency key; a `handle` unit of work may not ask
        // about a DIFFERENT handle. Answering `undefined` instead of throwing is
        // what would let a narrow preload silently change a decision.
        await expect(
          fixture.backend.transact(
            { kind: "capability", capabilityHash: "e".repeat(64) },
            (store) => store.read(handleOf(p)),
          ),
        ).rejects.toThrow(AttestationStorageError);
        await expect(
          fixture.backend.transact(
            { kind: "capability", capabilityHash: "e".repeat(64) },
            (store) => store.rows(),
          ),
        ).rejects.toThrow(AttestationStorageError);
        await expect(
          fixture.backend.transact({ kind: "handle", handle: handleOf(p) }, (store) =>
            store.read({ attestationId: `${p.attestationId}z`, generation: 1 }),
          ),
        ).rejects.toThrow(AttestationStorageError);
        await expect(
          fixture.backend.transact({ kind: "handle", handle: handleOf(p) }, (store) =>
            store.readByIdempotencyKey("scoped"),
          ),
        ).rejects.toThrow(AttestationStorageError);
        // The row itself is untouched by every refusal.
        expect((await driver.fetch(handleOf(p))).state).toBe("prepared");
      }));

    // -- namespaces --------------------------------------------------------
    test("namespaces sharing one location never collide", () =>
      withCase(async ({ fixture, driver, clock }) => {
        // Keys chosen so a naive concatenated storage key would collide:
        // "p" + "-x" versus "p-x" + "".
        const left = new AttestationDriver(await fixture.sibling("p"), clock);
        const right = new AttestationDriver(await fixture.sibling("p-x"), clock);
        const a = await left.prepare({ idempotencyKey: "shared-key" });
        const b = await right.prepare({ idempotencyKey: "shared-key" });
        expect(a.attestationId).not.toBe(b.attestationId);

        // The SAME idempotency key is free in both namespaces, and each fetch
        // sees only its own row.
        expect((await left.fetch(handleOf(b))).state).toBe("attestation-not-found");
        expect((await right.fetch(handleOf(a))).state).toBe("attestation-not-found");
        await left.store(a.resultCapability);
        expect((await left.fetch(handleOf(a))).state).toBe("result-stored");
        expect((await right.fetch(handleOf(b))).state).toBe("prepared");
        // A sweep in one namespace never touches the other.
        await left.abort(a, { reason: "cancelled" });
        clock.advance(IDEMPOTENCY_HORIZON_MS);
        expect((await left.sweep()).rowsRemaining).toBe(0);
        expect((await right.fetch(handleOf(b))).state).toBe("prepared");
        // The primary namespace is untouched by both.
        expect(driver.namespace.projectKey).not.toBe("p");
      }));

    // -- prototype pollution ----------------------------------------------
    test("Object.prototype member names resolve no row, key or capability", () =>
      withCase(async ({ driver }) => {
        const p = await driver.prepare();
        for (const name of PROTOTYPE_NAMES) {
          // A prototype name is not a well-formed attestation id, so a HANDLE
          // carrying one is a contract failure, never a phantom row.
          await expect(driver.fetch({ attestationId: name, generation: 1 })).rejects.toThrow();
          // A prototype name as a CAPABILITY is unauthorized, not a phantom row.
          await expect(
            driver.store({ scope: "store-result", token: name } as ResultCapability),
          ).rejects.toThrow(DispatchAuthorizationError);
          // A prototype name as an IDEMPOTENCY KEY is a perfectly ordinary key:
          // it must be storable AND must not collide with any other.
          const named = await driver.prepare({ idempotencyKey: name });
          expect((await driver.fetch(handleOf(named))).state).toBe("prepared");
          await expect(driver.prepareOutcome({ idempotencyKey: name })).rejects.toThrow(
            AttestationKeyReuseError,
          );
        }
        // Every prototype-named key produced its OWN row — none of them
        // collapsed onto an inherited member of some shared object.
        expect((await driver.fetch(handleOf(p))).state).toBe("prepared");
      }));

    test("a prototype-named idempotency key round-trips through storage intact", () =>
      withCase(async ({ fixture, driver }) => {
        // The full lifecycle under `__proto__`: a body carrying it as a VALUE
        // must survive serialization, rehydration and a restart without ever
        // reaching a prototype.
        const p = await driver.prepare({ idempotencyKey: "__proto__" });
        await driver.store(p.resultCapability);
        await driver.confirm(p);
        const reopened = new AttestationDriver(await fixture.restart(), driver.clock);
        const fetched = await reopened.fetch(handleOf(p));
        expect(fetched.state).toBe("consumed");
        const [row] = await fixture.rows();
        if (row === undefined) throw new Error("expected a row");
        expect(row.idempotencyKey).toBe("__proto__");
        expect(Object.hasOwn(row, "__proto__")).toBe(false);
        expect(Object.getPrototypeOf(row)).not.toBeNull();
        expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
      }));

    // -- the single output home --------------------------------------------
    test("the backend keeps one artifact set and no parallel output store", () =>
      withCase(async ({ fixture, driver }) => {
        const before = await fixture.artifacts();
        const p = await driver.prepare();
        await driver.store(p.resultCapability);
        await driver.confirm(p);
        const after = await fixture.artifacts();
        // Storing a result adds NO new kind of artifact beyond the row itself.
        expect(after.length).toBeLessThanOrEqual(before.length + 1);
        const dump = await fixture.dump();
        expect(dump.split(OUTPUT_MARKER)).toHaveLength(2);
      }));

    // -- the out-of-band writer (where a backend's lock permits one) -------
    test("a durable digest mismatch is a refused write, not a clobber", () =>
      withCase(async ({ fixture, driver }) => {
        const p = await driver.prepare();
        const outOfBand = fixture.outOfBandReplaceSync;
        if (outOfBand === undefined) {
          // Unreachable by construction on this backend — see the hook's doc.
          return;
        }
        const [loaded] = await fixture.rows();
        if (loaded === undefined || isAttestationTombstone(loaded)) {
          throw new Error("expected an envelope");
        }
        const tampered: AttestationRow = { ...loaded, createdAt: "2020-01-01T00:00:00.000Z" };
        expect(attestationRowDigest(tampered)).not.toBe(attestationRowDigest(loaded));
        await expect(
          fixture.backend.transact({ kind: "handle", handle: handleOf(p) }, (store) => {
            const row = store.read(handleOf(p));
            if (row === undefined || isAttestationTombstone(row)) {
              throw new Error("expected an envelope");
            }
            // An out-of-band writer lands a different revision AFTER this unit
            // of work loaded its snapshot; the journal's digest predicate must
            // lose rather than clobber it.
            outOfBand.call(fixture, tampered);
            store.replace(row, { ...row, abortedAt: row.createdAt } as AttestationRow);
          }),
        ).rejects.toThrow(AttestationStorageError);
        // The out-of-band revision survived; the refused write left no trace.
        const [after] = await fixture.rows();
        expect(after === undefined ? undefined : attestationRowDigest(after)).toBe(
          attestationRowDigest(tampered),
        );
      }));
  });
}
