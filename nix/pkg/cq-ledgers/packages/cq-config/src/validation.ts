/**
 * JSON-Schema validation helper for the typed prompt catalog (T343, goal G41).
 *
 * The prompt-catalog sidecars store PLAIN JSON Schema (draft 2020-12) data; this
 * module is the SINGLE place that compiles + runs them with the chosen validator
 * (Ajv 2020 — decision 2 of T336). It lives in `@cq/config` because Ajv is a
 * DIRECT dependency here (and only here) — so a consumer that needs to validate
 * a dispatched role's input/output against its sidecar (the ledger-mcp
 * direct `validateInput`/`validateOutput` inspection APIs (T343) reuse THIS helper rather than
 * pulling Ajv into its own package.
 *
 * The 2020-12 dialect entrypoint (`ajv/dist/2020`) is required because the
 * catalog schemas declare `$schema: …/draft/2020-12/schema`; `strict:false`
 * permits the schemas' annotation keywords (`title`/`description`), and
 * `allErrors:true` collects EVERY failing constraint (not just the first) so the
 * caller can surface all failing JSON-Schema paths.
 *
 * This module imports `ajv/dist/2020` (a node-resolvable runtime dependency); it
 * is NOT browser-bundleable, unlike the pure {@link ./promptCatalog} /
 * {@link ./promptCatalogStore} data modules. Consumers that only need the schema
 * DATA must import those; this helper is for the validation flow.
 */

import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject } from "ajv";
import type { JSONSchema } from "./promptCatalog.js";

/**
 * One structured validation error: the failing JSON-Schema instance path (the
 * field path into the validated value, e.g. `/goalId`; `""` for the root), the
 * human-readable message, the failed keyword, and the schema path that produced
 * it. Mirrors Ajv's {@link ErrorObject} but flattened to a stable, transport-safe
 * shape (no Ajv types leak across the package boundary).
 */
export interface ValidationError {
  /** The failing value's location (Ajv `instancePath`; `""` = the root value). */
  readonly path: string;
  /** Human-readable failure message (Ajv `message`). */
  readonly message: string;
  /** The JSON-Schema keyword that failed (e.g. `required`, `type`, `pattern`). */
  readonly keyword: string;
  /** The schema location that produced the failure (Ajv `schemaPath`). */
  readonly schemaPath: string;
  /** The keyword's parameters (e.g. `{ missingProperty: "goalId" }`). */
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * The result of {@link validateAgainstSchema}: either `{ ok: true }` or
 * `{ ok: false, errors }` carrying EVERY failing constraint (allErrors).
 */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/** A fresh Ajv compiling draft 2020-12 schemas; `strict:false` allows annotations. */
function newAjv(): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true });
}

/** Flatten one Ajv {@link ErrorObject} into a transport-safe {@link ValidationError}. */
function toValidationError(e: ErrorObject): ValidationError {
  return {
    path: e.instancePath,
    message: e.message ?? `failed ${e.keyword}`,
    keyword: e.keyword,
    schemaPath: e.schemaPath,
    params: e.params as Record<string, unknown>,
  };
}

/**
 * Validate `data` against `schema` (draft 2020-12) with Ajv. Returns
 * `{ ok: true }` on success, or `{ ok: false, errors }` with every failing
 * constraint's structured error (the failing field path included). Compiles the
 * schema per call — the catalog schemas are small and this helper has no caching
 * (consistent with the re-read-per-call capability methods).
 *
 * Throws only if `schema` is not a valid JSON Schema (an authoring defect, not a
 * data-validation failure) — Ajv's `compile` raises in that case.
 */
export function validateAgainstSchema(schema: JSONSchema, data: unknown): ValidationResult {
  const ajv = newAjv();
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (valid) {
    return { ok: true };
  }
  const errors = (validate.errors ?? []).map(toValidationError);
  return { ok: false, errors };
}
