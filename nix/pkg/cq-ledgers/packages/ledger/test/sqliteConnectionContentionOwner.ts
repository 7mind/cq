import { Database } from "bun:sqlite";
import type { ChildEvent, OwnerCommand } from "./sqliteConnectionContentionProtocol.js";

function send(event: ChildEvent): void {
  if (process.send === undefined) throw new Error("owner fixture requires Bun IPC");
  process.send(event);
}

async function run(): Promise<void> {
  const dbPath = process.argv[2];
  if (dbPath === undefined) throw new Error("owner fixture requires a database path");

  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
    send({ type: "owner-lock-acquired" });

    const command = await new Promise<unknown>((resolve) => {
      process.once("message", resolve);
    });
    if ((command as Partial<OwnerCommand>).type !== "release-owner") {
      throw new Error(`owner received invalid command: ${JSON.stringify(command)}`);
    }

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
