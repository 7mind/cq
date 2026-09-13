import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createSqliteGenericMutationDataSource } from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema } from "../src/store/sqlite/schema.js";
import {
  GENERIC_MUTATION_DATA_SOURCE_ACTIVE_ITEMS,
  GENERIC_MUTATION_DATA_SOURCE_ARCHIVED_ITEMS,
  GENERIC_MUTATION_DATA_SOURCE_LEDGERS,
  runGenericMutationDataSourceContract,
} from "./genericMutationDataSourceContract.js";

runGenericMutationDataSourceContract({
  name: "sqlite",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  build: () => {
    const root = mkdtempSync(path.join(tmpdir(), "sqlite-generic-data-source-"));
    const db = openLedgerDb(path.join(root, "ledger.db"));
    ensureSchema(db);
    db.transaction(() => {
      const insertLedger = db.query(
        `INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter)
         VALUES (?, ?, ?, ?)`,
      );
      for (const ledger of GENERIC_MUTATION_DATA_SOURCE_LEDGERS) {
        insertLedger.run(
          ledger.id,
          JSON.stringify(ledger.schema),
          ledger.counters.milestone,
          ledger.counters.item,
        );
      }

      const insertGroup = db.query(
        "INSERT OR IGNORE INTO groups (ledger, id, title, description) VALUES (?, ?, ?, '')",
      );
      for (const { ledgerId, item } of GENERIC_MUTATION_DATA_SOURCE_ACTIVE_ITEMS) {
        insertGroup.run(ledgerId, item.milestoneId, item.milestoneId);
      }

      const insertItem = db.query(
        `INSERT INTO items (
           ledger, id, milestone_id, status, fields_json,
           created_at, updated_at, author, session
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const { ledgerId, item } of GENERIC_MUTATION_DATA_SOURCE_ACTIVE_ITEMS) {
        insertItem.run(
          ledgerId,
          item.id,
          item.milestoneId,
          item.status,
          JSON.stringify(item.fields),
          item.createdAt,
          item.updatedAt,
          item.author ?? null,
          item.session ?? null,
        );
      }

      const archived = GENERIC_MUTATION_DATA_SOURCE_ARCHIVED_ITEMS[0];
      if (archived === undefined) throw new Error("archived fixture is required");
      db.query(
        `INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at)
         VALUES (?, ?, 'fixture', 'fixture', 'done', ?)`,
      ).run(archived.ledgerId, archived.pointerId, archived.item.updatedAt);
      db.query(
        `INSERT INTO archived_items (
           ledger, pointer_id, id, milestone_id, status, fields_json,
           created_at, updated_at, author, session
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        archived.ledgerId,
        archived.pointerId,
        archived.item.id,
        archived.item.milestoneId,
        archived.item.status,
        JSON.stringify(archived.item.fields),
        archived.item.createdAt,
        archived.item.updatedAt,
        archived.item.author ?? null,
        archived.item.session ?? null,
      );
    })();

    return {
      source: createSqliteGenericMutationDataSource(db, undefined),
      dispose: () => {
        db.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
});
