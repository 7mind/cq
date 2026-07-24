/**
 * Prompt-catalog capability (T343, goal G41).
 *
 * The `fetch_prompt` / `validate_input` / `validate_output` MCP tools surface a
 * repo's TYPED prompt catalog: each role's prompt template plus — for dispatched
 * subagents — its input/output JSON Schemas, and a validator over them. Like the
 * config capability (./configCapability.ts) and `read_log` (./readLog.ts), the
 * catalog read + JSON-Schema validation is a capability the OUTER package
 * supplies: `@cq/ledger` core stays free of `@cq/config` and the asset-markdown
 * I/O — the prompt-template read, the `@cq/config` sidecar join, and the Ajv
 * validation all live in the `@cq/ledger-mcp` implementation (T343) and are
 * INJECTED here.
 *
 * The result types below are STRUCTURAL (the schemas are plain JSON-Schema data
 * objects, the validator errors a flat shape) so core need not know
 * `@cq/config`'s `JSONSchema` / `ValidationResult` types.
 */

/**
 * A JSON-Schema document as opaque data (draft 2020-12). Kept as an open record
 * rather than `unknown` so a `FetchPromptResult`'s schema fields are typed as
 * objects; the validator (in the ledger-mcp impl) compiles them.
 */
export type JSONSchemaDoc = Readonly<Record<string, unknown>>;

/** Which side of the flow a catalog role plays (mirrors `@cq/config`'s RoleKind). */
export type PromptRoleKind = "dispatched-subagent" | "orchestrator-command";

/** The closed built-prompt surface vocabulary. */
export type PromptSurface = "claude" | "codex" | "pi";

/**
 * A named renderer adapter capability. These ids come directly from the
 * catalog's ordered `fragmentBindings[].fragment` declarations: they identify
 * the surface-sensitive operations the deterministic renderer had to supply,
 * rather than an inferred list of arbitrary runtime tools.
 */
export type PromptRendererCapability =
  | "cq-command-invocation"
  | "subagent-dispatch"
  | "inline-command-recursion"
  | "host-tool-vocabulary"
  | "operational-tool-vocabulary";

export type PromptIntentionalDifferenceKind =
  | "invocation-syntax"
  | "dispatch-protocol"
  | "recursion-protocol"
  | "tool-vocabulary";

export interface PromptIntentionalDifference {
  readonly kind: PromptIntentionalDifferenceKind;
  readonly reason: string;
  readonly surfaces: readonly PromptSurface[];
}

export interface PromptWorkflowDependency {
  readonly kind: "dispatch" | "recursion";
  readonly targetRoleId: string;
}

export interface PromptSharedSourceBlock {
  readonly classification: "shared-prose";
  readonly sourceBlock: string;
  readonly targetFragment: null;
}

export interface PromptFragmentBinding {
  readonly fragment: PromptRendererCapability;
  readonly sourceBlock: string;
  readonly supportedSurfaces: readonly PromptSurface[];
  readonly forbiddenVocabulary: Readonly<Record<PromptSurface, readonly string[]>>;
  readonly intentionalDifference: PromptIntentionalDifference;
}

/**
 * The catalog inputs consumed by the deterministic renderer for one role.
 * Prompt bytes have already been rendered when `fetch_prompt` runs.
 */
export interface PromptRendererMetadata {
  readonly sharedSourceBlock: PromptSharedSourceBlock;
  readonly fragmentBindings: readonly PromptFragmentBinding[];
}

/**
 * The `fetch_prompt` payload: the role's prompt template plus its role-scope
 * metadata. `inputSchema`/`outputSchema` are present IFF the role is a
 * dispatched subagent (role-scope decision 1); an orchestrator-command role
 * returns prompt + metadata with both schema fields ABSENT. The surface-build
 * metadata fields are additive and present for a selected built prompt root;
 * they remain optional for the source-tree compatibility capability.
 */
