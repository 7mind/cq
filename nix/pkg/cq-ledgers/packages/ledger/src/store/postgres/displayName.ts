/**
 * displayName.ts — the RECONCILED project display-name chain (Q270, T574,
 * G81/M248), for the `projects.display_name` column of the multi-tenant
 * Postgres backend.
 *
 * A pure function over its four candidate inputs — no I/O, no cq.toml
 * parsing, no filesystem access — so it is unit-testable without a Postgres
 * server. The caller (T577's factory) is responsible for gathering the actual
 * candidates (cq.toml `[project].name`, cq.toml `[ledger].projectId`, the repo
 * root's basename, and the resolved `projectKey`) and re-running this chain on
 * EVERY connect, so a display-name change (e.g. a cq.toml rename) propagates
 * on reconnect via {@link PostgresLedgerStoreOpts.displayName}'s UPSERT
 * (Q270 — supersedes Q279's original record-once-at-registration policy: an
 * UPSERT that re-derives the same value on every connect subsumes recording
 * once, since "once" is just the first of infinitely many identical UPSERTs).
 *
 * Precedence (highest first), each rung skipped when blank/absent:
 *  1. `projectName` — cq.toml `[project].name`
 *  2. `projectId` — cq.toml `[ledger].projectId`
 *  3. `repoBasename` — basename of the repository root
 *  4. `projectKey` — the tenant key itself; ALWAYS present, so this rung never
 *     fails to resolve (there is no fifth outcome / thrown error, unlike
 *     {@link resolvePostgresDsn} in dsn.ts).
 */

/** The four display-name candidates, highest precedence first. */
export interface DisplayNameCandidates {
  /** cq.toml `[project].name`, or `null`/`undefined` when absent. */
  readonly projectName: string | null | undefined;
  /** cq.toml `[ledger].projectId`, or `null`/`undefined` when absent. */
  readonly projectId: string | null | undefined;
  /** Basename of the repository root, or `null`/`undefined` when unavailable. */
  readonly repoBasename: string | null | undefined;
  /** The tenant key — the always-available final fallback. */
  readonly projectKey: string;
}

/** A blank (empty or whitespace-only) string counts as "not set" throughout this resolver. */
function isSet(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== "";
}

/**
 * Resolve the RECONCILED display name from {@link DisplayNameCandidates},
 * per the precedence documented on the module. Never throws — `projectKey`
 * is the guaranteed last rung.
 */
export function resolveDisplayName(candidates: DisplayNameCandidates): string {
  if (isSet(candidates.projectName)) return candidates.projectName;
  if (isSet(candidates.projectId)) return candidates.projectId;
  if (isSet(candidates.repoBasename)) return candidates.repoBasename;
  return candidates.projectKey;
}
