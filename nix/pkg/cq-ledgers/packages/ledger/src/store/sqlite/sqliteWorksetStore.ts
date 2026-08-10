/**
 * T1957 — SQLite-backed {@link WorksetStore}.
 *
 * Durable state is roots + epoch (and admit generation) in `workset_state`,
 * plus durable admission rows and an exclusive-claim row. Broker admissions
 * remain effective across processes without holding an ordinary long-lived
 * write transaction: every mutation of claim/admission/roots is one short
 * `BEGIN IMMEDIATE` … `COMMIT`. Exclusive set/admin waits for admissions to
 * drain by polling durable rows (reclaiming only stale holder processes).
 *
 * Linearization matches the in-memory coordinator (T1953/T1954): exclusive
 * waits for active admissions; commit revokes not-yet-granted admits via
 * admit_generation; register → settle → release is enforced on handles.
 */

import * as os from "node:os";
import type { Database } from "bun:sqlite";
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
import type {
  CreateInMemoryWorksetStoreOptions,
  WorksetStore,
} from "../../worksetStore.js";
import { immediateWriteTransaction } from "./connection.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateSqliteWorksetStoreOptions extends CreateInMemoryWorksetStoreOptions {
  /** Open ledger database (WAL, busy_timeout already configured). */
  readonly db: Database;
  /** Override process identity (tests). Defaults to `process.pid`. */
  readonly selfPid?: number;
  /** Override hostname (tests). Defaults to `os.hostname()`. */
  readonly selfHostname?: string;
  /** Override liveness probe (tests). Defaults to `process.kill(pid, 0)`. */
  readonly isPidAlive?: (pid: number) => boolean;
  /** Cross-process / drain poll interval. Default 5ms. */
  readonly pollIntervalMs?: number;
  /** Wall-clock for started_at fences. Defaults to `Date.now`. */
  readonly nowMs?: () => number;
  /** Async sleep (tests may inject). Defaults to `Bun.sleep`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface WorksetStateRow {
  epoch: number;
  roots_json: string;
  admit_generation: number;
}

interface WorksetAdmissionRow {
  id: string;
  form: string;
  kind: string;
  epoch: number;
  roots_json: string;
  targets_json: string;
  target_ref: string | null;
  host: string;
  pid: number;
  started_at: number;
  pgid: number | null;
  leader_pid: number | null;
  settled: number;
  process_group_registered: number;
}

interface WorksetExclusiveRow {
  holder_id: string;
  host: string;
  pid: number;
  started_at: number;
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

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function parseRootsJson(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      "workset_state.roots_json must be a JSON string array",
    );
  }
  return parsed as string[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link WorksetStore} over an already-opened ledger database whose
 * schema includes the T1957 workset tables (via {@link ensureSchema}).
 */
