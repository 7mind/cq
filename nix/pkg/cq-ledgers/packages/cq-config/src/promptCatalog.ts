/**
 * Typed prompt-catalog data model (T336, goal G41; reconciling G38 / Q185).
 *
 * This module establishes the TYPED catalog that REPLACES the hand-authored
 * `agentsCatalogue`/`roleActions` prose as the single source of truth for
 * agent/subagent prompts plus their input/output schemas. It is the FOUNDATIONAL
 * design task of the T336→T341→T343→T344→T345 chain; later tasks generalise the
 * one-role proof here (plan-advance) across the full roster and wire the
 * validate-in/validate-out flow into the dispatch/return path.
 *
 * ## The three decisions LOCKED by T336 (see decisions ledger item)
 *
 * 1. **Role scope (dispatched-subagent vs orchestrator-command).** The Q148
 *    roster has two kinds of role and only ONE of them has a parent-validated
 *    contract:
 *    - **DISPATCHED-SUBAGENT** roles ({@link RoleKind} `"dispatched-subagent"`)
 *      have a non-null `agentTierKey` ({@link AGENT_ROLE_TIERS}): plan-advance,
 *      plan-reviewer, implement-worker, implement-reviewer,
 *      implement-conflict-resolver, investigate-explorer, investigate-prober
 *      (and, as the chain generalises, plan-synthesizer). A parent dispatches
 *      them with a supplied INPUT and consumes a validated OUTPUT, so ONLY these
 *      roles carry formal `inputSchema` + `outputSchema` and take part in the
 *      validate-in / validate-out flow.
 *    - **ORCHESTRATOR-COMMAND** roles ({@link RoleKind} `"orchestrator-command"`)
 *      have `agentTierKey === null` (not separately model-configurable): the
 *      `/cq:*` commands. They are never dispatched-with-a-validated-input by a
 *      parent, so they carry the prompt + metadata but NO parent-validated
 *      input/output contract (`inputSchema`/`outputSchema` stay `undefined`).
 *
 * 2. **Validator — Ajv 8.** No JSON-Schema validator was a DIRECT declared
 *    dependency of any cq-ledgers workspace package (zod 4 is a direct dep of
 *    `@cq/ledger` only and is a code-first schema builder, not a JSON-Schema
 *    validator; ajv 8 / ajv 6 / `@cfworker/json-schema` existed only TRANSITIVELY
 *    via the MCP SDK and eslint and were not resolvable from a workspace import).
 *    So T336 adds the most-recent stable Ajv (`ajv@^8.20.0`) as a direct
 *    dependency of `@cq/config` and performs the mandatory node-modules FOD
 *    refresh in the SAME task so `nix build .#node-modules` stays green. The
 *    schemas in this catalog are PLAIN JSON Schema (draft 2020-12), so any
 *    JSON-Schema validator can consume them; Ajv is the chosen compiler.
 *
 * 3. **Storage format — per-role typed sidecar modules.** Each role's
 *    `inputSchema`/`outputSchema` live in a per-role TS sidecar co-located under
 *    `./schemas/<role>.ts` (e.g. {@link ./schemas/plan-advance.ts}), NOT embedded
 *    in the prose `## Catalogue` blocks of the asset markdown. The codegen
 *    (`gen-agents-catalogue.ts`) and any consumer import the typed sidecar; the
 *    prose Catalogue block stays human documentation. T336 authors the FIRST such
 *    sidecar (plan-advance); later tasks add the rest.
 */

/**
 * Which side of the flow a catalog role plays — the LOCKED role-scope split
 * (decision 1). The discriminant is intrinsic: it is fixed by whether the role
 * is dispatched-with-a-validated-input by a parent.
 */
export type RoleKind = "dispatched-subagent" | "orchestrator-command";

/**
 * The cross-tool model-tier label a role is dispatched at (the vocabulary the
 * `/implement:*` and `/plan:*` loops resolve to a concrete model per host).
 * Mirrors the `tasks.suggestedModel` tiers used elsewhere in the suite.
 */
export type ModelTier = "frontier" | "standard" | "fast";

/**
 * The rendered prompt artifact a catalog entry targets. This domain remains
 * distinct from {@link Harness}: `Harness` selects a dispatch transport,
 * whereas a prompt surface selects a rendered prompt representation.
 */
export const PROMPT_SURFACES = ["claude", "codex", "pi"] as const;

/** A closed rendered-prompt target vocabulary. */
export type PromptSurface = (typeof PROMPT_SURFACES)[number];

/** Type guard for values crossing the Nix-JSON boundary. */
export function isPromptSurface(value: unknown): value is PromptSurface {
  return typeof value === "string" && (PROMPT_SURFACES as readonly string[]).includes(value);
}

