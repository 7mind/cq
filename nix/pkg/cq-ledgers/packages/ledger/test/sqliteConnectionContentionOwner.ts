import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  ORCHESTRATION_WAIT_MS,
  RELEASE_ACK_POLL_INTERVAL_MS,
  type ChildEvent,
} from "./sqliteConnectionContentionProtocol.js";

const pollState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function send(event: ChildEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function waitForRelease(releasePath: string): void {
  const deadline = Date.now() + ORCHESTRATION_WAIT_MS;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `owner release acknowledgement was not written before the ${String(ORCHESTRATION_WAIT_MS)}ms orchestration deadline`,
      );
    }
    Atomics.wait(pollState, 0, 0, Math.min(RELEASE_ACK_POLL_INTERVAL_MS, deadline - Date.now()));
  }
}

async function run(): Promise<void> {
  const dbPath = process.argv[2];
  const releasePath = process.argv[3];
  if (dbPath === undefined || releasePath === undefined) {
    throw new Error("owner fixture requires database and release acknowledgement paths");
  }

  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
    send({ type: "owner-lock-acquired" });

    waitForRelease(releasePath);

    db.exec("COMMIT");
    send({ type: "owner-released" });
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
