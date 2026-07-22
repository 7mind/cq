/**
 * dsn.ts — DSN resolution for the `postgres` ledger backend (T571, G81/M248).
 *
 * A pure function over `(config, env)` — no I/O, no driver import — so it is
 * unit-testable without a Postgres server. It resolves ONE of three outcomes
 * (Q278 hybrid: committed cq.toml default + env override):
 *
 *  1. a DSN string, from the first of (highest precedence first):
 *     - `CQ_LEDGER_PG_URL` — an explicit, ledger-specific override. Highest
 *       precedence so a developer/CI job can point THIS process at a
 *       throwaway/test database without touching any other env var or the
 *       committed cq.toml.
 *     - `DATABASE_URL` — the conventional cross-tool env var many hosting
 *       platforms (Heroku, Fly, Railway, …) already inject.
 *     - `[ledger].url` in cq.toml — the committed, credential-less default
 *       (T570; `LedgerConfig.url`).
 *  2. the {@link PG_DRIVER_DEFAULTS} sentinel, when none of the three above is
 *     set BUT at least one standard libpq `PG*` environment variable IS set
 *     (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSERVICE`,
 *     `PGSSLMODE`, `PGOPTIONS`, `PGPASSFILE`, `PGAPPNAME`). Those variables
 *     pass through to the driver UNTOUCHED (Q277/Q278 — Bun's `SQL`/libpq
 *     read them itself); this module never reads or concatenates them into a
 *     DSN, it only checks presence to decide whether to defer to the driver
 *     instead of throwing.
 *  3. {@link PostgresDsnResolutionError}, when NONE of the above is set — a
 *     `backend = 'postgres'` cq.toml with no way to reach a database is a
 *     misconfiguration, and connecting-instance startup must fail fast with
 *     an actionable message rather than let a downstream driver call fail
 *     with an opaque connection error.
 */

import type { LedgerConfig } from "@cq/config";

/** The `CQ_LEDGER_PG_URL` / `DATABASE_URL` env vars, in resolution precedence order. */
const PG_URL_ENV_VARS = ["CQ_LEDGER_PG_URL", "DATABASE_URL"] as const;

/**
 * Standard libpq environment variables that Postgres client drivers (incl.
 * Bun's `SQL`) read directly. Presence of ANY of these — with no explicit DSN
 * resolved — means "let the driver use its own defaults" rather than a
 * misconfiguration (outcome 2 above).
 */
export const PG_STANDARD_ENV_VARS = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSERVICE",
  "PGSSLMODE",
  "PGOPTIONS",
  "PGPASSFILE",
  "PGAPPNAME",
] as const;

/** Sentinel `kind` meaning "no DSN was resolved — let the driver read PG* defaults". */
export const PG_DRIVER_DEFAULTS = "driver-defaults" as const;

/** Where a resolved DSN string came from — surfaced for logging/diagnostics. */
export type PgDsnSource = "CQ_LEDGER_PG_URL" | "DATABASE_URL" | "cq.toml [ledger].url";

/**
 * The three explicit outcomes of {@link resolvePostgresDsn}: an actual DSN
 * string (with its {@link PgDsnSource}), or the {@link PG_DRIVER_DEFAULTS}
 * sentinel. A fourth outcome — no resolution at all — is NOT part of this
 * union; it is instead a thrown {@link PostgresDsnResolutionError} (fail
 * fast, per the module doc).
 */
export type PgDsnResolution =
  | { readonly kind: "dsn"; readonly dsn: string; readonly source: PgDsnSource }
  | { readonly kind: typeof PG_DRIVER_DEFAULTS };

/**
 * Thrown when `backend = 'postgres'` but NONE of `CQ_LEDGER_PG_URL`,
 * `DATABASE_URL`, `[ledger].url`, or any standard `PG*` env var resolves a
 * way to reach a database — a fail-fast, actionable error naming every
 * input this resolver considered, mirroring {@link ProjectKeyResolutionError}'s
 * style.
 */
export class PostgresDsnResolutionError extends Error {
  constructor() {
    super(
      `[ledger] backend = 'postgres' but no Postgres connection info was found. Set ONE of: the ` +
        `CQ_LEDGER_PG_URL environment variable (highest precedence), the DATABASE_URL environment ` +
        `variable, or [ledger].url in cq.toml — or set the standard PG* libpq environment variables ` +
        `(PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSERVICE, PGSSLMODE, PGOPTIONS, ` +
        `PGPASSFILE, PGAPPNAME) so the driver can use its own defaults.`,
    );
    this.name = "PostgresDsnResolutionError";
  }
}

/** A blank (empty or whitespace-only) string counts as "not set" throughout this resolver. */
function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * Resolve the Postgres connection config for `backend = 'postgres'` from
 * `config` (the loaded `[ledger]` table) and `env` (the process environment).
 * Pure — performs no I/O and never touches the network or a real driver — so
 * it is fully unit-testable without a Postgres server.
 *
 * Precedence (highest first): `env.CQ_LEDGER_PG_URL` > `env.DATABASE_URL` >
 * `config.url`. If none resolves but a standard `PG*` env var is present,
 * returns the {@link PG_DRIVER_DEFAULTS} sentinel. Otherwise throws
 * {@link PostgresDsnResolutionError}.
 */
export function resolvePostgresDsn(
  config: Pick<LedgerConfig, "url">,
  env: Readonly<Record<string, string | undefined>>,
): PgDsnResolution {
  for (const varName of PG_URL_ENV_VARS) {
    const value = env[varName];
    if (isSet(value)) {
      return { kind: "dsn", dsn: value, source: varName };
    }
  }

  if (isSet(config.url ?? undefined)) {
    return { kind: "dsn", dsn: config.url as string, source: "cq.toml [ledger].url" };
  }

  if (PG_STANDARD_ENV_VARS.some((varName) => isSet(env[varName]))) {
    return { kind: PG_DRIVER_DEFAULTS };
  }

  throw new PostgresDsnResolutionError();
}
