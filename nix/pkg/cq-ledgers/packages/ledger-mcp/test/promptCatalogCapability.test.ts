/**
 * T343 — the typed prompt-catalog capability (fetch_prompt / validate_input /
 * validate_output), dual-tested.
 *
 * ONE abstract suite ({@link runPromptCatalogSuite}) exercises the
 * `PromptCatalogCapability` contract, then runs against BOTH:
 *
 *  - the production filesystem PromptArtifactStore over an already-built
 *    temporary surface root; and
 *  - the strict hand-written in-memory PromptArtifactStore dummy.
 *
 * The suite asserts the acceptance: fetch_prompt('plan-advance') returns the
 * prompt + both schemas; validate_input accepts a valid plan-advance input and
 * rejects an invalid one with a structured error (failing field path);
 * validate_output likewise; an unknown roleId fails fast; and an
 * orchestrator-command roleId returns prompt-only from fetch_prompt with
 * validate_input/output failing fast with the no-schema error.
 */

import { describe, it, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { UnknownRoleError, NoSchemaForRoleError, type PromptCatalogCapability } from "@cq/ledger";
import { createPromptCatalogCapability } from "../src/promptCatalogCapability.js";
import {
  FileSystemPromptArtifactStore,
  InMemoryPromptArtifactStore,
  type PromptArtifactStore,
} from "../src/promptArtifactStore.js";

/** A dispatched role with both schemas, and an orchestrator-command role with none. */
const DISPATCHED_ROLE = "plan-advance";
const COMMAND_ROLE = "advance";

const DISPATCHED_PROMPT =
  "---\ndescription: rendered\n---\n\nKeep {{cq:literal}} and $ARGUMENTS unchanged.\n";
const COMMAND_PROMPT = "# /cq:advance\n\nRendered command prompt.\n";
const MANIFEST_BYTES = new TextEncoder().encode(
  JSON.stringify([
    {
      roleId: DISPATCHED_ROLE,
      roleKind: "dispatched-subagent",
      sidecar: { schemaRoleId: DISPATCHED_ROLE },
    },
    {
      roleId: COMMAND_ROLE,
      roleKind: "orchestrator-command",
      sidecar: null,
    },
  ]),
);
const ROLE_ARTIFACTS = [
  { roleId: DISPATCHED_ROLE, bytes: new TextEncoder().encode(DISPATCHED_PROMPT) },
  { roleId: COMMAND_ROLE, bytes: new TextEncoder().encode(COMMAND_PROMPT) },
] as const;

function inMemoryStore(): PromptArtifactStore {
  return new InMemoryPromptArtifactStore(MANIFEST_BYTES, ROLE_ARTIFACTS);
}

function filesystemStore(): PromptArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "cq-prompt-capability-"));
  try {
    writeFileSync(path.join(root, "catalog.json"), MANIFEST_BYTES);
    for (const artifact of ROLE_ARTIFACTS) {
      const artifactPath = path.join(root, "roles", `${artifact.roleId}.md`);
      mkdirSync(path.dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, artifact.bytes);
    }
    return new FileSystemPromptArtifactStore(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeCapability(): PromptCatalogCapability {
  return createPromptCatalogCapability(inMemoryStore());
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
      expect(result.promptTemplate).toBe(DISPATCHED_PROMPT);
      // Both schemas present, and they are the @cq/config draft-2020-12 documents.
      expect(result.inputSchema).toBeDefined();
      expect(result.outputSchema).toBeDefined();
      expect(result.inputSchema?.["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(result.outputSchema?.["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
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

// Run the SAME capability contract over both artifact-store implementations.
runPromptCatalogSuite("production filesystem artifact store", () =>
  createPromptCatalogCapability(filesystemStore()),
);
runPromptCatalogSuite("strict in-memory artifact store", () =>
  createPromptCatalogCapability(inMemoryStore()),
);

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
    const cap = makeCapability();
    const result = cap.validateInput(DISPATCHED_ROLE, { goalId: "G1" });
    expect(result.ok).toBe(true);
  });

  // (ii) JSON-string encoding of a valid payload — FAILS today (returns
  // {ok:false, errors:[{keyword:'type', message:'must be object'}]}).
  // The MCP wire serialises the nested `input` arg as a JSON string;
  // validateInput must parse it before validating.
  test("(ii) JSON-string JSON.stringify({goalId:'G1'}) → {ok:true} [D60]", () => {
    const cap = makeCapability();
    const result = cap.validateInput(DISPATCHED_ROLE, JSON.stringify({ goalId: "G1" }));
    expect(result.ok).toBe(true);
  });

  // (iii) Unparseable JSON string — FAILS today (no 'parse' keyword exists
  // yet; the code would either throw or return keyword:'type').
  // After the fix, an unparseable string should return
  // {ok:false, errors:[{keyword:'parse', ...}]}.
  test("(iii) unparseable string '{not json' → {ok:false, errors[0].keyword==='parse'} [D60]", () => {
    const cap = makeCapability();
    const result = cap.validateInput(DISPATCHED_ROLE, "{not json");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation failure");
    expect(result.errors[0]?.keyword).toBe("parse");
  });

  // (iv) Over-acceptance guard: a JSON-string of {} for a role requiring
  // goalId — FAILS today (returns keyword:'type' from the must-be-object
  // pre-check rather than keyword:'required' after parsing).
  // After the fix, the string is parsed to {}, the schema's 'required'
  // check fires, and errors[0].keyword === 'required'.
  test("(iv) JSON.stringify({}) for plan-advance → {ok:false, errors[0].keyword==='required'} [D60]", () => {
    const cap = makeCapability();
    const result = cap.validateInput(DISPATCHED_ROLE, JSON.stringify({}));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation failure");
    expect(result.errors[0]?.keyword).toBe("required");
  });
});
