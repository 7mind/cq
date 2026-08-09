/**
 * T1958 — durable Postgres WorksetStore.
 *
 * Tenant-scoped ordered roots + epoch live in `workset_roots`. Transactional
 * and broker-owned admissions are DURABLE rows in `workset_admissions` carrying
 * host identity, process identity (pid + start-time fence), kind, target, and
 * epoch. Acquisition is one INSERT under tenant serialization; release is the
 * DELETE of that row only after settlement evidence. Connection-lifetime
 * advisory locks are intentionally never used for admissions — PostgreSQL
 * releases those at disconnect, which cannot preserve cleanup-before-release
 * across server instances (R1236 / K232).
 *
 * Stale recovery: a row is stale when the holder process identity is proven
 * dead on the recorded host, or its heartbeat lease has expired. Recovery
 * terminates a registered process group through the process-control identity
 * fence before deleting the row. An indefinitely-blocked group fails closed
 * with {@link WorksetAdmissionError} code `stuck-admission`; operators clear
 * it via {@link PostgresWorksetStore.forceSettleAdmission}.
 */

import { hostname as osHostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import {
  isProcessIdentityAlive,
  readProcessIdentity,
  settleProcessGroups,
  type ProcessGroupRegistration,
  type ProcessIdentity,
} from "@cq/process-control";
import {
  WORKSET_ADMINISTRATIVE_EFFECT_KINDS,
  WORKSET_EXTERNAL_EFFECT_KINDS,
  WORKSET_LEDGER_MUTATION_KINDS,
  WorksetAdmissionError,
  canonicalizeWorksetRootReplacement,
  isTrustedWorksetManagementAuthority,
  registerLiveWorksetAdmission,
  unregisterLiveWorksetAdmission,
  type WorksetAdministrativeEffectKind,
  type WorksetAdmissionCoordinatorHooks,
  type WorksetExternalEffectAdmission,
  type WorksetExternalEffectKind,
  type WorksetLedgerMutationAdmission,
  type WorksetLedgerMutationKind,
  type WorksetProcessGroupRegistration,
  type WorksetRootsEpoch,
} from "../../worksetEffectAdmission.js";
import type { WorksetStore } from "../../worksetStore.js";
import { notifyProjectChanged, writeTransaction } from "./connection.js";

// ---------------------------------------------------------------------------
// Constants / types
// ---------------------------------------------------------------------------

const DEFAULT_HEARTBEAT_TTL_MS = 30_000;
const DRAIN_POLL_MS = 15;
const HEARTBEAT_REFRESH_MS = 5_000;
const EXCLUSIVE_FORMS = new Set(["exclusive-set", "exclusive-administrative"]);

export interface DurableWorksetAdmissionRow {
  readonly admissionId: string;
  readonly form: string;
  readonly kind: string;
  readonly targetKey: string;
  readonly targets: readonly string[];
  readonly epoch: number;
  readonly hostId: string;
  readonly holderPid: number;
  readonly holderStartTime: string;
  readonly heartbeatAtMs: number;
  readonly processGroupRegistered: boolean;
  readonly pgid: number | null;
  readonly leaderPid: number | null;
  readonly leaderStartTime: string | null;
  readonly settled: boolean;
  readonly createdAtMs: number;
}

export interface CreatePostgresWorksetStoreOptions {
  readonly pool: SQL;
  readonly projectKey: string;
  readonly hooks?: WorksetAdmissionCoordinatorHooks;
  readonly validateReplacement?: (roots: readonly string[]) => void;
  readonly isTargetAdmitted?: (
    target: string,
    roots: readonly string[],
  ) => boolean;
  /** Defaults to `os.hostname()`. */
  readonly hostId?: string;
  /** Heartbeat lease TTL; default 30s. */
  readonly heartbeatTtlMs?: number;
  /** Epoch-ms clock; default `Date.now`. */
  readonly now?: () => number;
  /**
   * Decide whether a holder identity is still alive. Default: same-host only
   * via process-control start-time fence; foreign hosts always report alive
   * until heartbeat expiry drives recovery.
   */
  readonly isHolderAlive?: (
    identity: ProcessIdentity,
    hostId: string,
  ) => Promise<boolean>;
  /**
   * Terminate + settle a registered process group. Default:
   * {@link settleProcessGroups}.
   */
  readonly settleRegisteredGroup?: (
    registration: ProcessGroupRegistration,
  ) => Promise<{ readonly survivors: readonly number[] }>;
  /** Fired after a successful roots commit. Default: LISTEN/NOTIFY channel. */
  readonly onRootsCommitted?: (snapshot: WorksetRootsEpoch) => Promise<void> | void;
}

export interface PostgresWorksetStore extends WorksetStore {
  /** Stop heartbeat refresh. Safe to call multiple times. */
  close(): void;
  /** Observation: every durable admission row for this tenant. */
  listDurableAdmissions(): Promise<readonly DurableWorksetAdmissionRow[]>;
  /**
   * Operator recovery: delete a stuck admission under trusted management
   * authority after explicit forced-settlement attestation.
   */
  forceSettleAdmission(input: {
    readonly admissionId: string;
    readonly authority: unknown;
    readonly reason: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultIsTargetAdmitted(target: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  for (const root of roots) {
    if (target === root) return true;
    if (target.startsWith(`${root}/`)) return true;
  }
  return false;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RootsRow {
  roots_json: string;
  epoch: string | number;
  admit_generation: string | number;
}

interface AdmissionRow {
  admission_id: string;
  form: string;
  kind: string;
  target_key: string;
  targets_json: string;
  epoch: string | number;
  host_id: string;
  holder_pid: number;
  holder_start_time: string;
  heartbeat_at_ms: string | number;
  process_group_registered: boolean;
  pgid: number | null;
  leader_pid: number | null;
  leader_start_time: string | null;
  settled: boolean;
  created_at_ms: string | number;
}

function num(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function parseRoots(row: RootsRow | undefined): {
  roots: string[];
  epoch: number;
  admitGeneration: number;
} {
  if (row === undefined) {
    return { roots: [], epoch: 0, admitGeneration: 0 };
  }
  const parsed: unknown = JSON.parse(row.roots_json);
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      "workset_roots.roots_json must be a JSON string array",
    );
  }
  return {
    roots: parsed as string[],
    epoch: num(row.epoch),
    admitGeneration: num(row.admit_generation),
  };
}

function mapAdmissionRow(row: AdmissionRow): DurableWorksetAdmissionRow {
  const targetsParsed: unknown = JSON.parse(row.targets_json);
  const targets = Array.isArray(targetsParsed)
    ? (targetsParsed as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  return {
    admissionId: row.admission_id,
    form: row.form,
    kind: row.kind,
    targetKey: row.target_key,
    targets,
    epoch: num(row.epoch),
    hostId: row.host_id,
    holderPid: row.holder_pid,
    holderStartTime: row.holder_start_time,
    heartbeatAtMs: num(row.heartbeat_at_ms),
    processGroupRegistered: row.process_group_registered,
    pgid: row.pgid,
    leaderPid: row.leader_pid,
    leaderStartTime: row.leader_start_time,
    settled: row.settled,
    createdAtMs: num(row.created_at_ms),
  };
}

function stuckDiagnostic(row: DurableWorksetAdmissionRow): string {
  return (
    `workset replacement blocked by stuck admission ${row.admissionId} ` +
    `(form=${row.form}, kind=${row.kind}, target=${row.targetKey || "-"}, ` +
    `host=${row.hostId}, holderPid=${String(row.holderPid)}, ` +
    `pgid=${row.pgid === null ? "none" : String(row.pgid)})`
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPostgresWorksetStore(
  options: CreatePostgresWorksetStoreOptions,
): PostgresWorksetStore {
  const pool = options.pool;
  const projectKey = options.projectKey;
  if (projectKey.trim() === "") {
    throw new Error("createPostgresWorksetStore: projectKey must not be blank");
  }
  const hooks = options.hooks ?? {};
  const isTargetAdmitted = options.isTargetAdmitted ?? defaultIsTargetAdmitted;
  const validateReplacement = options.validateReplacement;
  const hostId = options.hostId ?? osHostname();
  const heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const isHolderAlive =
    options.isHolderAlive ??
    (async (identity: ProcessIdentity, holderHost: string): Promise<boolean> => {
      if (holderHost !== hostId) {
        // Cannot probe a foreign host's /proc; treat as alive until heartbeat expires.
        return true;
      }
      return await isProcessIdentityAlive(identity);
    });

  const settleRegisteredGroup =
    options.settleRegisteredGroup ??
    (async (registration: ProcessGroupRegistration) => {
      const result = await settleProcessGroups([registration]);
      return { survivors: result.survivors };
    });

  const onRootsCommitted =
    options.onRootsCommitted ??
    (async (_snapshot: WorksetRootsEpoch) => {
      await notifyProjectChanged(pool, projectKey);
    });

  // Local observation (sync WorksetStore surface).
  const localActive = new Map<string, { form: "ledger-mutation" | "external-effect" }>();
  /** In-flight durable side-effects for a local admission (register/settle). */
  const durableSideEffects = new Map<string, Promise<void>>();
  let exclusiveHeldFlag = false;
  let exclusiveTail: Promise<void> = Promise.resolve();
  let closed = false;
  let admissionSeq = 0;
  let holderIdentityPromise: Promise<ProcessIdentity> | null = null;

  function trackDurable(id: string, work: Promise<void>): void {
    const prior = durableSideEffects.get(id) ?? Promise.resolve();
    const next = prior.then(() => work).catch(() => undefined);
    durableSideEffects.set(id, next);
  }

  async function flushDurable(id: string): Promise<void> {
    const pending = durableSideEffects.get(id);
    if (pending !== undefined) await pending;
    durableSideEffects.delete(id);
  }

  async function holderIdentity(): Promise<ProcessIdentity> {
    if (holderIdentityPromise === null) {
      holderIdentityPromise = (async () => {
        const identity = await readProcessIdentity(process.pid);
        if (identity === null) {
          throw new Error("createPostgresWorksetStore: cannot read holder process identity");
        }
        return identity;
      })();
    }
    return await holderIdentityPromise;
  }

  // Heartbeat refresh for local durable rows.
  const heartbeatTimer = setInterval(() => {
    void refreshLocalHeartbeats().catch(() => {
      // Best-effort; next recovery cycle will observe a stale lease if we die.
    });
  }, HEARTBEAT_REFRESH_MS);
  heartbeatTimer.unref?.();

  async function refreshLocalHeartbeats(): Promise<void> {
    if (closed || localActive.size === 0) return;
    const ids = [...localActive.keys()];
    const ts = now();
    for (const id of ids) {
      await pool`
        UPDATE workset_admissions
        SET heartbeat_at_ms = ${ts}
        WHERE project_key = ${projectKey} AND admission_id = ${id}
      `;
    }
  }

  async function ensureRootsRow(tx: SQL): Promise<void> {
    await tx`
      INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation)
      VALUES (${projectKey}, ${"[]"}, ${0}, ${0})
      ON CONFLICT (project_key) DO NOTHING
    `;
  }

  async function lockRoots(tx: SQL): Promise<{
    roots: string[];
    epoch: number;
    admitGeneration: number;
  }> {
    await ensureRootsRow(tx);
    const rows = await tx<RootsRow[]>`
      SELECT roots_json, epoch, admit_generation
      FROM workset_roots
      WHERE project_key = ${projectKey}
      FOR UPDATE
    `;
    return parseRoots(rows[0]);
  }

  async function readRoots(): Promise<{
    roots: string[];
    epoch: number;
    admitGeneration: number;
  }> {
    const rows = await pool<RootsRow[]>`
      SELECT roots_json, epoch, admit_generation
      FROM workset_roots
      WHERE project_key = ${projectKey}
    `;
    if (rows.length === 0) {
      return writeTransaction(pool, async (tx) => lockRoots(tx));
    }
    return parseRoots(rows[0]);
  }

  async function listAdmissionRows(txOrPool: SQL = pool): Promise<DurableWorksetAdmissionRow[]> {
    const rows = await txOrPool<AdmissionRow[]>`
      SELECT
        admission_id, form, kind, target_key, targets_json, epoch,
        host_id, holder_pid, holder_start_time, heartbeat_at_ms,
        process_group_registered, pgid, leader_pid, leader_start_time,
        settled, created_at_ms
      FROM workset_admissions
      WHERE project_key = ${projectKey}
      ORDER BY created_at_ms ASC, admission_id ASC
    `;
    return rows.map(mapAdmissionRow);
  }

  async function exclusivePresent(txOrPool: SQL = pool): Promise<boolean> {
    const rows = await txOrPool<Array<{ n: string | number }>>`
      SELECT COUNT(*)::int AS n
      FROM workset_admissions
      WHERE project_key = ${projectKey}
        AND form IN ('exclusive-set', 'exclusive-administrative')
    `;
    return num(rows[0]?.n ?? 0) > 0;
  }

  /**
   * Attempt to reclaim one admission row. Returns:
   * - `reclaimed` when the row was deleted
   * - `live` when the holder/lease is still valid
   * - `stuck` when a registered process group cannot be settled
   */
  async function recoverOne(
    row: DurableWorksetAdmissionRow,
  ): Promise<"reclaimed" | "live" | "stuck"> {
    if (EXCLUSIVE_FORMS.has(row.form)) {
      // Exclusive rows are short-lived critical sections owned by a live waiter.
      // Reclaim only when the holder is proven dead or the heartbeat expired.
      const holderAlive = await isHolderAlive(
        { pid: row.holderPid, startTime: row.holderStartTime },
        row.hostId,
      );
      const heartbeatFresh = now() - row.heartbeatAtMs <= heartbeatTtlMs;
      if (holderAlive && heartbeatFresh) return "live";
      await pool`
        DELETE FROM workset_admissions
        WHERE project_key = ${projectKey} AND admission_id = ${row.admissionId}
      `;
      return "reclaimed";
    }

    const holderAlive = await isHolderAlive(
      { pid: row.holderPid, startTime: row.holderStartTime },
      row.hostId,
    );
    const heartbeatFresh = now() - row.heartbeatAtMs <= heartbeatTtlMs;
    if (holderAlive && heartbeatFresh) return "live";

    // Stale: settle any registered process group before delete.
    if (
      row.form === "external-effect" &&
      row.processGroupRegistered &&
      row.pgid !== null &&
      row.leaderPid !== null &&
      row.leaderStartTime !== null &&
      row.leaderStartTime !== "" &&
      !row.settled
    ) {
      const registration: ProcessGroupRegistration = {
        pgid: row.pgid,
        leader: { pid: row.leaderPid, startTime: row.leaderStartTime },
      };
      const settled = await settleRegisteredGroup(registration);
      if (settled.survivors.length > 0) {
        return "stuck";
      }
    }

    await pool`
      DELETE FROM workset_admissions
      WHERE project_key = ${projectKey} AND admission_id = ${row.admissionId}
    `;
    return "reclaimed";
  }

  /**
   * Drain non-exclusive durable admissions, reclaiming stale rows. Throws
   * stuck-admission when a row cannot be settled.
   */
  async function drainNonExclusiveOrThrow(): Promise<void> {
    for (;;) {
      const rows = (await listAdmissionRows()).filter((r) => !EXCLUSIVE_FORMS.has(r.form));
      if (rows.length === 0) return;

      let progressed = false;
      for (const row of rows) {
        const outcome = await recoverOne(row);
        if (outcome === "stuck") {
          throw new WorksetAdmissionError("stuck-admission", stuckDiagnostic(row));
        }
        if (outcome === "reclaimed") progressed = true;
      }
      if (!progressed) {
        // Live admissions remain — wait for their owners to release.
        await sleep(DRAIN_POLL_MS);
      }
    }
  }

  async function waitUntilNoExclusive(): Promise<void> {
    for (;;) {
      const rows = (await listAdmissionRows()).filter((r) => EXCLUSIVE_FORMS.has(r.form));
      if (rows.length === 0) return;
      let anyLive = false;
      for (const row of rows) {
        const outcome = await recoverOne(row);
        if (outcome === "live") anyLive = true;
        if (outcome === "stuck") {
          // Exclusive should never be stuck with a process group; treat as reclaimable.
          await pool`
            DELETE FROM workset_admissions
            WHERE project_key = ${projectKey} AND admission_id = ${row.admissionId}
          `;
        }
      }
      if (!anyLive) {
        // Loop to observe empty set after reclaim.
        continue;
      }
      await sleep(DRAIN_POLL_MS);
    }
  }

  async function insertAdmission(input: {
    readonly id: string;
    readonly form: string;
    readonly kind: string;
    readonly targetKey: string;
    readonly targets: readonly string[];
    readonly epoch: number;
  }): Promise<void> {
    const identity = await holderIdentity();
    const ts = now();
    await pool`
      INSERT INTO workset_admissions (
        project_key, admission_id, form, kind, target_key, targets_json, epoch,
        host_id, holder_pid, holder_start_time, heartbeat_at_ms,
        process_group_registered, pgid, leader_pid, leader_start_time,
        settled, created_at_ms
      ) VALUES (
        ${projectKey},
        ${input.id},
        ${input.form},
        ${input.kind},
        ${input.targetKey},
        ${JSON.stringify(input.targets)},
        ${input.epoch},
        ${hostId},
        ${identity.pid},
        ${identity.startTime},
        ${ts},
        ${false},
        ${null},
        ${null},
        ${null},
        ${input.form === "ledger-mutation"},
        ${ts}
      )
    `;
  }

  async function deleteAdmission(id: string): Promise<void> {
    await pool`
      DELETE FROM workset_admissions
      WHERE project_key = ${projectKey} AND admission_id = ${id}
    `;
  }

  async function runExclusive<T>(
    form: "exclusive-set" | "exclusive-administrative",
    kind: string,
    body: () => Promise<T>,
  ): Promise<T> {
    const prior = exclusiveTail;
    const gate = deferred();
    exclusiveTail = gate.promise;
    await prior;

    // Raise the local exclusive flag BEFORE any further await so same-process
    // admit grants that leave beforeAdmissionGrant observe the barrier
    // (parity with createInMemoryWorksetAdmissionCoordinator).
    const exclusiveId = `ex-${++admissionSeq}-${randomUUID()}`;
    exclusiveHeldFlag = true;
    try {
      // Insert durable exclusive row (retry if unique index races a peer).
      for (;;) {
        await waitUntilNoExclusive();
        try {
          const snap = await readRoots();
          await insertAdmission({
            id: exclusiveId,
            form,
            kind,
            targetKey: "",
            targets: [],
            epoch: snap.epoch,
          });
          break;
        } catch (err) {
          // Unique violation on exclusive index — peer won; retry.
          const code =
            typeof err === "object" && err !== null
              ? (err as { code?: unknown }).code
              : undefined;
          if (code === "23505") {
            await sleep(DRAIN_POLL_MS);
            continue;
          }
          throw err;
        }
      }

      await drainNonExclusiveOrThrow();
      if (hooks.afterExclusiveReady !== undefined) {
        await hooks.afterExclusiveReady();
      }
      return await body();
    } finally {
      await deleteAdmission(exclusiveId).catch(() => undefined);
      exclusiveHeldFlag = false;
      gate.resolve();
    }
  }

  // ---- Public API ---------------------------------------------------------

  async function snapshot(): Promise<WorksetRootsEpoch> {
    const s = await readRoots();
    return { roots: s.roots.slice(), epoch: s.epoch };
  }

  async function admitLedgerMutation(input: {
    readonly kind: WorksetLedgerMutationKind;
    readonly targets: readonly string[];
  }): Promise<WorksetLedgerMutationAdmission> {
    if (!(WORKSET_LEDGER_MUTATION_KINDS as readonly string[]).includes(input.kind)) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `unknown ledger mutation kind: ${String(input.kind)}`,
      );
    }
    const generationAtEntry = (await readRoots()).admitGeneration;
    for (;;) {
      await waitUntilNoExclusive();
      // Same-process exclusive barrier (set may have raised the flag while we
      // were in beforeAdmissionGrant on a prior iteration).
      if (exclusiveHeldFlag) {
        await sleep(DRAIN_POLL_MS);
        continue;
      }
      if (hooks.beforeAdmissionGrant !== undefined) {
        await hooks.beforeAdmissionGrant();
      }
      // Re-check after the latch: set-first revocation samples generation at
      // entry and requires either a generation bump or exclusive held here.
      if (exclusiveHeldFlag) {
        continue;
      }

      type GrantResult =
        | { readonly kind: "revoked" }
        | { readonly kind: "retry" }
        | {
            readonly kind: "granted";
            readonly id: string;
            readonly epoch: number;
            readonly roots: readonly string[];
          }
        | { readonly kind: "target-excluded"; readonly target: string };

      const granted: GrantResult = await writeTransaction(pool, async (tx) => {
        const locked = await lockRoots(tx);
        if (locked.admitGeneration !== generationAtEntry) {
          return { kind: "revoked" };
        }
        if (exclusiveHeldFlag || (await exclusivePresent(tx))) {
          return { kind: "retry" };
        }
        for (const target of input.targets) {
          if (!isTargetAdmitted(target, locked.roots)) {
            return { kind: "target-excluded", target };
          }
        }
        const id = `lm-${++admissionSeq}-${randomUUID()}`;
        const identity = await holderIdentity();
        const ts = now();
        const targetKey = input.targets[0] ?? "";
        await tx`
          INSERT INTO workset_admissions (
            project_key, admission_id, form, kind, target_key, targets_json, epoch,
            host_id, holder_pid, holder_start_time, heartbeat_at_ms,
            process_group_registered, pgid, leader_pid, leader_start_time,
            settled, created_at_ms
          ) VALUES (
            ${projectKey},
            ${id},
            ${"ledger-mutation"},
            ${input.kind},
            ${targetKey},
            ${JSON.stringify(input.targets)},
            ${locked.epoch},
            ${hostId},
            ${identity.pid},
            ${identity.startTime},
            ${ts},
            ${false},
            ${null},
            ${null},
            ${null},
            ${true},
            ${ts}
          )
        `;
        return {
          kind: "granted",
          id,
          epoch: locked.epoch,
          roots: locked.roots.slice(),
        };
      });

      if (granted.kind === "revoked") {
        throw new WorksetAdmissionError(
          "revoked",
          "workset admission revoked by exclusive commit before grant",
        );
      }
      if (granted.kind === "retry") continue;
      if (granted.kind === "target-excluded") {
        throw new WorksetAdmissionError(
          "target-excluded",
          `ledger mutation target "${granted.target}" is outside the admitted workset`,
        );
      }

      localActive.set(granted.id, { form: "ledger-mutation" });
      let open = true;
      const handle: WorksetLedgerMutationAdmission = {
        form: "ledger-mutation",
        id: granted.id,
        kind: input.kind,
        epoch: granted.epoch,
        roots: granted.roots,
        targets: input.targets.slice(),
        async acknowledge(): Promise<void> {
          if (!open) {
            throw new WorksetAdmissionError(
              "admission-closed",
              "ledger mutation admission already acknowledged",
            );
          }
          open = false;
          unregisterLiveWorksetAdmission(handle);
          localActive.delete(granted.id);
          await deleteAdmission(granted.id);
        },
      };
      registerLiveWorksetAdmission(handle);
      Object.freeze(handle);
      return handle;
    }
  }

  async function admitExternalEffect(input: {
    readonly kind: WorksetExternalEffectKind;
    readonly targetRef: string;
  }): Promise<WorksetExternalEffectAdmission> {
    if (!(WORKSET_EXTERNAL_EFFECT_KINDS as readonly string[]).includes(input.kind)) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `unknown external effect kind: ${String(input.kind)}`,
      );
    }
    const generationAtEntry = (await readRoots()).admitGeneration;
    for (;;) {
      await waitUntilNoExclusive();
      if (exclusiveHeldFlag) {
        await sleep(DRAIN_POLL_MS);
        continue;
      }
      if (hooks.beforeAdmissionGrant !== undefined) {
        await hooks.beforeAdmissionGrant();
      }
      if (exclusiveHeldFlag) {
        // Exclusive took the lock during the latch. If generation advanced,
        // the next TX observes revoked; otherwise retry until exclusive clears
        // and re-sample via the generation fence.
        continue;
      }

      type GrantResult =
        | { readonly kind: "revoked" }
        | { readonly kind: "retry" }
        | {
            readonly kind: "granted";
            readonly id: string;
            readonly epoch: number;
            readonly roots: readonly string[];
          }
        | { readonly kind: "target-excluded" };

      const granted: GrantResult = await writeTransaction(pool, async (tx) => {
        const locked = await lockRoots(tx);
        if (locked.admitGeneration !== generationAtEntry) {
          return { kind: "revoked" };
        }
        if (exclusiveHeldFlag || (await exclusivePresent(tx))) {
          return { kind: "retry" };
        }
        if (!isTargetAdmitted(input.targetRef, locked.roots)) {
          return { kind: "target-excluded" };
        }
        const id = `ee-${++admissionSeq}-${randomUUID()}`;
        const identity = await holderIdentity();
        const ts = now();
        await tx`
          INSERT INTO workset_admissions (
            project_key, admission_id, form, kind, target_key, targets_json, epoch,
            host_id, holder_pid, holder_start_time, heartbeat_at_ms,
            process_group_registered, pgid, leader_pid, leader_start_time,
            settled, created_at_ms
          ) VALUES (
            ${projectKey},
            ${id},
            ${"external-effect"},
            ${input.kind},
            ${input.targetRef},
            ${JSON.stringify([input.targetRef])},
            ${locked.epoch},
            ${hostId},
            ${identity.pid},
            ${identity.startTime},
            ${ts},
            ${false},
            ${null},
            ${null},
            ${null},
            ${false},
            ${ts}
          )
        `;
        return {
          kind: "granted",
          id,
          epoch: locked.epoch,
          roots: locked.roots.slice(),
        };
      });

      if (granted.kind === "revoked") {
        throw new WorksetAdmissionError(
          "revoked",
          "workset admission revoked by exclusive commit before grant",
        );
      }
      if (granted.kind === "retry") continue;
      if (granted.kind === "target-excluded") {
        throw new WorksetAdmissionError(
          "target-excluded",
          `external effect target "${input.targetRef}" is outside the admitted workset`,
        );
      }

      let processGroup: WorksetProcessGroupRegistration | null = null;
      let settled = false;
      let open = true;
      localActive.set(granted.id, { form: "external-effect" });

      const handle: WorksetExternalEffectAdmission = {
        form: "external-effect",
        id: granted.id,
        kind: input.kind,
        epoch: granted.epoch,
        roots: granted.roots,
        targetRef: input.targetRef,
        get processGroupRegistered(): boolean {
          return processGroup !== null;
        },
        get settled(): boolean {
          return settled;
        },
        registerProcessGroup(registration: WorksetProcessGroupRegistration): void {
          if (!open) {
            throw new WorksetAdmissionError(
              "admission-closed",
              "cannot register a process group on a closed external-effect admission",
            );
          }
          if (processGroup !== null) {
            throw new WorksetAdmissionError(
              "process-group-already-registered",
              "external-effect admission already has a registered process group",
            );
          }
          if (registration.pgid !== registration.leaderPid) {
            throw new WorksetAdmissionError(
              "invalid-replacement",
              "process-group registration requires leaderPid === pgid",
            );
          }
          processGroup = {
            pgid: registration.pgid,
            leaderPid: registration.leaderPid,
          };
          // Sync API surface: queue durable publish; release flushes it.
          trackDurable(granted.id, publishProcessGroup(granted.id, registration));
        },
        markSettled(): void {
          if (!open) {
            throw new WorksetAdmissionError(
              "admission-closed",
              "cannot settle a closed external-effect admission",
            );
          }
          if (processGroup === null) {
            throw new WorksetAdmissionError(
              "admission-not-registered",
              "cannot settle before process-group registration",
            );
          }
          settled = true;
          trackDurable(
            granted.id,
            pool`
              UPDATE workset_admissions
              SET settled = TRUE, heartbeat_at_ms = ${now()}
              WHERE project_key = ${projectKey} AND admission_id = ${granted.id}
            `.then(() => undefined),
          );
        },
        async releaseAfterSettlement(): Promise<void> {
          if (!open) {
            throw new WorksetAdmissionError(
              "admission-closed",
              "external-effect admission already released",
            );
          }
          if (processGroup === null) {
            throw new WorksetAdmissionError(
              "admission-not-registered",
              "external-effect admission requires process-group registration before release",
            );
          }
          if (!settled) {
            throw new WorksetAdmissionError(
              "process-group-not-settled",
              "external-effect admission requires process-group settlement before release",
            );
          }
          open = false;
          unregisterLiveWorksetAdmission(handle);
          localActive.delete(granted.id);
          await flushDurable(granted.id);
          await deleteAdmission(granted.id);
        },
      };
      registerLiveWorksetAdmission(handle);
      Object.freeze(handle);
      return handle;
    }
  }

  async function publishProcessGroup(
    admissionId: string,
    registration: WorksetProcessGroupRegistration,
  ): Promise<void> {
    let leaderStartTime = "";
    try {
      const identity = await readProcessIdentity(registration.leaderPid);
      leaderStartTime = identity?.startTime ?? "";
    } catch {
      leaderStartTime = "";
    }
    // When the leader is not observable (synthetic test pgids), store empty
    // start-time; recovery treats missing start-time registrations as
    // settle-by-pgid-only via the injected settle hook / default ops.
    await pool`
      UPDATE workset_admissions
      SET
        process_group_registered = TRUE,
        pgid = ${registration.pgid},
        leader_pid = ${registration.leaderPid},
        leader_start_time = ${leaderStartTime === "" ? null : leaderStartTime},
        heartbeat_at_ms = ${now()}
      WHERE project_key = ${projectKey} AND admission_id = ${admissionId}
    `;
  }

  async function setRoots(nextRoots: readonly string[]): Promise<WorksetRootsEpoch> {
    return runExclusive("exclusive-set", "set-roots", async () => {
      const canonical = canonicalizeWorksetRootReplacement(nextRoots);
      if (validateReplacement !== undefined) {
        validateReplacement(canonical);
      }
      if (hooks.beforeCommit !== undefined) {
        await hooks.beforeCommit();
      }
      const committed = await writeTransaction(pool, async (tx) => {
        const locked = await lockRoots(tx);
        const nextEpoch = locked.epoch + 1;
        const nextGen = locked.admitGeneration + 1;
        await tx`
          UPDATE workset_roots
          SET
            roots_json = ${JSON.stringify(canonical)},
            epoch = ${nextEpoch},
            admit_generation = ${nextGen},
            updated_at = now()
          WHERE project_key = ${projectKey}
        `;
        return { roots: canonical.slice(), epoch: nextEpoch };
      });
      await onRootsCommitted(committed);
      return committed;
    });
  }

  async function runAdministrative(input: {
    readonly kind: WorksetAdministrativeEffectKind;
    readonly authority: unknown;
    readonly destructivePhase: () => Promise<void> | void;
  }): Promise<void> {
    if (!(WORKSET_ADMINISTRATIVE_EFFECT_KINDS as readonly string[]).includes(input.kind)) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `unknown administrative effect kind: ${String(input.kind)}`,
      );
    }
    if (!isTrustedWorksetManagementAuthority(input.authority)) {
      throw new WorksetAdmissionError(
        "management-authority-required",
        `administrative effect "${input.kind}" requires trusted management authority`,
      );
    }
    await runExclusive("exclusive-administrative", input.kind, async () => {
      if (hooks.beforeAdministrativeDestructive !== undefined) {
        await hooks.beforeAdministrativeDestructive();
      }
      await input.destructivePhase();
      // Advance admit_generation so in-flight grant attempts revoke.
      await writeTransaction(pool, async (tx) => {
        const locked = await lockRoots(tx);
        await tx`
          UPDATE workset_roots
          SET admit_generation = ${locked.admitGeneration + 1}, updated_at = now()
          WHERE project_key = ${projectKey}
        `;
      });
    });
  }

  function activeAdmissionCount(): number {
    return localActive.size;
  }

  function exclusiveHeld(): boolean {
    return exclusiveHeldFlag;
  }

  function close(): void {
    closed = true;
    clearInterval(heartbeatTimer);
  }

  async function listDurableAdmissions(): Promise<readonly DurableWorksetAdmissionRow[]> {
    return await listAdmissionRows();
  }

  async function forceSettleAdmission(input: {
    readonly admissionId: string;
    readonly authority: unknown;
    readonly reason: string;
  }): Promise<void> {
    if (!isTrustedWorksetManagementAuthority(input.authority)) {
      throw new WorksetAdmissionError(
        "management-authority-required",
        "forceSettleAdmission requires trusted management authority",
      );
    }
    if (input.reason.trim() === "") {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "forceSettleAdmission requires a non-empty reason attestation",
      );
    }
    const deleted = await pool`
      DELETE FROM workset_admissions
      WHERE project_key = ${projectKey} AND admission_id = ${input.admissionId}
      RETURNING admission_id
    `;
    if (!Array.isArray(deleted) || deleted.length === 0) {
      throw new WorksetAdmissionError(
        "admission-closed",
        `forceSettleAdmission: no admission ${input.admissionId} for tenant ${projectKey}`,
      );
    }
  }

  // Eagerly ensure roots row so snapshot() is defined before first set.
  void readRoots();

  return {
    snapshot,
    setRoots,
    admitLedgerMutation,
    admitExternalEffect,
    runAdministrative,
    activeAdmissionCount,
    exclusiveHeld,
    close,
    listDurableAdmissions,
    forceSettleAdmission,
  };
}