export interface FetchPromptResult {
  /** The resolved role id (echoes the request). */
  readonly roleId: string;
  /** The role-scope discriminant. */
  readonly kind: PromptRoleKind;
  /** Whether a parent dispatches this role with a validated input/output. */
  readonly dispatched: boolean;
  /** The full prompt-template body (asset markdown after its frontmatter). */
  readonly promptTemplate: string;
  /** The selected immutable prompt surface that supplied `promptTemplate`. */
  readonly promptSurface?: PromptSurface;
  /** The catalog renderer inputs that produced the selected artifact. */
  readonly renderer?: PromptRendererMetadata;
  /** The canonical source path recorded by the catalog. */
  readonly sourcePath?: string;
  /** Ordered catalog dispatch/recursion relations for this role. */
  readonly workflowDependencies?: readonly PromptWorkflowDependency[];
  /**
   * Ordered renderer fragment capability ids, projected from
   * `renderer.fragmentBindings[].fragment`.
   */
  readonly requiredCapabilities?: readonly PromptRendererCapability[];
  /** Typed cross-surface differences declared by the catalog. */
  readonly intentionalDifferences?: readonly PromptIntentionalDifference[];
  /** Contract version stamp; present only for a dispatched-subagent role. */
  readonly version?: number;
  /** The parent-supplied input contract; present only for a dispatched subagent. */
  readonly inputSchema?: JSONSchemaDoc;
  /** The validated output contract; present only for a dispatched subagent. */
  readonly outputSchema?: JSONSchemaDoc;
}

/**
 * One structured validation error: the failing JSON-Schema instance path (the
 * field path into the validated value, `""` for the root), a human-readable
 * message, the failed keyword + schema path, and the keyword's params. A flat
 * mirror of `@cq/config`'s `ValidationError`.
 */
export interface PromptValidationError {
  /** The failing value's location (`""` = the root value). */
  readonly path: string;
  readonly message: string;
  /** The JSON-Schema keyword that failed (e.g. `required`, `type`, `pattern`). */
  readonly keyword: string;
  readonly schemaPath: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * The `validate_input` / `validate_output` payload: `{ ok: true }` on success, or
 * `{ ok: false, errors }` carrying EVERY failing constraint (allErrors). Mirrors
 * `@cq/config`'s `ValidationResult`.
 */
export type PromptValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly PromptValidationError[] };

/**
 * The injected prompt-catalog capability: fetches a role's prompt + schemas and
 * validates an input/output against the role's contract, against a catalog root
 * the OUTER package bound it to. Supplied by the ledger-mcp layer (over
 * `@cq/config` + the asset markdown); absent for catalog-agnostic factories (an
 * in-memory store with no asset-capable root).
 *
 * Each method FAILS FAST with a precise error: {@link UnknownRoleError} for an
 * unknown role id, and {@link NoSchemaForRoleError} when validate_input/output is
 * called for an orchestrator-command role (which carries no schema).
 */
export interface PromptCatalogCapability {
  fetchPrompt(roleId: string): FetchPromptResult;
  validateInput(roleId: string, input: unknown): PromptValidationResult;
  validateOutput(roleId: string, output: unknown): PromptValidationResult;
}

/**
 * Thrown when a `fetch_prompt`/`validate_input`/`validate_output` call names a
 * role id that is not in the roster. Fail-fast (precise) per T343.
 */
export class UnknownRoleError extends Error {
  constructor(roleId: string) {
    super(`unknown role "${roleId}": not in the prompt catalog roster`);
    this.name = "UnknownRoleError";
  }
}

/**
 * Thrown when `validate_input`/`validate_output` is called for a role that
 * carries no schema — an orchestrator-command role (only dispatched subagents
 * have a parent-validated input/output contract). Fail-fast per T343.
 */
export class NoSchemaForRoleError extends Error {
  constructor(roleId: string, side: "input" | "output") {
    super(`role ${roleId} has no ${side} schema (orchestrator-command)`);
    this.name = "NoSchemaForRoleError";
  }
}

/**
 * Thrown when `fetch_prompt`/`validate_input`/`validate_output` is invoked on a
 * factory wired WITHOUT a prompt-catalog capability (no asset-capable root).
 * Mirrors `ConfigNotImplementedError`: the OTHER tools remain unaffected.
 */
export class PromptCatalogNotImplementedError extends Error {
  constructor() {
    super(
      "fetch_prompt/validate_input/validate_output is not implemented for this " +
        "store: no asset-capable prompt-catalog root is available (prompt-catalog " +
        "capability absent)",
    );
    this.name = "PromptCatalogNotImplementedError";
  }
}
