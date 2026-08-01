import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  BUSY_TIMEOUT_PRAGMA,
  CHILD_DEADLINE_MS,
  LEGACY_WAL_CALL_SITE,
  PUBLIC_INITIALIZER_CEILING_MS,
  PUBLIC_WAL_CALL_SITE,
  RELEASE_ACK_POLL_INTERVAL_MS,
  WAL_PRAGMA,
  sqliteErrorReport,
  type ChildEvent,
} from "./sqliteConnectionContentionProtocol.js";

const pollState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function send(event: ChildEvent): void {
  if (process.send === undefined) throw new Error("contender fixture requires Bun IPC");
  process.send(event);
}

function hasPrimaryBusyErrno(error: unknown): boolean {
  return sqliteErrorReport(error).primaryErrno === 5;
}

function waitForReleaseAck(releaseAckPath: string, deadline: number): void {
  while (!existsSync(releaseAckPath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `release acknowledgement was not written before the ${String(CHILD_DEADLINE_MS)}ms child deadline`,
      );
    }
    Atomics.wait(pollState, 0, 0, Math.min(RELEASE_ACK_POLL_INTERVAL_MS, deadline - Date.now()));
  }
}

function legacyJournalBeforeTimeout(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  const originalExec = Database.prototype.exec;
  try {
    try {
      originalExec.call(db, WAL_PRAGMA);
      throw new Error("legacy journal-before-timeout control unexpectedly acquired WAL mode");
    } catch (error) {
      if (!hasPrimaryBusyErrno(error)) throw error;
      send({
        type: "legacy-control-result",
        walAttempts: 1,
        busyTimeoutInstalled: false,
        callSite: LEGACY_WAL_CALL_SITE,
        ...sqliteErrorReport(error),
      });
    }
  } finally {
    db.close();
  }
}

async function usePublicInitializer(
  dbPath: string,
  releaseAckPath: string,
  contenderId: string,
  childDeadline: number,
): Promise<void> {
  const originalExec = Database.prototype.exec;
  let busyTimeoutInstalled = false;
  let firstWalError: unknown = undefined;
  let walAttempts = 0;

  const interceptedExec = function (this: Database, sql: string) {
    if (sql === BUSY_TIMEOUT_PRAGMA) {
      const result = originalExec.call(this, sql);
      busyTimeoutInstalled = true;
      send({
        type: "busy-timeout-installed",
        contenderId,
        sql: BUSY_TIMEOUT_PRAGMA,
      });
      return result;
    }

    if (sql !== WAL_PRAGMA) return originalExec.call(this, sql);

    walAttempts += 1;
    if (walAttempts === 1) send({ type: "pre-wal-ready", contenderId });
    send({
      type: "wal-attempt",
      contenderId,
      attempt: walAttempts,
      sql: WAL_PRAGMA,
      busyTimeoutInstalled,
    });
    try {
      const result = originalExec.call(this, sql);
      send({
        type: "wal-attempt-succeeded",
        contenderId,
        attempt: walAttempts,
        sql: WAL_PRAGMA,
      });
      return result;
    } catch (error) {
      if (walAttempts !== 1 || !hasPrimaryBusyErrno(error)) throw error;
      firstWalError = error;
      send({
        type: "first-wal-busy-held",
        contenderId,
        attempt: 1,
        callSite: PUBLIC_WAL_CALL_SITE,
        busyTimeoutInstalled,
        ...sqliteErrorReport(error),
      });
      waitForReleaseAck(releaseAckPath, childDeadline);
      send({ type: "release-ack-observed", contenderId });
      send({ type: "first-wal-busy-rethrown", contenderId });
      throw error;
    }
  };

  Database.prototype.exec = interceptedExec;
  const startedAt = Date.now();
  let opened: Database | undefined;
  try {
    const { openLedgerDb } = await import("../src/store/sqlite/connection.js");
    try {
      opened = openLedgerDb(dbPath);
      send({
        type: "initializer-succeeded",
        contenderId,
        elapsedMs: Date.now() - startedAt,
        walAttempts,
      });
    } catch (error) {
      send({
        type: "initializer-error",
        contenderId,
        elapsedMs: Date.now() - startedAt,
        walAttempts,
        sameError: error === firstWalError,
        callSite: PUBLIC_WAL_CALL_SITE,
        ...sqliteErrorReport(error),
      });
    }
  } finally {
    opened?.close();
    Database.prototype.exec = originalExec;
    send({
      type: "exec-restored",
      contenderId,
      restored: Database.prototype.exec === originalExec,
    });
  }

  if (Date.now() - startedAt > PUBLIC_INITIALIZER_CEILING_MS) {
    throw new Error(
      `public initializer exceeded ${String(PUBLIC_INITIALIZER_CEILING_MS)}ms ceiling`,
    );
  }
}

async function run(): Promise<void> {
  const mode = process.argv[2];
  const dbPath = process.argv[3];
  const releaseAckPath = process.argv[4];
  const contenderId = process.argv[5];
  const scenarioStartedAtText = process.argv[6];
  if (mode === undefined || dbPath === undefined) {
    throw new Error("contender fixture requires mode and database path");
  }
  if (mode === "legacy") {
    legacyJournalBeforeTimeout(dbPath);
    return;
  }
  const scenarioStartedAt = Number(scenarioStartedAtText);
  if (
    mode !== "public" ||
    releaseAckPath === undefined ||
    contenderId === undefined ||
    scenarioStartedAtText === undefined ||
    !Number.isFinite(scenarioStartedAt)
  ) {
    throw new Error("public contender requires release-ack path and contender id");
  }
  await usePublicInitializer(
    dbPath,
    releaseAckPath,
    contenderId,
    scenarioStartedAt + CHILD_DEADLINE_MS,
  );
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
