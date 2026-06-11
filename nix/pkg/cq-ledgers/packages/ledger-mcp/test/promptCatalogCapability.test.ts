/**
 * T343 — the typed prompt-catalog capability (fetch_prompt / validate_input /
 * validate_output), dual-tested.
 *
 * ONE abstract suite ({@link runPromptCatalogSuite}) exercises the
 * `PromptCatalogCapability` contract, then runs against BOTH:
 *
 *  - the REAL adapter `createPromptCatalogCapability(repoRoot)` — reads the role
 *    prompt bodies from the committed `cq-assets/*.md` and joins the `@cq/config`
 *    typed-catalog schemas (the production wiring buildServer injects); and
 *  - a hand-written IN-MEMORY dummy that serves the prompt body from a literal
 *    map but reuses the SAME `@cq/config` sidecars + validator — so the contract
 *    is exercised with no filesystem dependency.
 *
 * The suite asserts the acceptance: fetch_prompt('plan-advance') returns the
 * prompt + both schemas; validate_input accepts a valid plan-advance input and
 * rejects an invalid one with a structured error (failing field path);
 * validate_output likewise; an unknown roleId fails fast; and an
 * orchestrator-command roleId returns prompt-only from fetch_prompt with
 * validate_input/output failing fast with the no-schema error.
 */

import { describe, it, test, expect } from "bun:test";
import * as path from "node:path";
import {
  getRoleSidecar,
  validateAgainstSchema,
  AGENT_ROLE_TIERS,
  type JSONSchema,
} from "@cq/config";
import {
  UnknownRoleError,
  NoSchemaForRoleError,
  type PromptCatalogCapability,
  type JSONSchemaDoc,
} from "@cq/ledger";
import { createPromptCatalogCapability } from "../src/promptCatalogCapability.js";

/** A dispatched role with both schemas, and an orchestrator-command role with none. */
const DISPATCHED_ROLE = "plan-advance";
const COMMAND_ROLE = "advance";

/**
 * Repo root, 6 levels up from this test dir
 * (`nix/pkg/cq-ledgers/packages/ledger-mcp/test`): test -> ledger-mcp ->
 * packages -> cq-ledgers -> pkg -> nix -> <root>. `createPromptCatalogCapability`
 * resolves `<root>/nix/pkg/cq-assets/` underneath this.
 */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");

/**
 * A hand-written in-memory dummy: serves the prompt body from a literal map and
 * reuses the SAME `@cq/config` schema source + Ajv validator the real adapter
 * uses. The body text is arbitrary — the suite checks only that fetch_prompt
 * returns a non-empty prompt for a known role, not its exact content.
 */
function inMemoryCapability(): PromptCatalogCapability {
  const bodies: Record<string, string> = {
    [DISPATCHED_ROLE]: "# plan-advance\n\nDummy prompt body for the in-memory adapter.",
    [COMMAND_ROLE]: "# /cq:advance\n\nDummy orchestrator-command prompt body.",
  };
  const entry = (roleId: string) => AGENT_ROLE_TIERS.find((r) => r.id === roleId);
  const schemaFor = (roleId: string, side: "input" | "output"): JSONSchema => {
    const e = entry(roleId);
    if (e === undefined) throw new UnknownRoleError(roleId);
    if (e.agentTierKey === null) throw new NoSchemaForRoleError(roleId, side);
    const sidecar = getRoleSidecar(roleId);
    if (sidecar === undefined) throw new Error(`no sidecar for ${roleId}`);
    return side === "input" ? sidecar.inputSchema : sidecar.outputSchema;
  };
  return {
    fetchPrompt: (roleId) => {
      const e = entry(roleId);
      if (e === undefined) throw new UnknownRoleError(roleId);
      const body = bodies[roleId] ?? "dummy body";
      if (e.agentTierKey === null) {
        return { roleId, kind: "orchestrator-command", dispatched: false, promptTemplate: body };
      }
      const sidecar = getRoleSidecar(roleId);
      if (sidecar === undefined) throw new Error(`no sidecar for ${roleId}`);
      return {
        roleId,
        kind: "dispatched-subagent",
        dispatched: true,
        promptTemplate: body,
        version: sidecar.version,
        inputSchema: sidecar.inputSchema as JSONSchemaDoc,
        outputSchema: sidecar.outputSchema as JSONSchemaDoc,
      };
    },
    validateInput: (roleId, input) => {
      const r = validateAgainstSchema(schemaFor(roleId, "input"), input);
      return r.ok ? { ok: true } : { ok: false, errors: r.errors };
    },
    validateOutput: (roleId, output) => {
      const r = validateAgainstSchema(schemaFor(roleId, "output"), output);
      return r.ok ? { ok: true } : { ok: false, errors: r.errors };
    },
  };
}

