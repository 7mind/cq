/**
 * Server-side dispatch-input ASSEMBLY FROM REFS (T978, goal G94).
 *
 * The deepest remaining parent-context cost after T975. T975 stopped the parent
 * materializing role PROMPTS, but the parent still read task/defect/hypothesis
 * NARRATIVE out of the ledger into its own context purely to render it into the
 * dispatch prompt: `commands/cq/implement/advance.md` §2 mandates that "the
 * prompt MUST carry: the task id + verbatim `headline`/`description`/
 * `acceptance`, the branch … and (on a re-dispatch) the prior round's
 * `criticism[]`", and §1 reads every target milestone at `projection: "full"`
 * precisely to obtain it. That content was parent-visible ONLY because the
 * parent acted as COURIER.
 *
 * This module is the input-side mirror of the output side's `store_result`:
 *
 * **Prepare accepts REFS ({@link DispatchInputRefs}) and assembles the typed
 * role input SERVER-SIDE from the ledger. The parent passes ids it already
 * holds; the child retrieves the assembled input by handle.**
 *
 * Three properties make that a real cutover rather than a rename:
 *
 *  1. **The refs form is closed and narrative-free.** Its key set
 *     ({@link DISPATCH_INPUT_REFS_FIELDS}) carries ids, non-narrative worktree
 *     coordinates, a round, and typed bounded parent guidance — nothing else. A
 *     form carrying an assembled narrative field INLINE
 *     ({@link ASSEMBLED_NARRATIVE_FIELDS}, DERIVED from the role sidecars) is
 *     rejected as `inline-narrative-courier`: the parent must not be the
 *     courier, not even optionally.
 *  2. **Assembly flows THROUGH T976's validation, never around it.**
 *     {@link assembleDispatchInput} finishes by calling
 *     {@link validateDispatchInput}, so the assembled input is validated against
 *     the role's bound `inputSchema` and the declared overlay data inside
 *     prepare, fail-closed before launch, and the T976 acceptance is carried on
 *     the result ({@link DispatchInputAssembled.validation}).
 *  3. **Every pre-launch failure is T976's ONE rejection type.** An
 *     unresolvable or cross-project ref, an inline-narrative form, and invalid
 *     parent guidance are all {@link DispatchPreLaunchRejection} values built by
 *     {@link dispatchPreLaunchRejection} — distinct from every T682 lifecycle
 *     state, and never a second parallel rejection shape.
 *
 * Parent guidance (an answered question folded into a re-dispatch, an operator
 * note) is a TYPED BOUNDED field, not free prompt text: an answered question is
 * a REF ONLY — prepare reads the answer from the ledger, so even that narrative
 * never reaches parent context — and an operator note is length- and
 * count-bounded ({@link PARENT_GUIDANCE_NOTE_MAX_LENGTH},
 * {@link PARENT_GUIDANCE_MAX_ENTRIES}). Arbitrary prompt text remains rejected
 * per T684: the only prompt-mutation path is a registered typed overlay.
 *
 * A native Claude CHILD performs NO role-prompt retrieval
 * ({@link NATIVE_CLAUDE_CHILD_RETRIEVAL}) — `bun run gen-agents` bakes the role
 * prompt into `agents/<role>.md`, which the harness injects at the child's
 * system boundary. A child-side prompt fetch would re-add exactly the cost T975
 * removed, so {@link assertNoRolePromptRetrieval} pins it.
 *
 * SCOPE. Contract level only, mirroring how T682/T683/T684/T976 landed:
 * `prepare_dispatch` does not exist yet (T695 exposes it over MCP; T977 owns
 * runtime wiring). This module builds no MCP tool, registers no server route,
 * and invents no attestation store. What that leaves out is recorded in
 * {@link DISPATCH_REF_ASSEMBLY_DEFERRED}.
 *
 * The ledger is reached through the {@link DispatchNarrativeSource} PORT, not by
 * importing `@cq/ledger` — `@cq/ledger` depends on `@cq/config`, so the reverse
 * import would be a cycle. The against-a-real-ledger conformance suite therefore
 * lives in `packages/ledger/test/dispatch-refs-assembly.test.ts`, which can see
 * both.
 *
 * This module calls {@link validateDispatchInput} (Ajv) and `Bun.CryptoHasher`,
 * and is therefore NOT browser-bundleable, like {@link ./validation},
 * {@link ./dispatchOverlays}, and {@link ./dispatchInputValidation}.
 */

import { DISPATCHED_ROLE_SIDECARS } from "./promptCatalogStore.js";
import { PROMPT_SURFACES, type JSONSchema, type PromptSurface } from "./promptCatalog.js";
import {
  DISPATCH_OVERLAY_REGISTRY,
  dispatchOverlayListSchema,
  type DispatchOverlayRegistry,
} from "./dispatchOverlays.js";
import {
  DISPATCH_PRE_LAUNCH_OUTCOME,
  dispatchPreLaunchRejection,
  validateDispatchInput,
  type DispatchInputAccepted,
  type DispatchPreLaunchRejection,
} from "./dispatchInputValidation.js";
import type { DispatchJSONValue, DispatchOverlayApplication } from "./compactDispatchProtocol.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * Authoring defect in a refs-assembly declaration or a non-JSON value handed to
 * the canonical serializer. Distinct from a {@link DispatchPreLaunchRejection},
 * which is DATA describing rejected dispatch input, not a broken declaration.
 */
