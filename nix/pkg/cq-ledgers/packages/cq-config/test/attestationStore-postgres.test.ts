/**
 * The shared adapter contract against the PostgreSQL production backend
 * (T720, goal G94).
 *
 * Env-gated on `CQ_TEST_PG_URL`, the same gate every other `postgres-*.test.ts`
 * in this repo uses (Q286): with no reachable database every case SKIPS, loudly
 * and by name, and NOTHING is faked. A skipped case is reported as skipped — it
 * is never counted as evidence that the Postgres adapter works.
 *
 * When the gate IS set, each case gets its own `projectKey`, so the shared table
 * holds several tenants at once and the contract's namespace-isolation cases are
 * exercised against real rows sharing one physical table.
 */

import { SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import {
  ATTESTATION_TABLE,
  AttestationBindingError,
  AttestationContractError,
  AttestationKeyReuseError,
  AttestationNamespaceError,
  AttestationNotFoundError,
  AttestationStorageError,
  AttestationTransportError,
  DispatchAuthorizationError,
  DispatchInputValidationError,
  DispatchRefAssemblyError,
  DispatchStateConflictError,
  FakeDispatchClock,
  PostgresAttestationBackend,
  defaultDispatchRandomBytes,
  ensurePgAttestationSchema,
  openAttestationPgPool,
  prepareDispatchOn,
  provenanceBindingOf,
  type AttestationNamespace,
  type DispatchPrepared,
} from "@cq/config";
import {
  AttestationDriver,
  runAttestationStoreContract,
  type AttestationContractFixture,
} from "./attestationStoreContract.js";

const PG_URL = process.env["CQ_TEST_PG_URL"];
const NAMESPACE_BACKEND = "postgres" as const;

/** T2108: required-live mode fails closed instead of skipping. */
function assertRequiredPostgresDsn(pgUrl: string | undefined, requirePg: string | undefined): void {
  if ((pgUrl === undefined || pgUrl.length === 0) && requirePg === "1") {
    throw new Error("CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN");
  }
}

assertRequiredPostgresDsn(PG_URL, process.env["CQ_TEST_REQUIRE_PG"]);

/**
 * The single gate the live half of this file is governed by. Named (rather than
 * repeating `PG_URL === undefined`) so the relationship between the gate and what
 * skips is assertable instead of implied.
 */
const LIVE_SUITE_SKIPPED = PG_URL === undefined;

let liveCounter = 0;

/** A fresh tenant key per live case, so no two cases share durable rows. */
function livePrefix(tag: string): string {
  liveCounter += 1;
  return `t720-pg-${tag}-${String(liveCounter)}-${Math.random().toString(36).slice(2, 8)}`;
}

const opened: PostgresAttestationBackend[] = [];

afterAll(async () => {
  for (const backend of opened) {
    await backend.close().catch(() => undefined);
  }
});

describe("T2108 PostgreSQL required-mode disposition", () => {
  test("skips an ordinary local run without CQ_TEST_PG_URL", () => {
    expect(() => assertRequiredPostgresDsn(undefined, undefined)).not.toThrow();
  });

  test("requires CQ_TEST_PG_URL when required-live mode is selected", () => {
    expect(() => assertRequiredPostgresDsn(undefined, "1")).toThrow(/CQ_TEST_PG_URL/);
    expect(() => assertRequiredPostgresDsn("", "1")).toThrow(/CQ_TEST_PG_URL/);
  });

  test("selects the supplied CQ_TEST_PG_URL", () => {
    expect(() => assertRequiredPostgresDsn("postgres://localhost/cq-test", "1")).not.toThrow();
  });
});

/**
 * The tracked handles a fixture opened, exposed so a test can assert that
 * `dispose` really closed them. Without this the per-case close is a change no
 * assertion distinguishes (see the note on {@link buildPostgresFixture}).
 */
interface TrackedPostgresFixture extends AttestationContractFixture {
  readonly openedHandles: readonly PostgresAttestationBackend[];
}

/**
 * Build one live PostgreSQL fixture.
 *
 * TWO connection disciplines, both learned from a real exhaustion failure:
 *
 *  - each handle's pool is capped at ONE connection. `Bun.sql` defaults to 10, so
 *    a case opening a primary plus a peer plus two siblings reserved 40 — against
 *    a 100-connection server shared with every other postgres suite in the repo,
 *    which the same env gate enables and which bun runs in PARALLEL. In review
 *    round 1, 34 of 43 cases failed with "sorry, too many clients already".
 *  - every handle is closed when its own case ends, not in `afterAll`, so
 *    connections are returned as the file progresses.
 *
 * Measured honestly: the cap ALONE is sufficient under the conditions tested
 * (removing the per-case close and running the whole suite with the gate enabled
 * produced zero "too many clients" errors). The close is retained as the bound on
 * connection LIFETIME rather than width — the cap bounds how many connections one
 * handle takes, the close bounds how long it holds them — and is asserted below
 * so it is not merely an unmeasured claim.
 */
async function buildPostgresFixture(projectKey: string): Promise<TrackedPostgresFixture> {
  const dsn = PG_URL!;
  const handles: PostgresAttestationBackend[] = [];
  const open = async (key: string): Promise<PostgresAttestationBackend> => {
    const backend = await PostgresAttestationBackend.open({
      namespace: { backend: NAMESPACE_BACKEND, projectKey: key },
      pool: new SQL({ url: dsn, max: 1 }),
      ownsPool: true,
    });
    handles.push(backend);
    return backend;
  };
  const namespace: AttestationNamespace = { backend: NAMESPACE_BACKEND, projectKey };
  let live = await open(projectKey);
  return {
    openedHandles: handles,
    get backend() {
      return live;
    },
    peer: () => open(projectKey),
    restart: async () => {
      await live.close();
      live = await open(projectKey);
      return live;
    },
    sibling: (key: string) => open(key),
    rows: () => live.storedRows(),
    dump: () => live.rawStorageDump(),
    artifacts: () => live.storageArtifacts(),
    breakBackend: async () => {
      // OUT OF BAND: a peer connection drops the table from underneath the live
      // pool, so its next read AND its next write must fail explicitly. The
      // next case's `open` recreates it (the DDL is CREATE … IF NOT EXISTS).
      const saboteur = openAttestationPgPool(dsn);
      try {
        await saboteur`DROP TABLE IF EXISTS ${saboteur(ATTESTATION_TABLE)}`;
      } finally {
        await saboteur.close();
      }
    },
    dispose: async () => {
      // Close EVERY handle this case opened — the primary, and each peer and
      // sibling — before the cleanup pool runs, so connections are returned as
      // the file progresses instead of accumulating until `afterAll`.
      for (const handle of handles) {
        await handle.close().catch(() => undefined);
      }
      // Then drop this tenant's rows. A fresh projectKey per case means nothing
      // leaks between cases even if this fails.
      const pool = openAttestationPgPool(dsn);
      try {
        await pool`
          DELETE FROM ${pool(ATTESTATION_TABLE)}
           WHERE backend = ${namespace.backend} AND project_key = ${namespace.projectKey}
        `;
      } catch {
        // The table may have been dropped by breakBackend — nothing to clean.
      } finally {
        await pool.close();
      }
    },
  };
}

runAttestationStoreContract({
  name: "PostgreSQL",
  namespaceBackend: NAMESPACE_BACKEND,
  skip: LIVE_SUITE_SKIPPED,
  build: (projectKey: string) => buildPostgresFixture(projectKey),
  openWithBadCredentials: async () => {
    const backend = await PostgresAttestationBackend.openDsn(
      { backend: NAMESPACE_BACKEND, projectKey: "unusable" },
      "postgres://no-such-user:no-such-password@127.0.0.1:1/no-such-db",
    );
    opened.push(backend);
  },
});

describe.skipIf(LIVE_SUITE_SKIPPED)("the live PostgreSQL fixture releases what it opens", () => {
  test("dispose closes EVERY handle the case opened, not just the primary", async () => {
    const fixture = await buildPostgresFixture(livePrefix("dispose"));
    // A primary plus a peer plus a sibling: three handles, three pools.
    const peer = await fixture.peer();
    const sibling = await fixture.sibling(livePrefix("dispose-sib"));
    expect(fixture.openedHandles).toHaveLength(3);
    // All three are usable before dispose.
    for (const handle of [fixture.backend, peer, sibling]) {
      expect(await handle.transact({ kind: "namespace" }, (store) => store.rows())).toEqual([]);
    }

    await fixture.dispose();

    // And every one of them is closed afterwards. A closed handle refuses its
    // next unit of work, which is the observable proof that its pool was
    // released rather than left holding server connections until `afterAll`.
    for (const [index, handle] of fixture.openedHandles.entries()) {
      await expect(
        handle.transact({ kind: "namespace" }, (store) => store.rows()),
        `handle ${String(index)} was left open`,
      ).rejects.toThrow(AttestationTransportError);
    }
  });
});

// ---------------------------------------------------------------------------
// Properties assertable with NO database at all
// ---------------------------------------------------------------------------

describe("PostgreSQL attestation backend — offline (no database required)", () => {
  test("only the postgres backend may be served, and the excluded ones are refused", async () => {
    // The namespace check runs in the constructor, BEFORE any connection is
    // attempted, so these assertions need no reachable server.
    const pool = openAttestationPgPool("postgres://unused@127.0.0.1:1/unused");
    try {
      for (const backend of ["xdg", "fs", "git-object"] as const) {
        await expect(
          PostgresAttestationBackend.open({ namespace: { backend, projectKey: "p" }, pool }),
          backend,
        ).rejects.toThrow(AttestationStorageError);
      }
      for (const backend of ["remote"] as const) {
        await expect(
          PostgresAttestationBackend.open({ namespace: { backend, projectKey: "p" }, pool }),
          backend,
        ).rejects.toThrow(/cannot hold dispatch attestations/);
      }
    } finally {
      await pool.close().catch(() => undefined);
    }
  });

  test("an unreachable server is a transport failure at open, never a lifecycle answer", async () => {
    // Port 1 is not a Postgres server anywhere. The failure must be classified,
    // not surfaced as a raw driver error and certainly not as a dispatch state.
    const pool = openAttestationPgPool("postgres://nobody@127.0.0.1:1/nothing");
    await expect(ensurePgAttestationSchema(pool)).rejects.toThrow(AttestationTransportError);
    await pool.close().catch(() => undefined);
  });

  test("the gate governs the live suite, and the offline cases run either way", () => {
    // Replaces a tautology (`typeof PG_URL === "string" || PG_URL === undefined`,
    // which is unconditionally true for a `string | undefined` and verified
    // nothing) with the real relationship: LIVE_SUITE_SKIPPED is what the shared
    // contract is gated on, and it must be exactly the negation of the gate being
    // set to a usable DSN. If the two ever diverge, the suite is either skipping
    // with a database available or attempting to connect without one.
    expect(LIVE_SUITE_SKIPPED).toBe(PG_URL === undefined);
    if (PG_URL === undefined) {
      expect(LIVE_SUITE_SKIPPED).toBe(true);
    } else {
      expect(PG_URL).toMatch(/^postgres(ql)?:\/\//);
      expect(LIVE_SUITE_SKIPPED).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Error classification through `transact` (the D177 regression)
// ---------------------------------------------------------------------------

describe.skipIf(LIVE_SUITE_SKIPPED)(
  "PostgreSQL transact preserves the service's own error classes (D177)",
  () => {
    /**
     * The Postgres adapter is the only one that wrapped its WHOLE
     * `pool.begin(...)` body in `catch (error) { throw asPgBackendError(error) }`.
     * Because `asPgBackendError` passes through only `AttestationStorageError` and
     * `AttestationTransportError`, every OTHER domain error the service raises
     * inside the unit of work — a foreign namespace, an unauthorized capability, a
     * state conflict, a binding mismatch, key reuse, a missing record — was
     * rewritten into `AttestationTransportError`.
     *
     * That inverts the contract's central promise (an authorization or lifecycle
     * failure is never degraded into "the store could not be reached") and made a
     * parent unable to tell "retry, the store is down" from "your capability is
     * not authorized". `SqliteAttestationBackend` and `FsAttestationBackend` never
     * had it: they classify at individual query/write sites only.
     *
     * Each case below drives ONE domain error class through a real transaction.
     */
    const dsn = PG_URL!;

    /**
     * Open a bounded, single-namespace backend, run `body`, and ALWAYS close it.
     *
     * Two deliberate choices, both learned from a connection-exhaustion failure:
     * the pool is capped at ONE connection (`Bun.sql` defaults to 10, and 40-odd
     * cases at 10 apiece will exhaust a 100-connection server), and the handle is
     * closed when its own case ends rather than in `afterAll`. Enabling
     * `CQ_TEST_PG_URL` also enables every other postgres suite in the repo, and
     * bun runs test FILES in parallel, so this file must hold the smallest
     * possible number of connections at any instant. Accumulating handles until
     * `afterAll` is exactly what made 34 of 43 cases fail with "sorry, too many
     * clients already" in review round 1.
     */
    async function withBackend(
      tag: string,
      body: (backend: PostgresAttestationBackend, driver: AttestationDriver) => Promise<void>,
    ): Promise<void> {
      const pool = new SQL({ url: dsn, max: 1 });
      const backend = await PostgresAttestationBackend.open({
        namespace: { backend: NAMESPACE_BACKEND, projectKey: livePrefix(tag) },
        pool,
        ownsPool: true,
      });
      try {
        await body(
          backend,
          new AttestationDriver(backend, new FakeDispatchClock("2026-07-28T09:00:00.000Z")),
        );
      } finally {
        await backend.close().catch(() => undefined);
      }
    }

    /** The error a rejected operation produced, or `undefined` if it resolved. */
    async function errorFrom(operation: () => Promise<unknown>): Promise<unknown> {
      return operation().then(
        () => undefined,
        (error: unknown) => error,
      );
    }

    test("a foreign namespace surfaces AttestationNamespaceError, not a transport error", () =>
      withBackend("ns", async (_backend, driver) => {
        const settled = await errorFrom(() =>
          driver.prepareOutcome({
            namespace: { backend: NAMESPACE_BACKEND, projectKey: "someone-elses-project" },
          }),
        );
        expect(settled).toBeInstanceOf(AttestationNamespaceError);
        expect(settled).not.toBeInstanceOf(AttestationTransportError);
      }));

    test("an unknown capability surfaces DispatchAuthorizationError, not a transport error", () =>
      withBackend("cap", async (_backend, driver) => {
        const settled = await errorFrom(() =>
          driver.store({ scope: "store-result", token: `cq_result_${"A".repeat(43)}` }),
        );
        expect(settled).toBeInstanceOf(DispatchAuthorizationError);
        expect(settled).not.toBeInstanceOf(AttestationTransportError);
      }));

    test("a state conflict surfaces DispatchStateConflictError, not a transport error", () =>
      withBackend("conflict", async (_backend, driver) => {
        const p = await driver.prepare({ idempotencyKey: "conflict-key" });
        await driver.abort(p, { reason: "cancelled" });
        const settled = await errorFrom(() => driver.confirm(p));
        expect(settled).toBeInstanceOf(DispatchStateConflictError);
        expect(settled).not.toBeInstanceOf(AttestationTransportError);
      }));

    test("a provenance mismatch surfaces AttestationBindingError, not a transport error", () =>
      withBackend("binding", async (_backend, driver) => {
        const p = await driver.prepare({ idempotencyKey: "binding-key" });
        await driver.store(p.resultCapability);
        const settled = await errorFrom(() =>
          driver.confirm(p, {
            expectedProvenance: { ...provenanceBindingOf(p), promptDigest: "0".repeat(64) },
          }),
        );
        expect(settled).toBeInstanceOf(AttestationBindingError);
        expect(settled).not.toBeInstanceOf(AttestationTransportError);
      }));

    test("idempotency-key reuse surfaces AttestationKeyReuseError, not a transport error", () =>
      withBackend("reuse", async (_backend, driver) => {
        await driver.prepare({ idempotencyKey: "reuse-key" });
        const settled = await errorFrom(() =>
          driver.prepareOutcome({ idempotencyKey: "reuse-key" }),
        );
        // A subclass of AttestationStorageError, so it already passed through — but
        // it must arrive as the SPECIFIC class, not flattened to its base.
        expect(settled).toBeInstanceOf(AttestationKeyReuseError);
        expect(settled).not.toBeInstanceOf(AttestationTransportError);
      }));

    test("an unknown handle surfaces AttestationNotFoundError, not a transport error", () =>
      withBackend("missing", async (_backend, driver) => {
        // The driver only reads `attestationId`/`generation` off this argument; a
        // well-formed handle that was never prepared is what reaches the service.
        const neverPrepared = {
          attestationId: `att_${"z".repeat(32)}`,
          generation: 1,
        } as unknown as DispatchPrepared;
        const settled = await errorFrom(() => driver.abort(neverPrepared));
        expect(settled).toBeInstanceOf(AttestationNotFoundError);
        expect(settled).not.toBeInstanceOf(AttestationTransportError);
      }));

    test("an AttestationContractError from the service is not reclassified either", () =>
      withBackend("contract", async (_backend, driver) => {
        const settled = await errorFrom(() =>
          driver.fetch({ attestationId: "not-an-id", generation: 1 }),
        );
        expect(settled).toBeInstanceOf(AttestationContractError);
        expect(settled).not.toBeInstanceOf(AttestationTransportError);
      }));

    test("a canonicalizer failure surfaces DispatchRefAssemblyError, not a transport error", () =>
      withBackend("canon", async (_backend, driver) => {
        // Broader than the reviewer's finding: a unit of work also runs T978's
        // canonicalizer (via dispatchPayloadDigest) and T976/T684's validation, so
        // THOSE error classes can escape a transaction too. A non-finite number in
        // the submitted output is refused by the canonicalizer before any schema
        // check, inside the transaction.
        const p = await driver.prepare({ idempotencyKey: "canon-key" });
        const settled = await errorFrom(() =>
          driver.store(p.resultCapability, { taskId: "T720", extra: Number.NaN } as never),
        );
        expect(settled).toBeInstanceOf(DispatchRefAssemblyError);
        expect(settled).not.toBeInstanceOf(AttestationTransportError);
      }));

    test("a scrambled prepare step order surfaces DispatchInputValidationError", () =>
      withBackend("steporder", async (backend, driver) => {
        // T976's validate-then-allocate assertion runs INSIDE the unit of work.
        const settled = await errorFrom(() =>
          prepareDispatchOn(backend, driver.request({ idempotencyKey: "so" }), {
            mode: "backend",
            now: driver.clock.now,
            randomBytes: defaultDispatchRandomBytes,
            stepOrder: ["mint-result-capability", "resolve-role-contract"],
          }),
        );
        expect(settled).toBeInstanceOf(DispatchInputValidationError);
        expect(settled).not.toBeInstanceOf(AttestationTransportError);
      }));

    test("a GENUINE driver failure is still classified as a transport error", () =>
      withBackend("closed", async (backend) => {
        // The other half of the invariant: narrowing the wrap must not stop real
        // driver failures from being classified. A closed pool is unreachable.
        await backend.close();
        await expect(
          backend.transact({ kind: "namespace" }, (store) => store.rows()),
        ).rejects.toThrow(AttestationTransportError);
      }));
  },
);