/** The shared contract suite, run against any {@link PromptCatalogCapability}. */
function runPromptCatalogSuite(label: string, make: () => PromptCatalogCapability): void {
  describe(`PromptCatalogCapability — ${label}`, () => {
    it("fetch_prompt('plan-advance') returns the prompt + both schemas", () => {
      const cap = make();
      const result = cap.fetchPrompt(DISPATCHED_ROLE);
      expect(result.roleId).toBe(DISPATCHED_ROLE);
      expect(result.kind).toBe("dispatched-subagent");
      expect(result.dispatched).toBe(true);
      expect(result.promptTemplate.length).toBeGreaterThan(0);
      // Both schemas present, and they are the @cq/config draft-2020-12 documents.
      expect(result.inputSchema).toBeDefined();
      expect(result.outputSchema).toBeDefined();
      expect(result.inputSchema?.["$schema"]).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      expect(result.outputSchema?.["$schema"]).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
    });

    it("validate_input accepts a valid plan-advance input", () => {
      const cap = make();
      const result = cap.validateInput(DISPATCHED_ROLE, { goalId: "G41" });
      expect(result.ok).toBe(true);
    });

    it("validate_input rejects an invalid plan-advance input with the failing field path", () => {
      const cap = make();
      // goalId must match /^G[0-9]+$/; supply a non-matching value.
      const result = cap.validateInput(DISPATCHED_ROLE, { goalId: "not-a-goal" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected validation failure");
      expect(result.errors.length).toBeGreaterThan(0);
      // The structured error carries the failing JSON-Schema instance path.
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain("/goalId");
      const keywords = result.errors.map((e) => e.keyword);
      expect(keywords).toContain("pattern");
    });

    it("validate_input rejects a missing required field with the root path + missingProperty", () => {
      const cap = make();
      const result = cap.validateInput(DISPATCHED_ROLE, {});
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected validation failure");
      const required = result.errors.find((e) => e.keyword === "required");
      expect(required).toBeDefined();
      expect(required?.path).toBe("");
      expect(required?.params["missingProperty"]).toBe("goalId");
    });

    it("validate_output accepts a valid plan-advance output and rejects an invalid one", () => {
      const cap = make();
      // DEFAULT-mode status-token branch of the oneOf.
      const ok = cap.validateOutput(DISPATCHED_ROLE, { mode: "default", status: "completed" });
      expect(ok.ok).toBe(true);
      // An unknown status token fails the oneOf.
      const bad = cap.validateOutput(DISPATCHED_ROLE, { mode: "default", status: "bogus" });
      expect(bad.ok).toBe(false);
      if (bad.ok) throw new Error("expected validation failure");
      expect(bad.errors.length).toBeGreaterThan(0);
    });

    it("fetch_prompt fails fast on an unknown roleId", () => {
      const cap = make();
      expect(() => cap.fetchPrompt("no-such-role")).toThrow(UnknownRoleError);
      expect(() => cap.fetchPrompt("no-such-role")).toThrow(/unknown role/i);
    });

    it("validate_input/validate_output fail fast on an unknown roleId", () => {
      const cap = make();
      expect(() => cap.validateInput("no-such-role", {})).toThrow(UnknownRoleError);
      expect(() => cap.validateOutput("no-such-role", {})).toThrow(UnknownRoleError);
    });

    it("an orchestrator-command roleId returns prompt-only from fetch_prompt", () => {
      const cap = make();
      const result = cap.fetchPrompt(COMMAND_ROLE);
      expect(result.roleId).toBe(COMMAND_ROLE);
      expect(result.kind).toBe("orchestrator-command");
      expect(result.dispatched).toBe(false);
      expect(result.promptTemplate.length).toBeGreaterThan(0);
      expect(result.inputSchema).toBeUndefined();
      expect(result.outputSchema).toBeUndefined();
    });

    it("validate_input/validate_output fail fast with the no-schema error for an orchestrator-command", () => {
      const cap = make();
      expect(() => cap.validateInput(COMMAND_ROLE, {})).toThrow(NoSchemaForRoleError);
      expect(() => cap.validateInput(COMMAND_ROLE, {})).toThrow(
        `role ${COMMAND_ROLE} has no input schema (orchestrator-command)`,
      );
      expect(() => cap.validateOutput(COMMAND_ROLE, {})).toThrow(NoSchemaForRoleError);
      expect(() => cap.validateOutput(COMMAND_ROLE, {})).toThrow(
        `role ${COMMAND_ROLE} has no output schema (orchestrator-command)`,
      );
    });
  });
}

// Run the SAME contract against the real (asset-backed) adapter and the
// in-memory dummy.
runPromptCatalogSuite("real asset-backed adapter", () =>
  createPromptCatalogCapability(REPO_ROOT),
);
runPromptCatalogSuite("in-memory dummy", inMemoryCapability);

/**
 * D60 regression: validate_input/validateOutput are called with a JSON STRING
 * when the Claude Code MCP client serializes a nested object arg on the wire.
 * The fix (T422) will add string-tolerance at the promptCatalogCapability
 * entrypoint. Cases (ii)–(iv) are `test.failing` until that fix lands.
 *
 * Case (i) — genuine object — is a normal passing test that belongs here
 * alongside the failing cases so the full regression set is co-located.
 */
describe("D60 regression — validate_input string-tolerance at MCP entrypoint", () => {
  // (i) Genuine object input — already passes today; stays a normal test.
  it("(i) genuine object {goalId:'G1'} → {ok:true}", () => {
    const cap = createPromptCatalogCapability(REPO_ROOT);
    const result = cap.validateInput(DISPATCHED_ROLE, { goalId: "G1" });
    expect(result.ok).toBe(true);
  });

  // (ii) JSON-string encoding of a valid payload — FAILS today (returns
  // {ok:false, errors:[{keyword:'type', message:'must be object'}]}).
  // The MCP wire serialises the nested `input` arg as a JSON string;
  // validateInput must parse it before validating.
  test.failing(
    "(ii) JSON-string JSON.stringify({goalId:'G1'}) → {ok:true} [D60]",
    () => {
      const cap = createPromptCatalogCapability(REPO_ROOT);
      const result = cap.validateInput(DISPATCHED_ROLE, JSON.stringify({ goalId: "G1" }));
      expect(result.ok).toBe(true);
    },
  );

  // (iii) Unparseable JSON string — FAILS today (no 'parse' keyword exists
  // yet; the code would either throw or return keyword:'type').
  // After the fix, an unparseable string should return
  // {ok:false, errors:[{keyword:'parse', ...}]}.
  test.failing(
    "(iii) unparseable string '{not json' → {ok:false, errors[0].keyword==='parse'} [D60]",
    () => {
      const cap = createPromptCatalogCapability(REPO_ROOT);
      const result = cap.validateInput(DISPATCHED_ROLE, "{not json");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected validation failure");
      expect(result.errors[0]?.keyword).toBe("parse");
    },
  );

  // (iv) Over-acceptance guard: a JSON-string of {} for a role requiring
  // goalId — FAILS today (returns keyword:'type' from the must-be-object
  // pre-check rather than keyword:'required' after parsing).
  // After the fix, the string is parsed to {}, the schema's 'required'
  // check fires, and errors[0].keyword === 'required'.
  test.failing(
    "(iv) JSON.stringify({}) for plan-advance → {ok:false, errors[0].keyword==='required'} [D60]",
    () => {
      const cap = createPromptCatalogCapability(REPO_ROOT);
      const result = cap.validateInput(DISPATCHED_ROLE, JSON.stringify({}));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected validation failure");
      expect(result.errors[0]?.keyword).toBe("required");
    },
  );
});
