import type { Database } from "bun:sqlite";

import {
  PersistentWorkCohortStore,
  newWorkCohortStoredDocumentV1,
  workCohortHasPendingSealedCandidateV1,
  parseWorkCohortPortableStateV1,
  type WorkCohortPersistence,
  type WorkCohortPortableStateV1,
  type WorkCohortStore,
  type WorkCohortStoredDocumentV1,
} from "../../workCohortStore.js";
import { immediateWriteTransaction } from "./connection.js";

interface WorkCohortRow {
  readonly state_json: string;
  readonly execution_epoch: string;
  readonly resume_required: number;
  readonly lease_json: string | null;
  readonly resume_validation_json: string | null;
  readonly revision: number;
}

function parseNullable<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

function readDocument(db: Database): WorkCohortStoredDocumentV1 {
  const row = db
    .query<WorkCohortRow, []>(
      `SELECT state_json, execution_epoch, resume_required, lease_json, resume_validation_json, revision
       FROM work_cohort_state WHERE id = 1`,
    )
    .get();
  if (row === null) throw new Error("SQLite work cohort state is not initialized");
  return {
    portable: parseWorkCohortPortableStateV1(row.state_json),
    runtime: {
      executionEpoch: row.execution_epoch,
      resumeRequired: row.resume_required === 1,
      lease: parseNullable(row.lease_json),
      resumeValidation: parseNullable(row.resume_validation_json),
    },
    revision: row.revision,
  };
}

function writeDocument(db: Database, document: WorkCohortStoredDocumentV1): void {
  db.query(
    `UPDATE work_cohort_state
     SET state_json = ?, execution_epoch = ?, resume_required = ?, lease_json = ?,
         resume_validation_json = ?, revision = ?
     WHERE id = 1`,
  ).run(
    JSON.stringify(document.portable),
    document.runtime.executionEpoch,
    document.runtime.resumeRequired ? 1 : 0,
    document.runtime.lease === null ? null : JSON.stringify(document.runtime.lease),
    document.runtime.resumeValidation === null
      ? null
      : JSON.stringify(document.runtime.resumeValidation),
    document.revision,
  );
}

export function replaceSqliteWorkCohortPortableState(
  db: Database,
  portable: WorkCohortPortableStateV1,
): void {
  const document = newWorkCohortStoredDocumentV1(portable);
  db.query(
    `INSERT INTO work_cohort_state
       (id, state_json, execution_epoch, resume_required, lease_json, resume_validation_json, revision)
     VALUES (1, ?, ?, 1, NULL, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
       state_json = excluded.state_json,
       execution_epoch = excluded.execution_epoch,
       resume_required = 1,
       lease_json = NULL,
       resume_validation_json = NULL,
       revision = excluded.revision`,
  ).run(JSON.stringify(document.portable), document.runtime.executionEpoch, document.revision);
}

export class SqliteWorkCohortPersistence implements WorkCohortPersistence {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
    const initial = newWorkCohortStoredDocumentV1();
    this.#db
      .query(
        `INSERT OR IGNORE INTO work_cohort_state
           (id, state_json, execution_epoch, resume_required, lease_json, resume_validation_json, revision)
         VALUES (1, ?, ?, 0, NULL, NULL, 0)`,
      )
      .run(JSON.stringify(initial.portable), initial.runtime.executionEpoch);
  }

  async read(): Promise<WorkCohortStoredDocumentV1> {
    return readDocument(this.#db);
  }

  async transact<T>(
    mutation: (current: WorkCohortStoredDocumentV1) => {
      readonly next: WorkCohortStoredDocumentV1;
      readonly result: T;
    },
  ): Promise<T> {
    let result!: T;
    immediateWriteTransaction(this.#db, () => {
      const changed = mutation(readDocument(this.#db));
      writeDocument(this.#db, changed.next);
      result = changed.result;
    });
    return result;
  }

  async replacePortable(portable: WorkCohortPortableStateV1): Promise<void> {
    immediateWriteTransaction(this.#db, () => replaceSqliteWorkCohortPortableState(this.#db, portable));
  }

  async clear(): Promise<void> {
    immediateWriteTransaction(this.#db, () => writeDocument(this.#db, newWorkCohortStoredDocumentV1()));
  }

  async rotateRuntime(): Promise<void> {
    await this.transact((current) => {
      const fresh = newWorkCohortStoredDocumentV1(current.portable);
      return {
        next: {
          ...fresh,
          runtime: {
            ...fresh.runtime,
            resumeRequired: workCohortHasPendingSealedCandidateV1(current.portable),
          },
          revision: current.revision + 1,
        },
        result: undefined,
      };
    });
  }
}

export async function createSqliteWorkCohortStore(
  db: Database,
): Promise<WorkCohortStore> {
  const persistence = new SqliteWorkCohortPersistence(db);
  return new PersistentWorkCohortStore(persistence);
}