/**
 * The semantic classes of cross-surface prompt differences identified by RS2.
 * These classify declarations only; T657 compares declarations with rendered
 * artifacts.
 */
export const INTENTIONAL_DIFFERENCE_KINDS = [
  "invocation-syntax",
  "dispatch-protocol",
  "recursion-protocol",
  "tool-vocabulary",
] as const;

/** A closed intentional-difference classification vocabulary. */
export type IntentionalDifferenceKind = (typeof INTENTIONAL_DIFFERENCE_KINDS)[number];

/** Type guard for intentional-difference kinds crossing an untyped boundary. */
export function isIntentionalDifferenceKind(value: unknown): value is IntentionalDifferenceKind {
  return (
    typeof value === "string" && (INTENTIONAL_DIFFERENCE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * A declared semantic difference between two or more rendered prompt surfaces.
 */
export interface IntentionalDifferenceDeclaration {
  readonly kind: IntentionalDifferenceKind;
  readonly reason: string;
  readonly surfaces: readonly PromptSurface[];
}

/**
 * A JSON Schema document (draft 2020-12), kept as a structural object type
 * rather than `any`: the catalog stores schemas as data, and the validator
 * (Ajv) compiles them. We intentionally do not re-derive the full JSON-Schema
 * meta-grammar as TypeScript types — that is Ajv's job at runtime — but we DO
 * name the type so a `PromptCatalogEntry`'s schema fields are not `unknown`.
 */
export interface JSONSchema {
  /** The dialect identifier (e.g. `https://json-schema.org/draft/2020-12/schema`). */
  readonly $schema?: string;
  /** An optional identifier/title for the schema. */
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  /** The JSON type(s) this schema accepts. */
  readonly type?: JSONSchemaType | readonly JSONSchemaType[];
  /** Object-schema keywords. */
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JSONSchema;
  /** Array-schema keyword. */
  readonly items?: JSONSchema;
  /** Enumerated allowed values (used for the plan-advance status token). */
  readonly enum?: readonly (string | number | boolean | null)[];
  /** Composition keywords. */
  readonly oneOf?: readonly JSONSchema[];
  readonly anyOf?: readonly JSONSchema[];
  readonly allOf?: readonly JSONSchema[];
  /** String constraints. */
  readonly minLength?: number;
  readonly pattern?: string;
  /** Numeric constraints. */
  readonly minimum?: number;
  readonly maximum?: number;
  /** Array constraints. */
  readonly minItems?: number;
  /** Any other JSON-Schema keyword the author writes — kept open by design. */
  readonly [keyword: string]: unknown;
}

/** The seven primitive JSON-Schema `type` values. */
export type JSONSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/** JSON Schema for the Nix-serialized intentional-difference boundary. */
export const INTENTIONAL_DIFFERENCE_DECLARATION_SCHEMA: JSONSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: INTENTIONAL_DIFFERENCE_KINDS,
    },
    reason: {
      type: "string",
      minLength: 1,
      pattern: "\\S",
    },
    surfaces: {
      type: "array",
      items: {
        type: "string",
        enum: PROMPT_SURFACES,
      },
      minItems: 2,
      uniqueItems: true,
    },
  },
  required: ["kind", "reason", "surfaces"],
  additionalProperties: false,
};

/** Boundary-validation failure for prompt-catalog JSON data. */
export class PromptCatalogSchemaError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "PromptCatalogSchemaError";
  }
}

function parsePromptSurface(value: unknown, path: string): PromptSurface {
  if (!isPromptSurface(value)) {
    throw new PromptCatalogSchemaError(path, `expected one of ${PROMPT_SURFACES.join(", ")}`);
  }
  return value;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode and validate one declaration received from Nix JSON or another
 * untyped boundary.
 */
export function parseIntentionalDifferenceDeclaration(
  value: unknown,
): IntentionalDifferenceDeclaration {
  const rootPath = "intentionalDifference";
  if (!isUnknownRecord(value)) {
    throw new PromptCatalogSchemaError(rootPath, "expected an object");
  }

  const expectedKeys = ["kind", "reason", "surfaces"] as const;
  const unexpectedKey = Object.keys(value)
    .sort()
    .find((key) => !(expectedKeys as readonly string[]).includes(key));
  if (unexpectedKey !== undefined) {
    throw new PromptCatalogSchemaError(`${rootPath}.${unexpectedKey}`, "unexpected property");
  }

  const kind = value.kind;
  if (!isIntentionalDifferenceKind(kind)) {
    throw new PromptCatalogSchemaError(
      `${rootPath}.kind`,
      `expected one of ${INTENTIONAL_DIFFERENCE_KINDS.join(", ")}`,
    );
  }

  const reason = value.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new PromptCatalogSchemaError(`${rootPath}.reason`, "expected a non-empty string");
  }

  const rawSurfaces = value.surfaces;
  if (!Array.isArray(rawSurfaces)) {
    throw new PromptCatalogSchemaError(`${rootPath}.surfaces`, "expected an array");
  }
  if (rawSurfaces.length < 2) {
    throw new PromptCatalogSchemaError(
      `${rootPath}.surfaces`,
      "expected at least two participating surfaces",
    );
  }

  const surfaces = rawSurfaces.map((surface, index) =>
    parsePromptSurface(surface, `${rootPath}.surfaces[${index}]`),
  );
  const seen = new Set<PromptSurface>();
  for (const [index, surface] of surfaces.entries()) {
    if (seen.has(surface)) {
      throw new PromptCatalogSchemaError(
        `${rootPath}.surfaces[${index}]`,
        `duplicate prompt surface "${surface}"`,
      );
    }
    seen.add(surface);
  }

  return { kind, reason, surfaces };
}

