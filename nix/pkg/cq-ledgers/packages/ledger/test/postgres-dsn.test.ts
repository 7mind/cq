/**
 * resolvePostgresDsn tests (T571, G81/M248) — pure DSN resolution for the
 * `postgres` ledger backend. No Postgres server needed: `config` and `env`
 * are plain in-memory objects the test constructs directly.
 *
 * Covers every precedence order (CQ_LEDGER_PG_URL > DATABASE_URL >
 * cq.toml [ledger].url), the PG*-only passthrough (driver-defaults sentinel),
 * and the fail-fast error naming every input considered.
 */

import { describe, expect, test } from "bun:test";
import {
  PG_DRIVER_DEFAULTS,
  PG_STANDARD_ENV_VARS,
  PostgresDsnResolutionError,
  resolvePostgresDsn,
} from "../src/store/postgres/dsn.js";

const NO_URL_CONFIG = { url: null };

describe("resolvePostgresDsn (T571)", () => {
  test("CQ_LEDGER_PG_URL alone resolves to a dsn from CQ_LEDGER_PG_URL", () => {
    const result = resolvePostgresDsn(NO_URL_CONFIG, {
      CQ_LEDGER_PG_URL: "postgres://explicit/db",
    });
    expect(result).toEqual({
      kind: "dsn",
      dsn: "postgres://explicit/db",
      source: "CQ_LEDGER_PG_URL",
    });
  });

  test("DATABASE_URL alone resolves to a dsn from DATABASE_URL", () => {
    const result = resolvePostgresDsn(NO_URL_CONFIG, {
      DATABASE_URL: "postgres://database-url/db",
    });
    expect(result).toEqual({
      kind: "dsn",
      dsn: "postgres://database-url/db",
      source: "DATABASE_URL",
    });
  });

  test("cq.toml [ledger].url alone resolves to a dsn from cq.toml [ledger].url", () => {
    const result = resolvePostgresDsn({ url: "postgres://cq-toml/db" }, {});
    expect(result).toEqual({
      kind: "dsn",
      dsn: "postgres://cq-toml/db",
      source: "cq.toml [ledger].url",
    });
  });

  test("CQ_LEDGER_PG_URL takes precedence over DATABASE_URL", () => {
    const result = resolvePostgresDsn(NO_URL_CONFIG, {
      CQ_LEDGER_PG_URL: "postgres://explicit/db",
      DATABASE_URL: "postgres://database-url/db",
    });
    expect(result).toEqual({
      kind: "dsn",
      dsn: "postgres://explicit/db",
      source: "CQ_LEDGER_PG_URL",
    });
  });

  test("CQ_LEDGER_PG_URL takes precedence over cq.toml [ledger].url", () => {
    const result = resolvePostgresDsn(
      { url: "postgres://cq-toml/db" },
      { CQ_LEDGER_PG_URL: "postgres://explicit/db" },
    );
    expect(result).toEqual({
      kind: "dsn",
      dsn: "postgres://explicit/db",
      source: "CQ_LEDGER_PG_URL",
    });
  });

  test("DATABASE_URL takes precedence over cq.toml [ledger].url", () => {
    const result = resolvePostgresDsn(
      { url: "postgres://cq-toml/db" },
      { DATABASE_URL: "postgres://database-url/db" },
    );
    expect(result).toEqual({
      kind: "dsn",
      dsn: "postgres://database-url/db",
      source: "DATABASE_URL",
    });
  });

  test("full precedence order: CQ_LEDGER_PG_URL > DATABASE_URL > cq.toml [ledger].url, all three set", () => {
    const result = resolvePostgresDsn(
      { url: "postgres://cq-toml/db" },
      {
        CQ_LEDGER_PG_URL: "postgres://explicit/db",
        DATABASE_URL: "postgres://database-url/db",
      },
    );
    expect(result).toEqual({
      kind: "dsn",
      dsn: "postgres://explicit/db",
      source: "CQ_LEDGER_PG_URL",
    });
  });

  test("blank CQ_LEDGER_PG_URL is treated as unset, falls through to DATABASE_URL", () => {
    const result = resolvePostgresDsn(NO_URL_CONFIG, {
      CQ_LEDGER_PG_URL: "   ",
      DATABASE_URL: "postgres://database-url/db",
    });
    expect(result).toEqual({
      kind: "dsn",
      dsn: "postgres://database-url/db",
      source: "DATABASE_URL",
    });
  });

  test("blank cq.toml [ledger].url is treated as unset (falls through to the PG*-passthrough check)", () => {
    const result = resolvePostgresDsn({ url: "   " }, { PGHOST: "localhost" });
    expect(result).toEqual({ kind: PG_DRIVER_DEFAULTS });
  });

  test("PG*-only passthrough: no CQ_LEDGER_PG_URL/DATABASE_URL/[ledger].url, but PGHOST set -> driver-defaults sentinel", () => {
    const result = resolvePostgresDsn(NO_URL_CONFIG, { PGHOST: "localhost" });
    expect(result).toEqual({ kind: PG_DRIVER_DEFAULTS });
  });

  test("PG*-only passthrough covers every standard libpq var individually", () => {
    for (const varName of PG_STANDARD_ENV_VARS) {
      const result = resolvePostgresDsn(NO_URL_CONFIG, { [varName]: "some-value" });
      expect(result).toEqual({ kind: PG_DRIVER_DEFAULTS });
    }
  });

  test("PG* vars are NOT consulted to build a dsn — only presence is checked (untouched passthrough, Q278)", () => {
    const result = resolvePostgresDsn(NO_URL_CONFIG, {
      PGHOST: "localhost",
      PGPORT: "5432",
      PGDATABASE: "mydb",
      PGUSER: "myuser",
      PGPASSWORD: "secret",
    });
    expect(result).toEqual({ kind: PG_DRIVER_DEFAULTS });
  });

  test("an explicit dsn still wins over PG* vars being present", () => {
    const result = resolvePostgresDsn(NO_URL_CONFIG, {
      CQ_LEDGER_PG_URL: "postgres://explicit/db",
      PGHOST: "localhost",
    });
    expect(result).toEqual({
      kind: "dsn",
      dsn: "postgres://explicit/db",
      source: "CQ_LEDGER_PG_URL",
    });
  });

  test("fail-fast: nothing resolves (empty env, no [ledger].url) -> PostgresDsnResolutionError", () => {
    expect(() => resolvePostgresDsn(NO_URL_CONFIG, {})).toThrow(PostgresDsnResolutionError);
  });

  test("fail-fast: only unrelated env vars set -> PostgresDsnResolutionError", () => {
    expect(() =>
      resolvePostgresDsn(NO_URL_CONFIG, { PATH: "/usr/bin", HOME: "/home/user" }),
    ).toThrow(PostgresDsnResolutionError);
  });

  test("fail-fast error message names CQ_LEDGER_PG_URL, DATABASE_URL, and [ledger].url", () => {
    try {
      resolvePostgresDsn(NO_URL_CONFIG, {});
      throw new Error("expected resolvePostgresDsn to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PostgresDsnResolutionError);
      const message = (err as Error).message;
      expect(message).toContain("CQ_LEDGER_PG_URL");
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("[ledger].url");
    }
  });

  test("fail-fast error's name is PostgresDsnResolutionError", () => {
    try {
      resolvePostgresDsn(NO_URL_CONFIG, {});
      throw new Error("expected resolvePostgresDsn to throw");
    } catch (err) {
      expect((err as Error).name).toBe("PostgresDsnResolutionError");
    }
  });
});
