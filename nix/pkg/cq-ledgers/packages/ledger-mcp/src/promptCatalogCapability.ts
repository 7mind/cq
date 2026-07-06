/**
 * Typed prompt-catalog capability for the ledger MCP (T343, goal G41).
 *
 * Implements the `fetch_prompt` / `validate_input` / `validate_output` tools by
 * joining TWO committed sources, mirroring the {@link ./configCapability}
 * injection + re-read-per-call pattern:
 *
 *  - the per-role schema sidecars from `@cq/config`'s typed prompt-catalog STORE
 *    (`DISPATCHED_ROLE_SIDECARS` / `getRoleSidecar`, T341) — the SINGLE source of
 *    the dispatched roles' input/output JSON Schemas; and
 *  - the prompt-template body, read fresh from the role's asset markdown under
 *    `cq-assets/` (the same assets the ledger-web codegen consumes) so a prompt
 *    edit is reflected without a server restart.
 *
 * `@cq/ledger` core stays free of `@cq/config` and the asset I/O: the
 * `@cq/config` import, the markdown read, and the Ajv validation all live HERE
 * and the resulting {@link PromptCatalogCapability} is INJECTED into the tool
 * factories (the buildServer wiring in main.ts), exactly as ConfigCapability is.
 *
 * Each method re-reads the asset markdown from disk on every call (no caching),
 * consistent with the compute* methods in configCapability.ts.
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
  return dispatched ? path.join("agents", `${roleId}.md`) : path.join("commands", "cq", `${roleId}.md`);
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

/** The roster entry for a role id, or `undefined` when the id is unknown. */
function rosterEntry(roleId: string): { id: string; agentTierKey: string | null } | undefined {
  return AGENT_ROLE_TIERS.find((r) => r.id === roleId);
}

/**
 * Read + assemble a role's {@link FetchPromptResult}. Fails fast
 * ({@link UnknownRoleError}) on an unknown id. For a dispatched-subagent role,
 * joins the prompt body with its `@cq/config` sidecar schemas; for an
 * orchestrator-command role, returns prompt + metadata with the schema fields
 * ABSENT (role-scope decision 1).
 */
function fetchPromptFor(assetsRoot: string, roleId: string): FetchPromptResult {
  const entry = rosterEntry(roleId);
  if (entry === undefined) {
    throw new UnknownRoleError(roleId);
  }
  const dispatched = entry.agentTierKey !== null;
  const absPath = path.join(assetsRoot, assetRelPath(roleId, dispatched));
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    throw new Error(
      `prompt catalog: cannot read asset for role "${roleId}" at ${absPath}: ${(err as Error).message}`,
    );
  }
  const promptTemplate = stripFrontmatter(raw);

  if (!dispatched) {
    return {
      roleId,
      kind: "orchestrator-command",
      dispatched: false,
      promptTemplate,
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
function schemaForRole(roleId: string, side: "input" | "output"): JSONSchema {
  const entry = rosterEntry(roleId);
  if (entry === undefined) {
    throw new UnknownRoleError(roleId);
  }
  if (entry.agentTierKey === null) {
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
 * Build a {@link PromptCatalogCapability} bound to a ledger/config `root`, and
 * RE-READ the asset markdown on every `fetchPrompt` call (no caching), like the
 * config capability re-reads cq.toml. The schema source is the `@cq/config`
 * typed catalog (imported, not duplicated).
 *
 * ASSETS ROOT resolution (the ledger MCP runs against ANY project, not just this
 * repo):
 *  1. `<root>/nix/pkg/cq-assets/` when it EXISTS — the cq dev-repo layout, so a
 *     developer editing the assets in-tree sees changes live; else
 *  2. `$CQ_ASSETS_DIR` when set — the INSTALLED cq-assets tree (a store path the
 *     nix MCP-server wiring points here for real projects); else
 *  3. `<root>/nix/pkg/cq-assets/` as the last resort (a clear ENOENT naming the
 *     path, rather than silently pointing elsewhere).
 * Without (2), a fresh `cq init` project (no `nix/pkg/cq-assets/`) made
 * `fetch_prompt` fail with ENOENT on `<project>/nix/pkg/cq-assets/...`.
 */
export function createPromptCatalogCapability(root: string): PromptCatalogCapability {
  const repoLocal = path.join(root, ...ASSETS_SUBPATH);
  const fromEnv = process.env["CQ_ASSETS_DIR"];
  const assetsRoot = existsSync(repoLocal)
    ? repoLocal
    : fromEnv !== undefined && fromEnv !== ""
      ? fromEnv
      : repoLocal;
  return {
    fetchPrompt: (roleId: string) => fetchPromptFor(assetsRoot, roleId),
    validateInput: (roleId: string, input: unknown) =>
      validatePayload(schemaForRole(roleId, "input"), input),
    validateOutput: (roleId: string, output: unknown) =>
      validatePayload(schemaForRole(roleId, "output"), output),
  };
}
