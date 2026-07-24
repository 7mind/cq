/**
 * Typed prompt-catalog capability for the ledger MCP (T343, goal G41).
 *
 * Implements the `fetch_prompt` / `validate_input` / `validate_output` tools by
 * joining TWO injected sources:
 *
 *  - the per-role schema sidecars from `@cq/config`'s typed prompt-catalog STORE
 *    (`DISPATCHED_ROLE_SIDECARS` / `getRoleSidecar`, T341) — the SINGLE source of
 *    the dispatched roles' input/output JSON Schemas; and
 *  - exact role bytes plus manifest metadata from an already-built
 *    {@link PromptArtifactStore}.
 *
 * `@cq/ledger` core stays free of `@cq/config` and the asset I/O: the
 * `@cq/config` import, the markdown read, and the Ajv validation all live HERE
 * and the resulting {@link PromptCatalogCapability} is INJECTED into the tool
 * factories (the buildServer wiring in main.ts), exactly as ConfigCapability is.
 *
 * Root selection and rendering stay outside this business-logic capability.
 */

import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import {
  AGENT_ROLE_TIERS,
  getRoleSidecar,
  validateAgainstSchema,
  type JSONSchema,
  type ValidationResult,
} from "@cq/config";
import {
  UnknownRoleError,
  NoSchemaForRoleError,
  type PromptCatalogCapability,
  type FetchPromptResult,
  type PromptValidationResult,
  type JSONSchemaDoc,
} from "@cq/ledger";
import {
  PromptArtifactNotFoundError,
  type PromptArtifactRoleMetadata,
  type PromptArtifactStore,
  type PromptRoleArtifact,
} from "./promptArtifactStore.js";

/**
 * The cq-assets package root, relative to a ledger/config root. The assets live
 * at `<root>/nix/pkg/cq-assets/` in this repo (a sibling of the cq-ledgers
 * workspace under `nix/pkg/`), the SAME tree the ledger-web codegen reads.
 */
const ASSETS_SUBPATH = ["nix", "pkg", "cq-assets"] as const;

/**
 * Resolve a role id to its asset markdown path, relative to the cq-assets root.
 * A dispatched-subagent role lives under `agents/<id>.md`; an orchestrator-command
 * role under `commands/cq/<id>.md` (the id already carries the nested path, e.g.
 * `plan/advance` -> `commands/cq/plan/advance.md`). This mirrors the codegen's
 * ROLES `source` mapping, derived from the shared roster's `agentTierKey`.
 */
function assetRelPath(roleId: string, dispatched: boolean): string {
  return dispatched
    ? path.join("agents", `${roleId}.md`)
    : path.join("commands", "cq", `${roleId}.md`);
}

/**
 * Strip a leading `---`-fenced frontmatter block and return the body (the
 * prompt-template). Mirrors the ledger-web `parseFrontmatterBlock` body-extraction
 * (the `rest` after the fence): everything after the closing `---` line, or the
 * whole document when no frontmatter fence is present. The body is `trim()`med to
 * match the codegen's `promptTemplate = body.trim()`.
 */
function stripFrontmatter(raw: string): string {
  const fence = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  const body = fence === null ? raw : raw.slice(fence[0].length);
  return body.trim();
}

/**
 * Read + assemble a role's {@link FetchPromptResult}. Fails fast
 * ({@link UnknownRoleError}) on an unknown id. For a dispatched-subagent role,
 * joins the prompt body with its `@cq/config` sidecar schemas; for an
 * orchestrator-command role, returns prompt + metadata with the schema fields
 * ABSENT (role-scope decision 1).
 */
function roleArtifact(store: PromptArtifactStore, roleId: string): PromptRoleArtifact {
  try {
    return store.readRole(roleId);
  } catch (error) {
    if (error instanceof PromptArtifactNotFoundError) {
      throw new UnknownRoleError(roleId);
    }
    throw error;
  }
}

function decodePrompt(artifact: PromptRoleArtifact): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
  } catch {
    throw new Error(
      `prompt catalog: role "${artifact.metadata.roleId}" artifact is not valid UTF-8`,
    );
  }
}

function fetchedCatalogMetadata(
  metadata: PromptArtifactRoleMetadata,
): Pick<
  FetchPromptResult,
  | "promptSurface"
  | "renderer"
  | "sourcePath"
  | "workflowDependencies"
  | "requiredCapabilities"
  | "intentionalDifferences"
> {
  return {
    ...(metadata.promptSurface !== undefined
      ? { promptSurface: metadata.promptSurface }
      : {}),
    ...(metadata.renderer !== undefined ? { renderer: metadata.renderer } : {}),
    ...(metadata.sourcePath !== undefined ? { sourcePath: metadata.sourcePath } : {}),
    ...(metadata.workflowDependencies !== undefined
      ? { workflowDependencies: metadata.workflowDependencies }
      : {}),
    ...(metadata.requiredCapabilities !== undefined
      ? { requiredCapabilities: metadata.requiredCapabilities }
      : {}),
    ...(metadata.intentionalDifferences !== undefined
      ? { intentionalDifferences: metadata.intentionalDifferences }
      : {}),
  };
}

