/**
 * divergence.ts — pure Pass-1 canonical-ledger schema-divergence
 * classification (T574, G81/M248), shared by `PostgresLedgerStore.init()`.
 *
 * Mirrors `SqliteLedgerStore.init()`'s inline Pass 1 (same
 * `schemasEqual`/`schemaCompatible` helpers from `../schemaCompat.js`): given
 * a tenant's PERSISTED `ledgers` rows and the current `CANONICAL_LEDGERS`
 * bootstrap set, classify every canonical ledger name into exactly one of:
 *
 *  - `missing` — no persisted row for this canonical name; provision from
 *    canon.
 *  - `widened` — a persisted schema that lacks only canon's added-OPTIONAL
 *    fields (T407's forward-compatible upgrade); upgrade `schema_json` in
 *    place, no data loss.
 *  - `divergent` — anything else (differing `idPrefix`/`statusValues`/
 *    `terminalStatuses`/`transitions`, a REQUIRED field added/changed, or a
 *    field present on disk but absent from canon); routes through the
 *    connecting store's `onSchemaDivergence` policy.
 *
 * Extracted as a pure function (row shapes in, classification out — no SQL,
 * no I/O) so it is unit-testable offline without a Postgres server, unlike
 * the surrounding `init()` which must talk to the database.
 */

import type { LedgerSchema } from "../../types.js";
import { schemaCompatible, schemasEqual } from "../schemaCompat.js";
import { CANONICAL_LEDGERS } from "../../constants.js";

export interface CanonicalDivergenceReport {
  readonly missing: string[];
  readonly widened: string[];
  readonly divergent: string[];
}

/**
 * Classify every canonical ledger name against `persistedByName` (the
 * tenant's currently-persisted schema for that name, if any). `canonical`
 * defaults to {@link CANONICAL_LEDGERS} — overridable so tests can exercise
 * the classification against small synthetic fixtures instead of the full
 * canonical set.
 */
export function classifyCanonicalLedgers(
  persistedByName: ReadonlyMap<string, LedgerSchema>,
  canonical: ReadonlyArray<{ name: string; schema: LedgerSchema }> = CANONICAL_LEDGERS,
): CanonicalDivergenceReport {
  const missing: string[] = [];
  const widened: string[] = [];
  const divergent: string[] = [];
  for (const canon of canonical) {
    const persisted = persistedByName.get(canon.name);
    if (persisted === undefined) {
      missing.push(canon.name);
      continue;
    }
    if (schemasEqual(persisted, canon.schema)) continue;
    if (schemaCompatible(persisted, canon.schema)) widened.push(canon.name);
    else divergent.push(canon.name);
  }
  return { missing, widened, divergent };
}