export class DispatchRefAssemblyError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "DispatchRefAssemblyError";
  }
}

// ---------------------------------------------------------------------------
// Canonical input bytes — the identity the byte-equality cutover proof rests on
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new DispatchRefAssemblyError(path, "a non-finite number is not JSON-serializable");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new DispatchRefAssemblyError(path, `a ${typeof value} value is not JSON-serializable`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalJson(entry, `${path}[${index}]`)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  // Object.keys: OWN enumerable keys only, so no inherited Object.prototype
  // member can contribute bytes to a canonical input digest.
  const keys = Object.keys(record).sort();
  const members = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key], `${path}.${key}`)}`,
  );
  return `{${members.join(",")}}`;
}

/**
 * The canonical UTF-8 bytes of one role input: JSON with object keys sorted, so
 * two assemblies of the same content compare byte-for-byte regardless of the
 * order in which their properties were built. Throws
 * {@link DispatchRefAssemblyError} for any non-JSON value (`undefined`, a
 * function, a symbol, `NaN`), which must never reach a dispatch input.
 */
export function canonicalDispatchInputBytes(input: DispatchJSONValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(input, "input"));
}

/** Lowercase hex SHA-256 of {@link canonicalDispatchInputBytes}. */
export function dispatchInputDigest(input: DispatchJSONValue): string {
  return new Bun.CryptoHasher("sha256").update(canonicalDispatchInputBytes(input)).digest("hex");
}

// ---------------------------------------------------------------------------
// What the parent may pass, and what prepare must assemble
// ---------------------------------------------------------------------------

/**
 * Role-input properties the REFS FORM legitimately supplies: the task id and the
 * non-narrative worktree coordinates, round, and resolved model class — facts the
 * parent already holds without reading any narrative. Everything ELSE in a
 * ref-assembled role's `inputSchema` is narrative prepare reads from the ledger
 * ({@link ASSEMBLED_NARRATIVE_FIELDS}).
 */
export const REFS_SUPPLIED_INPUT_FIELDS = [
  "taskId",
  "worktreePath",
  "branch",
  "baseCommit",
  "round",
  "resolvedModel",
] as const;

const REFS_SUPPLIED_INPUT_FIELD_SET: ReadonlySet<string> = new Set(REFS_SUPPLIED_INPUT_FIELDS);

/** The dispatched roles for which a server-side ref assembler is declared. */
export const REF_ASSEMBLED_ROLES = ["implement-worker"] as const;

export type RefAssembledRoleId = (typeof REF_ASSEMBLED_ROLES)[number];

const REF_ASSEMBLED_ROLE_SET: ReadonlySet<string> = new Set(REF_ASSEMBLED_ROLES);

function narrativeFieldsOf(roleId: RefAssembledRoleId): readonly string[] {
  const schema = DISPATCHED_ROLE_SIDECARS[roleId].inputSchema as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const properties = schema.properties;
  if (properties === undefined) {
    return [];
  }
  return Object.keys(properties).filter((name) => !REFS_SUPPLIED_INPUT_FIELD_SET.has(name));
}

/**
 * Every role-input property prepare assembles from the ledger, DERIVED from the
 * {@link REF_ASSEMBLED_ROLES} sidecars rather than hand-listed — a new narrative
 * field on a ref-assembled role contract is covered the moment it is authored,
 * and the set widens automatically as T977 declares further assemblers. Sorted
 * for a stable declaration; the per-role view is
 * {@link assembledNarrativeFieldsFor}.
 */
export const ASSEMBLED_NARRATIVE_FIELDS: readonly string[] = Object.freeze(
  [...new Set(REF_ASSEMBLED_ROLES.flatMap(narrativeFieldsOf))].sort(),
);

const ASSEMBLED_NARRATIVE_FIELD_SET: ReadonlySet<string> = new Set(ASSEMBLED_NARRATIVE_FIELDS);

/** The narrative properties prepare assembles for ONE ref-assembled role. */
export function assembledNarrativeFieldsFor(roleId: RefAssembledRoleId): readonly string[] {
  // Set membership: no Object.prototype name resolves a phantom assembled role.
  if (!REF_ASSEMBLED_ROLE_SET.has(roleId)) {
    throw new DispatchRefAssemblyError(
      "roleId",
      `no server-side ref assembler is declared for role "${String(roleId)}"`,
    );
  }
  return Object.freeze([...narrativeFieldsOf(roleId)].sort());
}

// ---------------------------------------------------------------------------
// The refs-only launch form
// ---------------------------------------------------------------------------

/** Non-narrative worktree coordinates: git facts, not ledger narrative. */
export interface DispatchWorktreeCoordinates {
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
}

export const PARENT_GUIDANCE_KINDS = ["answered-question", "operator-note"] as const;

export type ParentGuidanceKind = (typeof PARENT_GUIDANCE_KINDS)[number];

const PARENT_GUIDANCE_KIND_SET: ReadonlySet<string> = new Set(PARENT_GUIDANCE_KINDS);

/** At most this many guidance entries may be folded into one dispatch. */
export const PARENT_GUIDANCE_MAX_ENTRIES = 8;

/** An operator note is bounded — it is a typed field, not a prompt channel. */
export const PARENT_GUIDANCE_NOTE_MAX_LENGTH = 280;

/**
 * An answered question folded into a re-dispatch, carried as a REF ONLY: the
 * answer text is read from the ledger by prepare, so the question narrative
 * never reaches parent context either.
 */
export interface AnsweredQuestionGuidance {
  readonly kind: "answered-question";
  readonly questionId: string;
}

/** A bounded operator note. Typed and length-capped — never free prompt text. */
export interface OperatorNoteGuidance {
  readonly kind: "operator-note";
  readonly note: string;
}

export type ParentGuidance = AnsweredQuestionGuidance | OperatorNoteGuidance;

/**
 * The refs-only dispatch input form. The parent passes ids it already holds; no
 * field carries assembled narrative, and prepare rejects one that does.
 */
export interface DispatchInputRefs {
  /** Kept as string so untyped boundary callers get a typed rejection. */
  readonly roleId: string;
  /** Kept as string so untyped boundary callers get a typed rejection. */
  readonly surface: string;
  /** The project the refs are scoped to; a foreign project is refused. */
  readonly projectKey: string;
  readonly taskId: string;
  readonly coordinates: DispatchWorktreeCoordinates;
  /** The review round; 0 (or absent) is the first dispatch. */
  readonly round?: number;
  /** The prior round's review, whose `criticism[]` prepare reads server-side. */
  readonly priorReviewId?: string;
  /** Typed bounded parent guidance. */
  readonly guidance?: readonly ParentGuidance[];
  /** The §K4-resolved model class (informational, non-narrative). */
  readonly resolvedModel?: string;
}

/** The closed key set of the refs form. Any other own key is rejected. */
export const DISPATCH_INPUT_REFS_FIELDS = [
  "roleId",
  "surface",
  "projectKey",
  "taskId",
  "coordinates",
  "round",
  "priorReviewId",
  "guidance",
  "resolvedModel",
] as const;

const REFS_FIELD_SET: ReadonlySet<string> = new Set(DISPATCH_INPUT_REFS_FIELDS);

const COORDINATE_FIELDS = ["worktreePath", "branch", "baseCommit"] as const;

const COORDINATE_FIELD_SET: ReadonlySet<string> = new Set(COORDINATE_FIELDS);

const TASK_ID_PATTERN = "^T[0-9]+$";
const REVIEW_ID_PATTERN = "^R[0-9]+$";
const QUESTION_ID_PATTERN = "^Q[0-9]+$";
const PROJECT_KEY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";

const TASK_ID_RE = new RegExp(TASK_ID_PATTERN);
const REVIEW_ID_RE = new RegExp(REVIEW_ID_PATTERN);
const QUESTION_ID_RE = new RegExp(QUESTION_ID_PATTERN);
const PROJECT_KEY_RE = new RegExp(PROJECT_KEY_PATTERN);

const guidanceSchema: JSONSchema = {
  type: "array",
  maxItems: PARENT_GUIDANCE_MAX_ENTRIES,
  items: {
    oneOf: [
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["answered-question"] },
          questionId: { type: "string", pattern: QUESTION_ID_PATTERN },
        },
        required: ["kind", "questionId"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["operator-note"] },
          note: {
            type: "string",
            minLength: 1,
            maxLength: PARENT_GUIDANCE_NOTE_MAX_LENGTH,
            pattern: "\\S",
          },
        },
        required: ["kind", "note"],
        additionalProperties: false,
      },
    ],
  },
};

function refsSchemaProperties(roleIds: readonly string[]): Readonly<Record<string, JSONSchema>> {
  return {
    roleId: { type: "string", enum: [...roleIds] },
    surface: { type: "string", enum: [...PROMPT_SURFACES] },
    projectKey: { type: "string", pattern: PROJECT_KEY_PATTERN },
    taskId: { type: "string", pattern: TASK_ID_PATTERN },
    coordinates: {
      type: "object",
      properties: {
        worktreePath: { type: "string", minLength: 1, pattern: "\\S" },
        branch: { type: "string", minLength: 1, pattern: "\\S" },
        baseCommit: { type: "string", minLength: 1, pattern: "\\S" },
      },
      required: [...COORDINATE_FIELDS],
      additionalProperties: false,
    },
    round: { type: "integer", minimum: 0 },
    priorReviewId: { type: "string", pattern: REVIEW_ID_PATTERN },
    guidance: guidanceSchema,
    resolvedModel: { type: "string", minLength: 1, pattern: "\\S" },
  };
}

const REFS_REQUIRED = ["roleId", "surface", "projectKey", "taskId", "coordinates"] as const;

/**
 * The schema pinning the refs-only form. `additionalProperties: false` over
 * {@link DISPATCH_INPUT_REFS_FIELDS} is what makes an INLINE narrative field
 * (`headline`, `description`, `acceptance`, `priorCriticism`) fail the schema;
 * {@link assembleDispatchInput} additionally classifies such a field as
 * `inline-narrative-courier` so the diagnosis names the actual defect.
 */
export const DISPATCH_INPUT_REFS_SCHEMA: JSONSchema = {
  $schema: DRAFT_2020_12,
  $id: "cq:compact-dispatch/input-refs",
  title: "refs-only dispatch input",
  type: "object",
  properties: refsSchemaProperties(REF_ASSEMBLED_ROLES),
  required: [...REFS_REQUIRED],
  additionalProperties: false,
};

/**
 * The refs-only LAUNCH form: the refs plus T682's launch envelope
 * (`idempotencyKey`, `timeoutMs`) and T684's declared overlay list. It replaces
 * T682's inline `input` with `refs` — nothing here carries narrative.
 */
export interface CompactDispatchRefsLaunch {
  readonly refs: DispatchInputRefs;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly overlays?: readonly DispatchOverlayApplication[];
}

/**
 * Role-aware refs-only launch schema over an explicit overlay registry, exactly
 * mirroring T682's `compactDispatchLaunchSchemaFor`: one branch per
 * ref-assembled role, each pinning its own `roleId` and deriving its `overlays`
 * list from T684's {@link dispatchOverlayListSchema} — so an undeclared overlay
 * id, another role's overlay, or invalid overlay data fails before launch. The
 * only structural difference from T682 is `refs` in place of inline `input`.
 */
export function compactDispatchRefsLaunchSchemaFor(registry: DispatchOverlayRegistry): JSONSchema {
  return {
    $schema: DRAFT_2020_12,
    $id: "cq:compact-dispatch/refs-launch",
    title: "refs-only dispatched-subagent launch",
    oneOf: REF_ASSEMBLED_ROLES.map((roleId) => ({
      type: "object",
      properties: {
        refs: {
          type: "object",
          properties: refsSchemaProperties([roleId]),
          required: [...REFS_REQUIRED],
          additionalProperties: false,
        },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" },
        timeoutMs: { type: "integer", minimum: 1 },
        overlays: dispatchOverlayListSchema(roleId, registry),
      },
      required: ["refs", "idempotencyKey", "timeoutMs"],
      additionalProperties: false,
    })),
  };
}

/**
 * The refs-only launch schema over the production overlay registry, which ships
 * empty (T684), so only an absent or empty `overlays` list can pass.
 */
export const COMPACT_DISPATCH_REFS_LAUNCH_SCHEMA: JSONSchema =
  compactDispatchRefsLaunchSchemaFor(DISPATCH_OVERLAY_REGISTRY);

// ---------------------------------------------------------------------------
// The ledger port
// ---------------------------------------------------------------------------

/** One ledger item as prepare reads it: status plus its stored field values. */
export interface DispatchNarrativeItem {
  readonly id: string;
  readonly status: string;
  readonly fields: Readonly<Record<string, string | readonly string[]>>;
}

/**
 * The port prepare reads narrative through — an adapter over the ledger store,
 * bound to exactly ONE project. `readItem` returns `undefined` for an id that
 * does not exist, so an unresolvable ref becomes a typed pre-launch rejection
 * rather than a thrown error.
 */
export interface DispatchNarrativeSource {
  readonly projectKey: string;
  readItem(ledger: string, id: string): DispatchNarrativeItem | undefined;
}

/** The ledgers refs assembly reads. */
export const REF_ASSEMBLY_LEDGERS = Object.freeze({
  tasks: "tasks",
  reviews: "reviews",
  questions: "questions",
} as const);

/**
 * Read one stored field of a ledger item. `Object.hasOwn` rather than `in` or a
 * bare index lookup, so a field name colliding with an `Object.prototype` member
 * reads as ABSENT instead of resolving to an inherited function — the D169 class,
 * which has already produced three instances in this package. Exported so the
 * guard itself is directly testable.
 */
export function readNarrativeField(
  item: DispatchNarrativeItem,
  name: string,
): string | readonly string[] | undefined {
  if (!Object.hasOwn(item.fields, name)) {
    return undefined;
  }
  return item.fields[name];
}

function stringFieldOf(item: DispatchNarrativeItem, name: string): string | undefined {
  const value = readNarrativeField(item, name);
  return typeof value === "string" ? value : undefined;
}

function stringArrayFieldOf(item: DispatchNarrativeItem, name: string): readonly string[] {
  const value = readNarrativeField(item, name);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * A successfully assembled dispatch input. `input` was built SERVER-SIDE from
 * the ledger and then validated by T976's {@link validateDispatchInput}, whose
 * acceptance is carried verbatim on `validation` — proof the refs form flowed
 * THROUGH the inside-prepare validation rather than around it.
 */
export interface DispatchInputAssembled {
  readonly accepted: true;
  readonly roleId: RefAssembledRoleId;
  readonly surface: PromptSurface;
  readonly projectKey: string;
  /** The review round the input was assembled for (0 on a first dispatch). */
  readonly round: number;
  /** The assembled typed role input. */
  readonly input: DispatchJSONValue;
  /** {@link dispatchInputDigest} of `input` — the cutover's byte identity. */
  readonly inputDigest: string;
  /** Canonical `<ledger>:<id>` refs read to assemble it, in read order. */
  readonly assembledFrom: readonly string[];
  /** The typed guidance folded in, echoed back for the round-trip. */
  readonly appliedGuidance: readonly ParentGuidance[];
  /** T976's inside-prepare acceptance for this exact assembled input. */
  readonly validation: DispatchInputAccepted;
  /** No assembled narrative was ever carried by the parent. */
  readonly parentCarriedNarrative: false;
}

export type DispatchInputAssembly = DispatchInputAssembled | DispatchPreLaunchRejection;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Discriminate an internal step's rejection branch from its success branch. An
 * internal discriminator over shapes this module builds itself — the boundary
 * guard for untrusted values is {@link isDispatchPreLaunchRejection}.
 */
function isRejection(value: object): value is DispatchPreLaunchRejection {
  return (value as { readonly outcome?: unknown }).outcome === DISPATCH_PRE_LAUNCH_OUTCOME;
}

/** Classify one unexpected own key of the refs form. */
function rejectUnexpectedRefsField(field: string): DispatchPreLaunchRejection {
  if (ASSEMBLED_NARRATIVE_FIELD_SET.has(field)) {
    return dispatchPreLaunchRejection(
      "inline-narrative-courier",
      `refs.${field}`,
      `"${field}" is assembled server-side from the ledger; the parent must not carry it inline`,
    );
  }
  return dispatchPreLaunchRejection(
    "invalid-refs-form",
    `refs.${field}`,
    `unexpected refs field "${field}"`,
  );
}

interface NormalizedRefs {
  readonly roleId: RefAssembledRoleId;
  readonly surface: PromptSurface;
  readonly projectKey: string;
  readonly taskId: string;
  readonly coordinates: DispatchWorktreeCoordinates;
  readonly round: number;
  readonly priorReviewId?: string;
  readonly guidance: readonly ParentGuidance[];
  readonly resolvedModel?: string;
}

function normalizeGuidance(raw: unknown): readonly ParentGuidance[] | DispatchPreLaunchRejection {
  if (raw === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(raw)) {
    return dispatchPreLaunchRejection(
      "invalid-parent-guidance",
      "refs.guidance",
      "expected an array of typed guidance entries",
    );
  }
  if (raw.length > PARENT_GUIDANCE_MAX_ENTRIES) {
    return dispatchPreLaunchRejection(
      "invalid-parent-guidance",
      "refs.guidance",
      `at most ${PARENT_GUIDANCE_MAX_ENTRIES} guidance entries may be folded into one dispatch`,
    );
  }
  const guidance: ParentGuidance[] = [];
  for (const [index, candidate] of raw.entries()) {
    const path = `refs.guidance[${index}]`;
    if (!isRecord(candidate)) {
      return dispatchPreLaunchRejection(
        "invalid-parent-guidance",
        path,
        "expected a typed guidance entry object",
      );
    }
    const kind: unknown = Object.hasOwn(candidate, "kind") ? candidate.kind : undefined;
    if (typeof kind !== "string" || !PARENT_GUIDANCE_KIND_SET.has(kind)) {
      return dispatchPreLaunchRejection(
        "invalid-parent-guidance",
        `${path}.kind`,
        `unknown guidance kind "${String(kind)}"`,
      );
    }
    const allowed = kind === "answered-question" ? "questionId" : "note";
    const unexpected = Object.keys(candidate).find(
      (field) => field !== "kind" && field !== allowed,
    );
    if (unexpected !== undefined) {
      return dispatchPreLaunchRejection(
        "invalid-parent-guidance",
        `${path}.${unexpected}`,
        "guidance is a typed bounded field; free prompt text is not accepted at dispatch",
      );
    }
    if (kind === "answered-question") {
      const questionId: unknown = Object.hasOwn(candidate, "questionId")
        ? candidate.questionId
        : undefined;
      if (typeof questionId !== "string" || !QUESTION_ID_RE.test(questionId)) {
        return dispatchPreLaunchRejection(
          "invalid-parent-guidance",
          `${path}.questionId`,
          `expected a questions-ledger id, got "${String(questionId)}"`,
        );
      }
      guidance.push(Object.freeze({ kind: "answered-question" as const, questionId }));
      continue;
    }
    const note: unknown = Object.hasOwn(candidate, "note") ? candidate.note : undefined;
    if (typeof note !== "string" || note.trim() === "") {
      return dispatchPreLaunchRejection(
        "invalid-parent-guidance",
        `${path}.note`,
        "expected a non-empty operator note",
      );
    }
    if (note.length > PARENT_GUIDANCE_NOTE_MAX_LENGTH) {
      return dispatchPreLaunchRejection(
        "invalid-parent-guidance",
        `${path}.note`,
        `an operator note is bounded at ${PARENT_GUIDANCE_NOTE_MAX_LENGTH} characters`,
      );
    }
    guidance.push(Object.freeze({ kind: "operator-note" as const, note }));
  }
  return Object.freeze(guidance);
}

function normalizeRefs(
  raw: unknown,
  source: DispatchNarrativeSource,
): NormalizedRefs | DispatchPreLaunchRejection {
  if (!isRecord(raw)) {
    return dispatchPreLaunchRejection("invalid-refs-form", "refs", "expected a refs form object");
  }
  // The closed-key sweep runs FIRST so an inline narrative field is named as the
  // courier defect it is, before any other diagnosis can mask it.
  for (const field of Object.keys(raw)) {
    if (!REFS_FIELD_SET.has(field)) {
      return rejectUnexpectedRefsField(field);
    }
  }
  const roleId: unknown = raw.roleId;
  if (typeof roleId !== "string" || !Object.hasOwn(DISPATCHED_ROLE_SIDECARS, roleId)) {
    return dispatchPreLaunchRejection(
      "unknown-role",
      "refs.roleId",
      `unknown dispatched role "${String(roleId)}"`,
    );
  }
  if (!REF_ASSEMBLED_ROLE_SET.has(roleId)) {
    return dispatchPreLaunchRejection(
      "no-ref-assembler",
      "refs.roleId",
      `no server-side ref assembler is declared for role "${roleId}"`,
    );
  }
  const surface: unknown = raw.surface;
  if (typeof surface !== "string" || !(PROMPT_SURFACES as readonly string[]).includes(surface)) {
    return dispatchPreLaunchRejection(
      "unsupported-surface",
      "refs.surface",
      `unsupported prompt surface "${String(surface)}"`,
    );
  }
  const projectKey: unknown = raw.projectKey;
  if (typeof projectKey !== "string" || !PROJECT_KEY_RE.test(projectKey)) {
    return dispatchPreLaunchRejection(
      "invalid-refs-form",
      "refs.projectKey",
      `expected a project key, got "${String(projectKey)}"`,
    );
  }
  if (projectKey !== source.projectKey) {
    return dispatchPreLaunchRejection(
      "cross-project-ref",
      "refs.projectKey",
      `refs are scoped to project "${projectKey}" but prepare is bound to "${source.projectKey}"`,
    );
  }
  const taskId: unknown = raw.taskId;
  if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) {
    return dispatchPreLaunchRejection(
      "invalid-refs-form",
      "refs.taskId",
      `expected a tasks-ledger id, got "${String(taskId)}"`,
    );
  }
  const coordinates: unknown = raw.coordinates;
  if (!isRecord(coordinates)) {
    return dispatchPreLaunchRejection(
      "invalid-refs-form",
      "refs.coordinates",
      "expected the worktree coordinates object",
    );
  }
  for (const field of Object.keys(coordinates)) {
    if (!COORDINATE_FIELD_SET.has(field)) {
      return dispatchPreLaunchRejection(
        "invalid-refs-form",
        `refs.coordinates.${field}`,
        `unexpected coordinate field "${field}"`,
      );
    }
  }
  for (const field of COORDINATE_FIELDS) {
    const value: unknown = Object.hasOwn(coordinates, field) ? coordinates[field] : undefined;
    if (typeof value !== "string" || value.trim() === "") {
      return dispatchPreLaunchRejection(
        "invalid-refs-form",
        `refs.coordinates.${field}`,
        `expected a non-empty ${field}`,
      );
    }
  }
  const round: unknown = raw.round;
  if (round !== undefined && (!Number.isInteger(round) || (round as number) < 0)) {
    return dispatchPreLaunchRejection(
      "invalid-refs-form",
      "refs.round",
      `expected a non-negative integer round, got "${String(round)}"`,
    );
  }
  const priorReviewId: unknown = raw.priorReviewId;
  if (
    priorReviewId !== undefined &&
    (typeof priorReviewId !== "string" || !REVIEW_ID_RE.test(priorReviewId))
  ) {
    return dispatchPreLaunchRejection(
      "invalid-refs-form",
      "refs.priorReviewId",
      `expected a reviews-ledger id, got "${String(priorReviewId)}"`,
    );
  }
  const resolvedModel: unknown = raw.resolvedModel;
  if (
    resolvedModel !== undefined &&
    (typeof resolvedModel !== "string" || resolvedModel.trim() === "")
  ) {
    return dispatchPreLaunchRejection(
      "invalid-refs-form",
      "refs.resolvedModel",
      "expected a non-empty resolved model class",
    );
  }
  const guidance = normalizeGuidance(raw.guidance);
  if (isRejection(guidance)) {
    return guidance;
  }
  return {
    roleId: roleId as RefAssembledRoleId,
    surface: surface as PromptSurface,
    projectKey,
    taskId,
    coordinates: {
      worktreePath: coordinates.worktreePath as string,
      branch: coordinates.branch as string,
      baseCommit: coordinates.baseCommit as string,
    },
    round: round === undefined ? 0 : (round as number),
    ...(priorReviewId === undefined ? {} : { priorReviewId: priorReviewId as string }),
    guidance,
    ...(resolvedModel === undefined ? {} : { resolvedModel: resolvedModel as string }),
  };
}

/**
 * The folded form of one answered question in `priorCriticism[]`. The ANSWER
 * text comes from the ledger, never from the parent.
 */
export function foldAnsweredQuestion(questionId: string, answer: string): string {
  return `answered question ${questionId}: ${answer}`;
}

/** The folded form of one bounded operator note in `priorCriticism[]`. */
export function foldOperatorNote(note: string): string {
  return `operator note: ${note}`;
}

interface FoldedGuidance {
  readonly lines: readonly string[];
  readonly refs: readonly string[];
}

function foldGuidance(
  guidance: readonly ParentGuidance[],
  source: DispatchNarrativeSource,
): FoldedGuidance | DispatchPreLaunchRejection {
  const lines: string[] = [];
  const refs: string[] = [];
  for (const [index, entry] of guidance.entries()) {
    if (entry.kind === "operator-note") {
      lines.push(foldOperatorNote(entry.note));
      continue;
    }
    const ref = `${REF_ASSEMBLY_LEDGERS.questions}:${entry.questionId}`;
    const question = source.readItem(REF_ASSEMBLY_LEDGERS.questions, entry.questionId);
    if (question === undefined) {
      return dispatchPreLaunchRejection(
        "unresolvable-ref",
        `refs.guidance[${index}].questionId`,
        `no such ledger item "${ref}"`,
      );
    }
    const answer = stringFieldOf(question, "answer");
    if (question.status !== "answered" || answer === undefined || answer.trim() === "") {
      return dispatchPreLaunchRejection(
        "unresolvable-ref",
        `refs.guidance[${index}].questionId`,
        `"${ref}" carries no answer to fold (status "${question.status}")`,
      );
    }
    refs.push(ref);
    lines.push(foldAnsweredQuestion(entry.questionId, answer));
  }
  return { lines: Object.freeze(lines), refs: Object.freeze(refs) };
}

interface AssembledRoleInput {
  readonly input: DispatchJSONValue;
  readonly assembledFrom: readonly string[];
}

/**
 * Assemble the `implement-worker` role input from the ledger — the pre-cutover
 * parent render of `commands/cq/implement/advance.md` §2, moved server-side:
 * the task's verbatim `headline`/`description`/`acceptance`, the worktree
 * coordinates, and (on a re-dispatch) the prior round's `criticism[]` read from
 * the review item, with the typed parent guidance folded in after it.
 */
function assembleImplementWorkerInput(
  refs: NormalizedRefs,
  source: DispatchNarrativeSource,
): AssembledRoleInput | DispatchPreLaunchRejection {
  const taskRef = `${REF_ASSEMBLY_LEDGERS.tasks}:${refs.taskId}`;
  const task = source.readItem(REF_ASSEMBLY_LEDGERS.tasks, refs.taskId);
  if (task === undefined) {
    return dispatchPreLaunchRejection(
      "unresolvable-ref",
      "refs.taskId",
      `no such ledger item "${taskRef}"`,
    );
  }
  const assembledFrom: string[] = [taskRef];
  const priorCriticism: string[] = [];
  if (refs.priorReviewId !== undefined) {
    const reviewRef = `${REF_ASSEMBLY_LEDGERS.reviews}:${refs.priorReviewId}`;
    const review = source.readItem(REF_ASSEMBLY_LEDGERS.reviews, refs.priorReviewId);
    if (review === undefined) {
      return dispatchPreLaunchRejection(
        "unresolvable-ref",
        "refs.priorReviewId",
        `no such ledger item "${reviewRef}"`,
      );
    }
    assembledFrom.push(reviewRef);
    priorCriticism.push(...stringArrayFieldOf(review, "criticism"));
  }
  const folded = foldGuidance(refs.guidance, source);
  if (isRejection(folded)) {
    return folded;
  }
  assembledFrom.push(...folded.refs);
  priorCriticism.push(...folded.lines);

  const headline = stringFieldOf(task, "headline");
  const description = stringFieldOf(task, "description");
  const acceptance = stringFieldOf(task, "acceptance");
  const input: Record<string, DispatchJSONValue> = {
    taskId: refs.taskId,
    ...(headline === undefined ? {} : { headline }),
    ...(description === undefined ? {} : { description }),
    ...(acceptance === undefined ? {} : { acceptance }),
    worktreePath: refs.coordinates.worktreePath,
    branch: refs.coordinates.branch,
    baseCommit: refs.coordinates.baseCommit,
    ...(priorCriticism.length === 0 ? {} : { priorCriticism }),
    ...(refs.resolvedModel === undefined ? {} : { resolvedModel: refs.resolvedModel }),
  };
  return { input, assembledFrom: Object.freeze(assembledFrom) };
}

/**
 * The declared per-role server-side assemblers, as a Map so no
 * `Object.prototype` name can resolve one. Only {@link REF_ASSEMBLED_ROLES} have
 * an entry; every other dispatched role yields a `no-ref-assembler` rejection.
 */
const REF_ASSEMBLERS: ReadonlyMap<
  string,
  (
    refs: NormalizedRefs,
    source: DispatchNarrativeSource,
  ) => AssembledRoleInput | DispatchPreLaunchRejection
> = new Map([["implement-worker", assembleImplementWorkerInput]]);

/**
 * Module-load invariant: the DECLARED {@link REF_ASSEMBLED_ROLES} and the
 * assembler table agree exactly. This is what makes the lookup in
 * {@link assembleDispatchInput} total, so declaring a role without writing its
 * assembler fails at import time rather than at a dispatch. Its value is the
 * sorted covered role list.
 */
export const REF_ASSEMBLER_COVERAGE: readonly string[] = (() => {
  const declared = [...REF_ASSEMBLED_ROLES].sort();
  const implemented = [...REF_ASSEMBLERS.keys()].sort();
  if (declared.join(",") !== implemented.join(",")) {
    throw new DispatchRefAssemblyError(
      "REF_ASSEMBLED_ROLES",
      `declared roles [${declared.join(", ")}] do not match the assembler table [${implemented.join(", ")}]`,
    );
  }
  return Object.freeze(implemented);
})();

/** What {@link assembleDispatchInput} needs beyond the refs and the ledger. */
export interface DispatchAssemblyContext {
  readonly source: DispatchNarrativeSource;
  readonly registry: DispatchOverlayRegistry;
  readonly overlays?: readonly DispatchOverlayApplication[];
}

/**
 * THE server-side refs assembly entry point (T978). Takes the refs the parent
 * holds, reads the narrative from the ledger through
 * {@link DispatchNarrativeSource}, assembles the typed role input, and validates
 * it through T976's {@link validateDispatchInput} — inside prepare, fail-closed,
 * before anything is allocated.
 *
 * Returns {@link DispatchInputAssembled} or a typed
 * {@link DispatchPreLaunchRejection}: an inline-narrative form, an unexpected
 * refs field, a role without a declared assembler, an unresolvable or
 * cross-project ref, invalid parent guidance, or any T976 validation failure.
 * Nothing is allocated on any of those paths.
 *
 * One-shot child retrieval of the assembled input BY HANDLE, and the stolen /
 * foreign-capability and second-retrieval failures that guard it, are DEFERRED
 * to T977 ({@link DISPATCH_REF_ASSEMBLY_DEFERRED}).
 */
export function assembleDispatchInput(
  refs: unknown,
  context: DispatchAssemblyContext,
): DispatchInputAssembly {
  const normalized = normalizeRefs(refs, context.source);
  if (isRejection(normalized)) {
    return normalized;
  }
  // Total by construction: normalizeRefs already rejected every role outside
  // REF_ASSEMBLED_ROLES, and REF_ASSEMBLER_COVERAGE asserts at import time that
  // the declared roles and this table agree. A miss is a broken declaration, not
  // rejected data, so it throws rather than returning a rejection.
  const assembler = REF_ASSEMBLERS.get(normalized.roleId);
  if (assembler === undefined) {
    throw new DispatchRefAssemblyError(
      "refs.roleId",
      `declared ref-assembled role "${normalized.roleId}" has no assembler`,
    );
  }
  const assembled = assembler(normalized, context.source);
  if (isRejection(assembled)) {
    return assembled;
  }
  // Flow THROUGH T976's inside-prepare validation, never around it.
  const validation = validateDispatchInput({
    roleId: normalized.roleId,
    input: assembled.input,
    surface: normalized.surface,
    ...(context.overlays === undefined ? {} : { overlays: context.overlays }),
    registry: context.registry,
  });
  if (!validation.accepted) {
    return validation;
  }
  return Object.freeze({
    accepted: true as const,
    roleId: normalized.roleId,
    surface: normalized.surface,
    projectKey: normalized.projectKey,
    round: normalized.round,
    input: assembled.input,
    inputDigest: dispatchInputDigest(assembled.input),
    assembledFrom: assembled.assembledFrom,
    appliedGuidance: normalized.guidance,
    validation,
    parentCarriedNarrative: false as const,
  });
}

/** Runtime type guard for a successful assembly. */
export function isDispatchInputAssembled(
  value: DispatchInputAssembly,
): value is DispatchInputAssembled {
  return value.accepted === true;
}

// ---------------------------------------------------------------------------
// The child performs no role-prompt retrieval (T975 must not regress)
// ---------------------------------------------------------------------------

/**
 * The operation spellings that ARE a role-prompt retrieval, across the three
 * surfaces — the MCP tool name and the neutral operational-vocabulary token, plus
 * the field a fetch exists to pull. Kept in sync with the inventory scanner in
 * `packages/ledger/test/cq-parent-dispatch-inventory.test.ts` (T975).
 */
export const ROLE_PROMPT_RETRIEVAL_OPERATIONS = [
  "fetch_prompt",
  "prompt-catalog fetch",
  "promptTemplate",
] as const;

const ROLE_PROMPT_RETRIEVAL_SET: ReadonlySet<string> = new Set(ROLE_PROMPT_RETRIEVAL_OPERATIONS);

/**
 * The native-Claude dispatch edge's retrieval profile. BOTH the parent and the
 * child retrieve ZERO role prompts: `bun run gen-agents` bakes the role prompt
 * into `agents/<role>.md` and the harness injects it at the CHILD's system
 * boundary, so a child-side fetch would re-add exactly the per-dispatch cost
 * T975 removed — while the parent's copy launched nothing (T975's defect).
 *
 * What the child DOES retrieve is its assembled INPUT, by handle — one-shot,
 * capability-bound, and wired in T977.
 */
export const NATIVE_CLAUDE_CHILD_RETRIEVAL = Object.freeze({
  surface: "claude",
  rolePromptInjectionBoundary: "gen-agents-baked-agent-definition",
  /** Role-prompt retrievals the CHILD performs. Empty, and asserted empty. */
  childRolePromptRetrievalOperations: Object.freeze([] as readonly string[]),
  /** Role-prompt retrievals the PARENT performs. Emptied by T975. */
  parentRolePromptRetrievalOperations: Object.freeze([] as readonly string[]),
  /** The child retrieves its ASSEMBLED INPUT by handle — T977 wires it. */
  childRetrievesAssembledInputByHandle: true,
  childRetrievalIsOneShot: true,
} as const);

/**
 * Assert that `operations` contains no role-prompt retrieval. Set-based, so no
 * `Object.prototype` name can pass as a member. Throws
 * {@link DispatchRefAssemblyError} naming the first offending operation.
 */
export function assertNoRolePromptRetrieval(label: string, operations: readonly string[]): void {
  if (!Array.isArray(operations)) {
    throw new DispatchRefAssemblyError(label, "expected a list of retrieval operations");
  }
  for (const [index, operation] of operations.entries()) {
    if (typeof operation === "string" && ROLE_PROMPT_RETRIEVAL_SET.has(operation)) {
      throw new DispatchRefAssemblyError(
        `${label}[${index}]`,
        `role-prompt retrieval "${operation}" is not performed on this edge`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Deferred
// ---------------------------------------------------------------------------

/** The task that owns the runtime half of this contract. */
export const DISPATCH_REF_ASSEMBLY_DEFERRED_TO = "T977" as const;

/**
 * What this contract-level task deliberately does NOT cover, recorded so it is
 * not silently dropped. Each entry lands in
 * {@link DISPATCH_REF_ASSEMBLY_DEFERRED_TO}.
 */
export const DISPATCH_REF_ASSEMBLY_DEFERRED = Object.freeze([
  "one-shot-child-retrieval-of-the-assembled-input-by-handle",
  "stolen-or-foreign-capability-rejection",
  "second-retrieval-failure",
  "recorded-end-to-end-dispatch-showing-narrative-absent-from-parent-context",
] as const);
