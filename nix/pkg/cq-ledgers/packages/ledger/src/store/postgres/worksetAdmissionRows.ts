import type { WorksetLedgerMutationAdmission } from "../../worksetEffectAdmission.js";
import type { PostgresOperationQueries } from "./operationAccess.js";

export async function postgresAdmissionMatches(queries: PostgresOperationQueries, admission: WorksetLedgerMutationAdmission): Promise<boolean> {
  queries.recordReadTarget({ table: "workset_roots" });
  queries.recordReadTarget({ table: "workset_admissions", id: admission.id });
  const durable = await queries.execute<{ form: string; kind: string; epoch: number; targets_json: string }>({
    phase: "transaction", table: "workset_admissions", mode: "read", lockMode: "none",
    predicate: { kind: "primary-key", keys: [admission.id] },
  }, { sql: "SELECT form, kind, epoch, targets_json FROM workset_admissions WHERE project_key = $1 AND admission_id = $2",
    parameters: [queries.projectKey, admission.id] }, () => admission.id);
  const roots = await queries.execute<{ epoch: number; roots_json: string }>({
    phase: "transaction", table: "workset_roots", mode: "read", lockMode: "none",
    predicate: { kind: "primary-key", keys: ["roots"] },
  }, { sql: "SELECT epoch, roots_json FROM workset_roots WHERE project_key = $1", parameters: [queries.projectKey] }, () => "roots");
  const row = durable[0];
  const current = roots[0];
  return row !== undefined && current !== undefined && row.form === "ledger-mutation" && row.kind === admission.kind &&
    Number(row.epoch) === admission.epoch && Number(current.epoch) === admission.epoch &&
    current.roots_json === JSON.stringify(admission.roots) && row.targets_json === JSON.stringify(admission.targets);
}