export function createSqliteWorksetStore(
  options: CreateSqliteWorksetStoreOptions,
): WorksetStore {
  const db = options.db;
  const hooks: WorksetAdmissionCoordinatorHooks = options.hooks ?? {};
  const isTargetAdmitted = options.isTargetAdmitted ?? defaultIsTargetAdmitted;
  const validateReplacement = options.validateReplacement;
  const selfPid = options.selfPid ?? process.pid;
  const selfHostname = options.selfHostname ?? os.hostname();
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const nowMs = options.nowMs ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  let nextAdmissionId = 0;
  /** In-process exclusive flag (mirrors durable claim for same-process observers). */
  let localExclusiveHeld = false;
  /** Serialises exclusive attempts inside this process. */
  let exclusiveTail: Promise<void> = Promise.resolve();

  const waiters = new Set<() => void>();
  function notify(): void {
    for (const wake of [...waiters]) wake();
  }

  /**
   * Wait until `predicate` is true, combining in-process waiter notify with a
   * poll interval so peer-process durable-state changes are observed.
   */
  async function waitUntilPolled(predicate: () => boolean): Promise<void> {
    for (;;) {
      if (predicate()) return;
      const gate = deferred();
      const wake = (): void => {
        gate.resolve();
      };
      waiters.add(wake);
      await Promise.race([sleep(pollIntervalMs), gate.promise]);
      waiters.delete(wake);
    }
  }

  function readState(): WorksetStateRow {
    const row = db
      .query(
        "SELECT epoch, roots_json, admit_generation FROM workset_state WHERE id = 1",
      )
      .get() as WorksetStateRow | null;
    if (row === null) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "workset_state singleton row is missing",
      );
    }
    return row;
  }

  function snapshotSync(): WorksetRootsEpoch {
    const row = readState();
    return { roots: parseRootsJson(row.roots_json), epoch: row.epoch };
  }

  function snapshot(): WorksetRootsEpoch {
    return snapshotSync();
  }

  function countAdmissions(): number {
    const row = db.query("SELECT COUNT(*) AS n FROM workset_admissions").get() as {
      n: number;
    };
    return row.n;
  }

  function readExclusive(): WorksetExclusiveRow | null {
    return db
      .query("SELECT holder_id, host, pid, started_at FROM workset_exclusive WHERE id = 1")
      .get() as WorksetExclusiveRow | null;
  }

  function exclusiveHeldDurable(): boolean {
    const row = readExclusive();
    if (row === null) return false;
    if (row.host === selfHostname && !isPidAlive(row.pid)) {
      // Stale exclusive — reclaim in a short write txn.
      immediateWriteTransaction(db, () => {
        const current = readExclusive();
        if (
          current !== null &&
          current.host === row.host &&
          current.pid === row.pid &&
          current.started_at === row.started_at
        ) {
          db.query("DELETE FROM workset_exclusive WHERE id = 1").run();
        }
      });
      notify();
      return false;
    }
    return true;
  }

  function activeAdmissionCount(): number {
    reclaimStaleAdmissions();
    return countAdmissions();
  }

  function exclusiveHeld(): boolean {
    return localExclusiveHeld || exclusiveHeldDurable();
  }

  /**
   * Drop admissions whose holder process is proven dead on this host and that
   * no longer fence a live external process group.
   */
  function reclaimStaleAdmissions(): void {
    const rows = db
      .query(
        "SELECT id, form, host, pid, started_at, pgid, leader_pid, settled, process_group_registered FROM workset_admissions",
      )
      .all() as WorksetAdmissionRow[];
    const staleIds: string[] = [];
    for (const row of rows) {
      if (row.host !== selfHostname) continue;
      if (isPidAlive(row.pid)) continue;
      if (row.form === "external-effect" && row.process_group_registered === 1) {
        // Holder died after registration: only reclaim once settled, or when
        // the registered process group leader is also dead.
        if (row.settled === 1) {
          staleIds.push(row.id);
          continue;
        }
        const leader = row.leader_pid ?? row.pgid;
        if (leader !== null && !isPidAlive(leader)) {
          staleIds.push(row.id);
        }
        // Otherwise leave the row — setRoots blocks (fail closed).
        continue;
      }
      // ledger-mutation, or external without registration: holder death → stale.
      staleIds.push(row.id);
    }
    if (staleIds.length === 0) return;
    immediateWriteTransaction(db, () => {
      const del = db.query("DELETE FROM workset_admissions WHERE id = ?");
      for (const id of staleIds) {
        // Re-check still present (peer may have released).
        del.run(id);
      }
    });
    notify();
  }

  function tryClaimExclusive(holderId: string): boolean {
    reclaimStaleAdmissions();
    return immediateWriteTransaction(db, () => {
      const existing = readExclusive();
      if (existing !== null) {
        if (existing.host === selfHostname && !isPidAlive(existing.pid)) {
          db.query("DELETE FROM workset_exclusive WHERE id = 1").run();
        } else {
          return false;
        }
      }
      db.query(
        "INSERT INTO workset_exclusive (id, holder_id, host, pid, started_at) VALUES (1, ?, ?, ?, ?)",
      ).run(holderId, selfHostname, selfPid, nowMs());
      return true;
    });
  }

  function releaseExclusive(holderId: string): void {
    immediateWriteTransaction(db, () => {
      db.query("DELETE FROM workset_exclusive WHERE id = 1 AND holder_id = ?").run(holderId);
    });
    notify();
  }

  async function runExclusive<T>(body: () => Promise<T>): Promise<T> {
    const prior = exclusiveTail;
    const gate = deferred();
    exclusiveTail = gate.promise;
    await prior;

    const holderId = `ex-${selfPid}-${nowMs()}-${++nextAdmissionId}`;
    // Acquire durable exclusive claim (poll if held by a peer / prior op).
    for (;;) {
      if (tryClaimExclusive(holderId)) break;
      await sleep(pollIntervalMs);
    }
    localExclusiveHeld = true;
    notify();
    try {
      // Drain durable admissions (short reads + optional reclaim); no long write txn.
      // Poll so peer-process releases are visible; local notify short-circuits sleep.
      await waitUntilPolled(() => {
        reclaimStaleAdmissions();
        return countAdmissions() === 0;
      });
      if (hooks.afterExclusiveReady !== undefined) {
        await hooks.afterExclusiveReady();
      }
      return await body();
    } finally {
      localExclusiveHeld = false;
      releaseExclusive(holderId);
      gate.resolve();
      notify();
    }
  }

  /**
   * Grant a non-exclusive admission: insert the durable row inside one short
   * write transaction with zero awaits between the final checks and the insert.
   */
  async function beginNonExclusiveAdmit(form: "ledger-mutation" | "external-effect"): Promise<{
    id: string;
    epoch: number;
    roots: readonly string[];
    generation: number;
  }> {
    const stateAtEntry = readState();
    const generationAtEntry = stateAtEntry.admit_generation;
    for (;;) {
      await waitUntilPolled(() => !localExclusiveHeld && !exclusiveHeldDurable());
      if (hooks.beforeAdmissionGrant !== undefined) {
        await hooks.beforeAdmissionGrant();
      }
      // Atomic grant under IMMEDIATE write lock.
      const granted = immediateWriteTransaction(db, () => {
        const state = readState();
        if (state.admit_generation !== generationAtEntry) {
          return { kind: "revoked" as const };
        }
        const exclusive = readExclusive();
        if (exclusive !== null) {
          if (exclusive.host === selfHostname && !isPidAlive(exclusive.pid)) {
            db.query("DELETE FROM workset_exclusive WHERE id = 1").run();
          } else {
            return { kind: "busy" as const };
          }
        }
        // Include nowMs() for same-host PID-reuse safety (FS parity; D297).
        const id =
          form === "ledger-mutation"
            ? `lm-${selfPid}-${++nextAdmissionId}-${nowMs()}`
            : `ee-${selfPid}-${++nextAdmissionId}-${nowMs()}`;
        const roots = parseRootsJson(state.roots_json);
        db.query(
          `INSERT INTO workset_admissions (
             id, form, kind, epoch, roots_json, targets_json, target_ref,
             host, pid, started_at, pgid, leader_pid, settled, process_group_registered
           ) VALUES (?, ?, '', ?, ?, '[]', NULL, ?, ?, ?, NULL, NULL, ?, 0)`,
        ).run(
          id,
          form,
          state.epoch,
          state.roots_json,
          selfHostname,
          selfPid,
          nowMs(),
          form === "ledger-mutation" ? 1 : 0,
        );
        return {
          kind: "ok" as const,
          id,
          epoch: state.epoch,
          roots,
          generation: state.admit_generation,
        };
      });

      if (granted.kind === "revoked") {
        throw new WorksetAdmissionError(
          "revoked",
          "workset admission revoked by exclusive commit before grant",
        );
      }
      if (granted.kind === "busy") {
        continue;
      }
      notify();
      return {
        id: granted.id,
        epoch: granted.epoch,
        roots: granted.roots,
        generation: granted.generation,
      };
    }
  }

  function deleteAdmission(id: string): void {
    immediateWriteTransaction(db, () => {
      db.query("DELETE FROM workset_admissions WHERE id = ?").run(id);
    });
    notify();
  }

  function loadAdmission(id: string): WorksetAdmissionRow | null {
    return db
      .query(
        `SELECT id, form, kind, epoch, roots_json, targets_json, target_ref,
                host, pid, started_at, pgid, leader_pid, settled, process_group_registered
         FROM workset_admissions WHERE id = ?`,
      )
      .get(id) as WorksetAdmissionRow | null;
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
    const granted = await beginNonExclusiveAdmit("ledger-mutation");
    try {
      for (const target of input.targets) {
        if (!isTargetAdmitted(target, granted.roots)) {
          throw new WorksetAdmissionError(
            "target-excluded",
            `ledger mutation target "${target}" is outside the admitted workset`,
          );
        }
      }
      // Stamp kind + targets on the durable row (short write).
      immediateWriteTransaction(db, () => {
        db.query(
          "UPDATE workset_admissions SET kind = ?, targets_json = ? WHERE id = ?",
        ).run(input.kind, JSON.stringify(input.targets.slice()), granted.id);
      });
    } catch (err) {
      deleteAdmission(granted.id);
      throw err;
    }

    let open = true;
    const handle: WorksetLedgerMutationAdmission = {
      form: "ledger-mutation",
      id: granted.id,
      kind: input.kind,
      epoch: granted.epoch,
      roots: granted.roots.slice(),
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
        deleteAdmission(granted.id);
      },
    };
    registerLiveWorksetAdmission(handle);
    Object.freeze(handle);
    return handle;
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
    const granted = await beginNonExclusiveAdmit("external-effect");
    if (!isTargetAdmitted(input.targetRef, granted.roots)) {
      deleteAdmission(granted.id);
      throw new WorksetAdmissionError(
        "target-excluded",
        `external effect target "${input.targetRef}" is outside the admitted workset`,
      );
    }
    immediateWriteTransaction(db, () => {
      db.query(
        "UPDATE workset_admissions SET kind = ?, targets_json = ?, target_ref = ? WHERE id = ?",
      ).run(
        input.kind,
        JSON.stringify([input.targetRef]),
        input.targetRef,
        granted.id,
      );
    });

    let open = true;
    const handle: WorksetExternalEffectAdmission = {
      form: "external-effect",
      id: granted.id,
      kind: input.kind,
      epoch: granted.epoch,
      roots: granted.roots.slice(),
      targetRef: input.targetRef,
      get processGroupRegistered(): boolean {
        const row = loadAdmission(granted.id);
        return row !== null && row.process_group_registered === 1;
      },
      get settled(): boolean {
        const row = loadAdmission(granted.id);
        return row !== null && row.settled === 1;
      },
      registerProcessGroup(registration: WorksetProcessGroupRegistration): void {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "cannot register a process group on a closed external-effect admission",
          );
        }
        if (registration.pgid !== registration.leaderPid) {
          throw new WorksetAdmissionError(
            "invalid-replacement",
            "process-group registration requires leaderPid === pgid",
          );
        }
        immediateWriteTransaction(db, () => {
          const row = loadAdmission(granted.id);
          if (row === null) {
            throw new WorksetAdmissionError(
              "admission-closed",
              "cannot register a process group on a closed external-effect admission",
            );
          }
          if (row.process_group_registered === 1) {
            throw new WorksetAdmissionError(
              "process-group-already-registered",
              "external-effect admission already has a registered process group",
            );
          }
          db.query(
            "UPDATE workset_admissions SET pgid = ?, leader_pid = ?, process_group_registered = 1 WHERE id = ?",
          ).run(registration.pgid, registration.leaderPid, granted.id);
        });
      },
      markSettled(): void {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "cannot settle a closed external-effect admission",
          );
        }
        immediateWriteTransaction(db, () => {
          const row = loadAdmission(granted.id);
          if (row === null) {
            throw new WorksetAdmissionError(
              "admission-closed",
              "cannot settle a closed external-effect admission",
            );
          }
          if (row.process_group_registered !== 1) {
            throw new WorksetAdmissionError(
              "admission-not-registered",
              "cannot settle before process-group registration",
            );
          }
          db.query("UPDATE workset_admissions SET settled = 1 WHERE id = ?").run(granted.id);
        });
      },
      async releaseAfterSettlement(): Promise<void> {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "external-effect admission already released",
          );
        }
        const row = loadAdmission(granted.id);
        if (row === null) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "external-effect admission already released",
          );
        }
        if (row.process_group_registered !== 1) {
          throw new WorksetAdmissionError(
            "admission-not-registered",
            "external-effect admission requires process-group registration before release",
          );
        }
        if (row.settled !== 1) {
          throw new WorksetAdmissionError(
            "process-group-not-settled",
            "external-effect admission requires process-group settlement before release",
          );
        }
        open = false;
        unregisterLiveWorksetAdmission(handle);
        deleteAdmission(granted.id);
      },
    };
    registerLiveWorksetAdmission(handle);
    Object.freeze(handle);
    return handle;
  }

  async function setRoots(nextRoots: readonly string[]): Promise<WorksetRootsEpoch> {
    return runExclusive(async () => {
      const canonical = canonicalizeWorksetRootReplacement(nextRoots);
      if (validateReplacement !== undefined) {
        validateReplacement(canonical);
      }
      if (hooks.beforeCommit !== undefined) {
        await hooks.beforeCommit();
      }
      const committed = immediateWriteTransaction(db, () => {
        const state = readState();
        const nextEpoch = state.epoch + 1;
        const nextGen = state.admit_generation + 1;
        db.query(
          "UPDATE workset_state SET epoch = ?, roots_json = ?, admit_generation = ? WHERE id = 1",
        ).run(nextEpoch, JSON.stringify(canonical), nextGen);
        return { roots: canonical.slice(), epoch: nextEpoch };
      });
      notify();
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
    await runExclusive(async () => {
      if (hooks.beforeAdministrativeDestructive !== undefined) {
        await hooks.beforeAdministrativeDestructive();
      }
      await input.destructivePhase();
      immediateWriteTransaction(db, () => {
        const state = readState();
        db.query("UPDATE workset_state SET admit_generation = ? WHERE id = 1").run(
          state.admit_generation + 1,
        );
      });
      notify();
    });
  }

  return {
    snapshot,
    setRoots,
    admitLedgerMutation,
    admitExternalEffect,
    runAdministrative,
    activeAdmissionCount,
    exclusiveHeld,
  };
}
