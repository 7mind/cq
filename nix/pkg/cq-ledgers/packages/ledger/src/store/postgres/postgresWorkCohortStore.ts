import type { SQL } from "bun";

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

interface WorkCohortRow {
  readonly state_json: string;
  readonly execution_epoch: string;
  readonly resume_required: boolean;
  readonly lease_json: string | null;
  readonly resume_validation_json: string | null;
  readonly revision: string | number;
}

function parseNullable<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

function documentFromRow(row: WorkCohortRow): WorkCohortStoredDocumentV1 {
  return {
    portable: parseWorkCohortPortableStateV1(row.state_json),
    runtime: {
      executionEpoch: row.execution_epoch,
      resumeRequired: row.resume_required,
      lease: parseNullable(row.lease_json),
      resumeValidation: parseNullable(row.resume_validation_json),
    },
    revision: Number(row.revision),
  };
}

async function readRow(
  sql: SQL,
  projectKey: string,
  lock: boolean,
): Promise<WorkCohortStoredDocumentV1> {
  const rows = lock
    ? await sql<WorkCohortRow[]>`
        SELECT state_json, execution_epoch, resume_required, lease_json, resume_validation_json, revision
        FROM work_cohort_state WHERE project_key = ${projectKey} FOR UPDATE
      `
    : await sql<WorkCohortRow[]>`
        SELECT state_json, execution_epoch, resume_required, lease_json, resume_validation_json, revision
        FROM work_cohort_state WHERE project_key = ${projectKey}
      `;
  const row = rows[0];
  if (row === undefined) throw new Error(`PostgreSQL work cohort state is not initialized for ${projectKey}`);
  return documentFromRow(row);
}

async function writeRow(
  sql: SQL,
  projectKey: string,
  document: WorkCohortStoredDocumentV1,
): Promise<void> {
  const lease = document.runtime.lease === null ? null : JSON.stringify(document.runtime.lease);
  const resume =
    document.runtime.resumeValidation === null
      ? null
      : JSON.stringify(document.runtime.resumeValidation);
  await sql`
    UPDATE work_cohort_state SET
      state_json = ${JSON.stringify(document.portable)},
      execution_epoch = ${document.runtime.executionEpoch},
      resume_required = ${document.runtime.resumeRequired},
      lease_json = ${lease},
      resume_validation_json = ${resume},
      revision = ${document.revision}
    WHERE project_key = ${projectKey}
  `;
}

export async function replacePostgresWorkCohortPortableState(
  sql: SQL,
  projectKey: string,
  portable: WorkCohortPortableStateV1,
): Promise<void> {
  const document = newWorkCohortStoredDocumentV1(portable);
  await sql`
    INSERT INTO work_cohort_state
      (project_key, state_json, execution_epoch, resume_required, lease_json, resume_validation_json, revision)
    VALUES (${projectKey}, ${JSON.stringify(document.portable)}, ${document.runtime.executionEpoch}, TRUE, NULL, NULL, ${document.revision})
    ON CONFLICT (project_key) DO UPDATE SET
      state_json = EXCLUDED.state_json,
      execution_epoch = EXCLUDED.execution_epoch,
      resume_required = TRUE,
      lease_json = NULL,
      resume_validation_json = NULL,
      revision = EXCLUDED.revision
  `;
}

export class PostgresWorkCohortPersistence implements WorkCohortPersistence {
  readonly #pool: SQL;
  readonly #projectKey: string;

  constructor(pool: SQL, projectKey: string) {
    this.#pool = pool;
    this.#projectKey = projectKey;
  }

  async initialize(): Promise<void> {
    const initial = newWorkCohortStoredDocumentV1();
    await this.#pool`
      INSERT INTO work_cohort_state
        (project_key, state_json, execution_epoch, resume_required, lease_json, resume_validation_json, revision)
      VALUES (${this.#projectKey}, ${JSON.stringify(initial.portable)}, ${initial.runtime.executionEpoch}, FALSE, NULL, NULL, 0)
      ON CONFLICT (project_key) DO NOTHING
    `;
  }

  read(): Promise<WorkCohortStoredDocumentV1> {
    return readRow(this.#pool, this.#projectKey, false);
  }

  async transact<T>(
    mutation: (current: WorkCohortStoredDocumentV1) => {
      readonly next: WorkCohortStoredDocumentV1;
      readonly result: T;
    },
  ): Promise<T> {
    return await this.#pool.begin(async (tx) => {
      const changed = mutation(await readRow(tx, this.#projectKey, true));
      await writeRow(tx, this.#projectKey, changed.next);
      return changed.result;
    });
  }

  async replacePortable(portable: WorkCohortPortableStateV1): Promise<void> {
    await this.#pool.begin(async (tx) => {
      await readRow(tx, this.#projectKey, true);
      await replacePostgresWorkCohortPortableState(tx, this.#projectKey, portable);
    });
  }

  async clear(): Promise<void> {
    await this.transact(() => ({ next: newWorkCohortStoredDocumentV1(), result: undefined }));
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

export async function createPostgresWorkCohortStore(
  pool: SQL,
  projectKey: string,
): Promise<WorkCohortStore> {
  const persistence = new PostgresWorkCohortPersistence(pool, projectKey);
  await persistence.initialize();
  return new PersistentWorkCohortStore(persistence);
}
