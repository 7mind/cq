import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { SearchProjectionCommand } from "../src/search/SearchProjection.js";
import { coherenceVersion } from "../src/store/sqlite/connection.js";
import type { SqliteCoherenceChange } from "../src/store/sqlite/coherenceVector.js";
import type { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { assertSqliteAccessContract, type SqliteAccessRecord, type SqliteOperationRecord } from "../src/store/sqlite/operationObservability.js";

export interface LifecycleProjectionEffect {
  readonly kind: "document" | "snapshot" | "bucket" | "remove-ledger";
  readonly keys: readonly string[];
}

export function lifecycleProjectionEffects(command: SearchProjectionCommand): LifecycleProjectionEffect[] {
  if (command.kind === "snapshot") return [{ kind: "snapshot", keys: command.buckets.flatMap((bucket) => bucket.items.map((item) => `${bucket.ledgerId}:${item.id}`)) }];
  if (command.kind !== "delta") return [];
  return command.changes.map((change) => {
    if (change.kind === "replace-bucket") return { kind: "bucket", keys: change.bucket.items.map((item) => `${change.bucket.ledgerId}:${item.id}`) };
    if (change.kind === "remove-ledger") return { kind: "remove-ledger", keys: [change.ledgerId] };
    return { kind: "document", keys: [`${change.ledgerId}:${change.kind === "upsert" ? change.item.id : change.itemId}`] };
  });
}

export interface LifecycleBoundsObservation {
  readonly committed: boolean;
  readonly resultHash: string;
  readonly accesses: readonly SqliteAccessRecord[];
  readonly coherence: readonly SqliteCoherenceChange[];
  readonly projectedDocuments: readonly string[];
  readonly versionIncrement: number;
}

export interface LifecycleBoundsDiagnostic {
  readonly phases: readonly SqliteOperationRecord[];
  readonly readRows: number;
  readonly attemptedWrittenRows: number;
  readonly coherenceKeys: number;
  readonly projectedDocuments: number;
}

export interface LifecycleBoundsReport {
  readonly observations: readonly LifecycleBoundsObservation[];
  readonly diagnostics: readonly LifecycleBoundsDiagnostic[];
}

export interface LifecycleBoundsFixture {
  readonly store: SqliteLedgerStore;
  readonly db: Database;
  readonly accesses: SqliteAccessRecord[];
  readonly operations: SqliteOperationRecord[];
  readonly projectionEffects: LifecycleProjectionEffect[];
}

export class LifecycleBoundsMeasurement {
  private beforeVersion: number | null = null;
  private readonly observations: LifecycleBoundsObservation[] = [];
  private readonly diagnostics: LifecycleBoundsDiagnostic[] = [];

  constructor(private readonly fixture: LifecycleBoundsFixture) {}

  start(): void {
    assert.equal(this.beforeVersion, null, "previous bounds measurement was not finished");
    this.fixture.accesses.length = 0;
    this.fixture.operations.length = 0;
    this.fixture.projectionEffects.length = 0;
    this.beforeVersion = coherenceVersion(this.fixture.db);
  }

  finish(result: unknown): void {
    this.record(result, true);
  }

  rejected(result: unknown): void {
    this.record(result, false);
  }

  private record(result: unknown, committed: boolean): void {
    assert.notEqual(this.beforeVersion, null, "bounds measurement was not started");
    const { accesses, operations, projectionEffects } = this.fixture;
    for (const access of accesses) assertSqliteAccessContract(access);
    const frame = this.fixture.store.readCoherenceChanges(this.beforeVersion!);
    const coherence = frame.entries.map(({ ledger, documentId, scope, kind }) => ({ ledger, documentId, scope, kind }));
    const privateWrites = accesses.filter(({ table, mode }) => table.startsWith("plan_") && mode === "write")
      .flatMap(({ table, rowKeys }) => rowKeys.map((key) => `${table}:${key}`)).sort();
    assert.deepEqual(coherence.filter(({ scope }) => scope === "control").map(({ documentId }) => documentId).sort(), committed ? privateWrites : []);
    if (!committed) assert.equal(frame.version, this.beforeVersion);
    const publicWrites = accesses.filter(({ table, mode }) => table === "items" && mode === "write").flatMap(({ rowKeys }) => rowKeys).sort();
    assert.deepEqual(coherence.filter(({ scope }) => scope === "active").map(({ ledger, documentId }) => `${ledger}:${documentId}`).sort(), committed ? publicWrites : []);
    assert.equal(frame.version, this.beforeVersion! + (coherence.length === 0 ? 0 : 1));
    assert(projectionEffects.every(({ kind }) => kind === "document"), "lifecycle rebuilt an unrelated projection bucket");
    const projectedDocuments = projectionEffects.flatMap(({ keys }) => keys).sort();
    assert.deepEqual(projectedDocuments, coherence.filter(({ scope }) => scope === "active" || scope === "archived")
      .map(({ ledger, documentId }) => `${ledger}:${documentId}`).sort());
    const normalizedAccesses = accesses.map((access) => access.table !== "workset_admissions" ? access : {
      ...access, keyedPredicate: { ...access.keyedPredicate, keys: ["current-admission"] }, rowKeys: access.rowKeys.length === 0 ? [] : ["current-admission"],
    });
    this.observations.push({ committed, resultHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      accesses: structuredClone(normalizedAccesses), coherence, projectedDocuments, versionIncrement: frame.version - this.beforeVersion! });
    this.diagnostics.push({ phases: structuredClone(operations),
      readRows: accesses.filter(({ mode }) => mode === "read").reduce((total, { count }) => total + count, 0),
      attemptedWrittenRows: accesses.filter(({ mode }) => mode === "write").reduce((total, { count }) => total + count, 0),
      coherenceKeys: coherence.length, projectedDocuments: projectedDocuments.length });
    this.beforeVersion = null;
  }

  report(): LifecycleBoundsReport {
    assert.equal(this.beforeVersion, null, "unfinished bounds measurement");
    return { observations: this.observations, diagnostics: this.diagnostics };
  }
}

export function lifecycleDomainDigest(db: Database): string {
  const hash = createHash("sha256");
  for (const table of ["items", "groups", "ledgers", "archived_items", "archive_pointers", "item_references", "plan_claims", "plan_operations", "coherence_state", "coherence_vector"]) {
    hash.update(table);
    for (const row of db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()) hash.update(JSON.stringify(row));
  }
  return hash.digest("hex");
}

export async function measureRejectedLifecycle(fixture: LifecycleBoundsFixture, measurement: LifecycleBoundsMeasurement,
  invoke: () => Promise<unknown>, message: RegExp): Promise<void> {
  const before = lifecycleDomainDigest(fixture.db);
  measurement.start();
  let rejection: unknown;
  try { await invoke(); } catch (error) { rejection = error; }
  assert(rejection instanceof Error, "expected a rejected lifecycle operation");
  assert.match(rejection.message, message);
  measurement.rejected({ name: rejection.name, message: rejection.message });
  assert.equal(lifecycleDomainDigest(fixture.db), before, "rejected lifecycle changed durable state");
}