function fetchPromptFor(store: PromptArtifactStore, roleId: string): FetchPromptResult {
  const artifact = roleArtifact(store, roleId);
  const promptTemplate = decodePrompt(artifact);
  const catalogMetadata = fetchedCatalogMetadata(artifact.metadata);

  if (artifact.metadata.roleKind === "orchestrator-command") {
    return {
      roleId,
      kind: "orchestrator-command",
      dispatched: false,
      promptTemplate,
      ...catalogMetadata,
    };
  }

  const sidecar = getRoleSidecar(roleId);
  if (sidecar === undefined) {
    // A dispatched role MUST have a sidecar (the @cq/config invariant test
    // guarantees this); a missing one is an authoring defect, not a user error.
    throw new Error(
      `prompt catalog: dispatched role "${roleId}" has no schema sidecar in @cq/config`,
    );
  }
  return {
    roleId,
    kind: "dispatched-subagent",
    dispatched: true,
    promptTemplate,
    ...catalogMetadata,
    version: sidecar.version,
    inputSchema: sidecar.inputSchema as JSONSchemaDoc,
    outputSchema: sidecar.outputSchema as JSONSchemaDoc,
  };
}

/**
 * Resolve the schema for a role's `input`/`output` side, failing fast on an
 * unknown role ({@link UnknownRoleError}) or an orchestrator-command role
 * ({@link NoSchemaForRoleError} — only dispatched subagents have schemas).
 */
function schemaForRole(
  store: PromptArtifactStore,
  roleId: string,
  side: "input" | "output",
): JSONSchema {
  const artifact = roleArtifact(store, roleId);
  if (artifact.metadata.roleKind === "orchestrator-command") {
    throw new NoSchemaForRoleError(roleId, side);
  }
  const sidecar = getRoleSidecar(roleId);
  if (sidecar === undefined) {
    throw new Error(
      `prompt catalog: dispatched role "${roleId}" has no schema sidecar in @cq/config`,
    );
  }
  return side === "input" ? sidecar.inputSchema : sidecar.outputSchema;
}

/** Narrow `@cq/config`'s ValidationResult to the structural capability result. */
function toCapabilityResult(result: ValidationResult): PromptValidationResult {
  return result.ok ? { ok: true } : { ok: false, errors: result.errors };
}

/**
 * Validate a `payload` against `schema`, tolerating a JSON-STRING payload (the
 * MCP wire serialises a nested object arg as a JSON string). A string is parsed
 * before validation; an unparseable string FAILS LOUD with a distinct `parse`
 * {@link PromptValidationResult} error (keyword `"parse"`) rather than being
 * passed raw to Ajv, silently accepted, or thrown — preserving the `{ok,errors}`
 * contract. A successfully parsed value is validated normally, so the schema's
 * own constraints (e.g. `required`) still fire on a parsed-but-invalid object.
 */
function validatePayload(schema: JSONSchema, payload: unknown): PromptValidationResult {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (e) {
      return {
        ok: false,
        errors: [
          {
            path: "",
            keyword: "parse",
            message: `payload is not valid JSON: ${(e as Error).message}`,
            schemaPath: "",
            params: {},
          },
        ],
      };
    }
  }
  return toCapabilityResult(validateAgainstSchema(schema, value));
}

/**
 * Build the business capability over an already-constructed artifact store.
 * This function does not select a prompt root or render/transform prompt bytes.
 */
export function createPromptCatalogCapability(store: PromptArtifactStore): PromptCatalogCapability {
  return {
    fetchPrompt: (roleId: string) => fetchPromptFor(store, roleId),
    validateInput: (roleId: string, input: unknown) =>
      validatePayload(schemaForRole(store, roleId, "input"), input),
    validateOutput: (roleId: string, output: unknown) =>
      validatePayload(schemaForRole(store, roleId, "output"), output),
  };
}

function createLegacySourcePromptArtifactStore(root: string): PromptArtifactStore {
  const repoLocal = path.join(root, ...ASSETS_SUBPATH);
  const fromEnv = process.env["CQ_ASSETS_DIR"];
  const assetsRoot = existsSync(repoLocal)
    ? repoLocal
    : fromEnv !== undefined && fromEnv !== ""
      ? fromEnv
      : repoLocal;

  const roles = Object.freeze(
    AGENT_ROLE_TIERS.map((entry): PromptArtifactRoleMetadata => {
      const dispatched = entry.agentTierKey !== null;
      return Object.freeze({
        roleId: entry.id,
        roleKind: dispatched ? "dispatched-subagent" : "orchestrator-command",
        artifactPath: assetRelPath(entry.id, dispatched),
        sidecarSchemaRoleId: dispatched ? entry.id : null,
      });
    }),
  );
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(
      roles.map((entry) => ({
        roleId: entry.roleId,
        roleKind: entry.roleKind,
        sidecar:
          entry.sidecarSchemaRoleId === null ? null : { schemaRoleId: entry.sidecarSchemaRoleId },
      })),
    ),
  );

  return {
    readManifest: () =>
      Object.freeze({
        bytes: Uint8Array.from(manifestBytes),
        roles,
      }),
    readRole: (roleId: string) => {
      const metadata = roles.find((entry) => entry.roleId === roleId);
      if (metadata === undefined) {
        throw new PromptArtifactNotFoundError(roleId);
      }
      const absPath = path.join(assetsRoot, metadata.artifactPath);
      let raw: string;
      try {
        raw = readFileSync(absPath, "utf8");
      } catch (error) {
        throw new Error(
          `prompt catalog: cannot read asset for role "${roleId}" at ${absPath}: ${(error as Error).message}`,
        );
      }
      return Object.freeze({
        metadata,
        bytes: new TextEncoder().encode(stripFrontmatter(raw)),
      });
    },
  };
}

export function createLegacySourcePromptCatalogCapability(root: string): PromptCatalogCapability {
  return createPromptCatalogCapability(createLegacySourcePromptArtifactStore(root));
}