/** Decode a JSON document and validate it as one intentional difference. */
export function parseIntentionalDifferenceDeclarationJSON(
  json: string,
): IntentionalDifferenceDeclaration {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new PromptCatalogSchemaError("intentionalDifference", "expected valid JSON");
  }
  return parseIntentionalDifferenceDeclaration(value);
}

/**
 * Validate and serialize one declaration with a deterministic field order.
 */
export function serializeIntentionalDifferenceDeclaration(
  declaration: IntentionalDifferenceDeclaration,
): string {
  const validated = parseIntentionalDifferenceDeclaration(declaration);
  return JSON.stringify({
    kind: validated.kind,
    reason: validated.reason,
    surfaces: validated.surfaces,
  });
}

/**
 * ONE entry in the typed prompt catalog — the single source of truth for a
 * role's prompt + (for dispatched subagents) its input/output contract.
 *
 * `inputSchema` / `outputSchema` are present IFF `kind === "dispatched-subagent"`
 * (decision 1); orchestrator-command entries leave them `undefined`. This is an
 * INVARIANT the catalog assembler enforces — not encoded as a discriminated
 * union here because both kinds share every other field and consumers branch on
 * `kind` explicitly.
 */
export interface PromptCatalogEntry {
  /** Stable role id — the {@link AGENT_ROLE_TIERS} join key (e.g. `plan-advance`). */
  readonly id: string;
  /** The role-scope discriminant (decision 1). */
  readonly kind: RoleKind;
  /**
   * Whether a parent dispatches this role with a supplied input and consumes a
   * validated output. `true` for every `dispatched-subagent`, `false` for every
   * `orchestrator-command`. Redundant with {@link kind} by construction, kept as
   * an explicit boolean so call sites reading the validate-in/out gate need not
   * re-derive it from the `kind` string.
   */
  readonly dispatched: boolean;
  /**
   * The model tier the role is dispatched at, or `null` for an
   * orchestrator-command (not separately model-configurable — it only chains
   * subagents). Mirrors the `agentTierKey === null` rule.
   */
  readonly tier: ModelTier | null;
  /**
   * Monotonic schema/version stamp for THIS entry's contract, bumped when the
   * input/output schema or prompt changes in a breaking way. Starts at 1.
   */
  readonly version: number;
  /** The full prompt-template body (the asset markdown after its frontmatter). */
  readonly promptTemplate: string;
  /**
   * The parent-supplied INPUT contract as JSON Schema — present ONLY for a
   * `dispatched-subagent` (decision 1). `undefined` for orchestrator-commands.
   */
  readonly inputSchema?: JSONSchema;
  /**
   * The validated OUTPUT contract as JSON Schema — present ONLY for a
   * `dispatched-subagent` (decision 1). `undefined` for orchestrator-commands.
   */
  readonly outputSchema?: JSONSchema;
}

/**
 * The per-role schema sidecar shape (storage-format decision 3): each
 * `./schemas/<role>.ts` exports one of these. The codegen / catalog assembler
 * joins it onto the role's prompt + metadata to produce a full
 * {@link PromptCatalogEntry}. Only dispatched-subagent roles have a sidecar.
 */
export interface RoleSchemaSidecar {
  /** The role id this sidecar describes (must match an {@link AGENT_ROLE_TIERS} id). */
  readonly id: string;
  /** Contract version stamp (see {@link PromptCatalogEntry.version}). */
  readonly version: number;
  /** The parent-supplied input contract. */
  readonly inputSchema: JSONSchema;
  /** The validated output contract. */
  readonly outputSchema: JSONSchema;
}
