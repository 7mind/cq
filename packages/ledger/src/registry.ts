/**
 * Registry — read/write of `./docs/ledgers.yaml`.
 *
 * v1 schema:
 *   version: 1
 *   ledgers:
 *     - name: <string>
 *       schema:
 *         statusValues: [...]
 *         terminalStatuses: [...]
 *         fields:
 *           <name>:
 *             type: <FieldType>
 *             required: <bool>
 */

import YAML from "yaml";
import type {
  FieldSpec,
  FieldType,
  LedgerRegistry,
  LedgerRegistryEntry,
  LedgerSchema,
} from "./types.js";
import { SchemaValidationError } from "./types.js";
import { validateSchema } from "./store/core.js";

const FIELD_TYPES: ReadonlyArray<FieldType> = [
  "string",
  "string[]",
  "id",
  "id[]",
  "timestamp",
];

export function parseRegistry(yamlText: string): LedgerRegistry {
  let raw: unknown;
  try {
    raw = YAML.parse(yamlText);
  } catch (e) {
    throw new SchemaValidationError(`ledgers.yaml is not valid YAML: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object") {
    // Tolerate an empty file by treating it as a fresh registry.
    if (raw === null || raw === undefined) {
      return { version: 1, ledgers: [] };
    }
    throw new SchemaValidationError("ledgers.yaml is not a map");
  }
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== 1) {
    throw new SchemaValidationError(`unsupported ledgers.yaml version: ${String(obj["version"])}`);
  }
  const ledgersRaw = obj["ledgers"];
  const ledgers: LedgerRegistryEntry[] = [];
  if (Array.isArray(ledgersRaw)) {
    for (const entry of ledgersRaw) {
      ledgers.push(parseEntry(entry));
    }
  } else if (ledgersRaw !== undefined && ledgersRaw !== null) {
    throw new SchemaValidationError("ledgers.yaml: ledgers must be an array");
  }
  return { version: 1, ledgers };
}

function parseEntry(raw: unknown): LedgerRegistryEntry {
  if (raw === null || typeof raw !== "object") {
    throw new SchemaValidationError("ledger entry must be a map");
  }
  const e = raw as Record<string, unknown>;
  const name = e["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new SchemaValidationError("ledger entry.name must be a non-empty string");
  }
  return { name, schema: parseSchema(e["schema"]) };
}

export function parseSchema(raw: unknown): LedgerSchema {
  if (raw === null || typeof raw !== "object") {
    throw new SchemaValidationError("schema must be a map");
  }
  const s = raw as Record<string, unknown>;
  const statusValues = s["statusValues"];
  if (!Array.isArray(statusValues) || statusValues.some((v) => typeof v !== "string")) {
    throw new SchemaValidationError("schema.statusValues must be string[]");
  }
  const terminalStatuses = s["terminalStatuses"];
  if (
    !Array.isArray(terminalStatuses) ||
    terminalStatuses.some((v) => typeof v !== "string")
  ) {
    throw new SchemaValidationError("schema.terminalStatuses must be string[]");
  }
  const sv = statusValues as string[];
  const ts = terminalStatuses as string[];
  const fieldsRaw = s["fields"];
  const fields: Record<string, FieldSpec> = {};
  if (fieldsRaw !== undefined && fieldsRaw !== null) {
    if (typeof fieldsRaw !== "object") {
      throw new SchemaValidationError("schema.fields must be a map");
    }
    for (const [key, val] of Object.entries(fieldsRaw as Record<string, unknown>)) {
      fields[key] = parseFieldSpec(key, val);
    }
  }
  const idPrefixRaw = s["idPrefix"];
  let idPrefix: string | undefined;
  if (idPrefixRaw !== undefined && idPrefixRaw !== null) {
    if (typeof idPrefixRaw !== "string") {
      throw new SchemaValidationError("schema.idPrefix must be a string");
    }
    idPrefix = idPrefixRaw;
  }
  const transitions = parseTransitions(s["transitions"]);
  // D-LED-02: enforce cross-layer invariants (terminal subset, em-dash-free
  // status values, field name regex, reserved field names, idPrefix shape).
  const schema: LedgerSchema = { statusValues: sv, terminalStatuses: ts, fields };
  if (idPrefix !== undefined) schema.idPrefix = idPrefix;
  if (transitions !== undefined) schema.transitions = transitions;
  validateSchema(schema);
  return schema;
}

/**
 * Parse the optional `transitions` map (F1): a record of from-status →
 * string[] of allowed to-statuses. Returns undefined when absent/null.
 * Only the shape (a map of string keys to string[] values) is enforced here.
 * Status-membership of the from/to entries against statusValues is enforced by
 * the subsequent `validateSchema` call in `parseSchema`, which throws a
 * `SchemaValidationError` on any unknown from/to status.
 */
function parseTransitions(raw: unknown): Record<string, string[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SchemaValidationError("schema.transitions must be a map");
  }
  const out: Record<string, string[]> = {};
  for (const [from, tos] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(tos) || tos.some((v) => typeof v !== "string")) {
      throw new SchemaValidationError(
        `schema.transitions["${from}"] must be a string[]`,
      );
    }
    out[from] = tos as string[];
  }
  return out;
}

function parseFieldSpec(name: string, raw: unknown): FieldSpec {
  if (raw === null || typeof raw !== "object") {
    throw new SchemaValidationError(`field "${name}" must be a map`);
  }
  const r = raw as Record<string, unknown>;
  const type = r["type"];
  if (typeof type !== "string" || !(FIELD_TYPES as readonly string[]).includes(type)) {
    throw new SchemaValidationError(
      `field "${name}".type must be one of ${FIELD_TYPES.join("|")}`,
    );
  }
  const required = r["required"];
  if (typeof required !== "boolean") {
    throw new SchemaValidationError(`field "${name}".required must be boolean`);
  }
  return { type: type as FieldType, required };
}

export function serializeRegistry(registry: LedgerRegistry): string {
  const obj: Record<string, unknown> = {
    version: registry.version,
    ledgers: registry.ledgers.map((e) => {
      const schema: Record<string, unknown> = {
        statusValues: e.schema.statusValues,
        terminalStatuses: e.schema.terminalStatuses,
        fields: Object.fromEntries(
          Object.entries(e.schema.fields).map(([k, v]) => [
            k,
            { type: v.type, required: v.required },
          ]),
        ),
      };
      if (e.schema.idPrefix !== undefined) schema["idPrefix"] = e.schema.idPrefix;
      if (e.schema.transitions !== undefined) {
        schema["transitions"] = Object.fromEntries(
          Object.entries(e.schema.transitions).map(([from, tos]) => [from, [...tos]]),
        );
      }
      return { name: e.name, schema };
    }),
  };
  return YAML.stringify(obj, { lineWidth: 0 });
}

export const EMPTY_REGISTRY: LedgerRegistry = { version: 1, ledgers: [] };
