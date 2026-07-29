/**
 * T343 — the typed prompt-catalog capability (fetchPrompt / validateInput /
 * validateOutput), dual-tested. validateInput remains direct inspection/debug
 * API and is intentionally absent from ordinary tools/list.
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
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getRoleSidecar, isAllowlistedValidateInputCaller } from "@cq/config";
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
const PROMPT_SURFACE = "codex";

const INTENTIONAL_DIFFERENCE = {
  kind: "tool-vocabulary",
  reason: "Each prompt surface exposes different host tool names.",
  surfaces: ["claude", "codex", "pi"],
} as const;

const FRAGMENT_BINDING = {
  fragment: "host-tool-vocabulary",
  sourceBlock: "frontmatter host tool and isolation capabilities",
  supportedSurfaces: ["claude", "codex", "pi"],
  forbiddenVocabulary: {
    claude: ["$cq-"],
    codex: ["Agent"],
    pi: ["Agent"],
  },
  intentionalDifference: INTENTIONAL_DIFFERENCE,
} as const;

function manifestRole(
  roleId: string,
  roleKind: "dispatched-subagent" | "orchestrator-command",
  dispatchRelations: readonly Readonly<Record<string, string>>[],
): Readonly<Record<string, unknown>> {
  return {
    roleId,
    roleKind,
    canonicalSource:
      roleKind === "dispatched-subagent"
        ? `agents/${roleId}.md`
        : `commands/cq/${roleId}.md`,
    surfaces: ["claude", "codex", "pi"],
    sharedSourceBlock: {
      classification: "shared-prose",
      sourceBlock: "all prose outside the classified surface-sensitive blocks",
      targetFragment: null,
    },
    fragmentBindings: [FRAGMENT_BINDING],
    dispatchRelations,
    intentionalDifferences: [INTENTIONAL_DIFFERENCE],
    sidecar: roleKind === "dispatched-subagent" ? { schemaRoleId: roleId } : null,
  };
}

const DISPATCHED_PROMPT =
  "---\ndescription: rendered\n---\n\nKeep {{cq:literal}} and $ARGUMENTS unchanged.\n";
const COMMAND_PROMPT = "# /cq:advance\n\nRendered command prompt.\n";
const MANIFEST_BYTES = new TextEncoder().encode(
  JSON.stringify([
    manifestRole(DISPATCHED_ROLE, "dispatched-subagent", []),
    manifestRole(COMMAND_ROLE, "orchestrator-command", [
      { kind: "dispatch", targetRoleId: DISPATCHED_ROLE },
    ]),
  ]),
);
const ROLE_ARTIFACTS = [
  { roleId: DISPATCHED_ROLE, bytes: new TextEncoder().encode(DISPATCHED_PROMPT) },
  { roleId: COMMAND_ROLE, bytes: new TextEncoder().encode(COMMAND_PROMPT) },
] as const;

/** Lowercase hex SHA-256 of raw bytes. */
function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const DISPATCHED_PROMPT_DIGEST = sha256Bytes(ROLE_ARTIFACTS[0].bytes);
const CATALOG_DIGEST = sha256Bytes(MANIFEST_BYTES);

/** The attested surface manifest (T683) binding the fixture's exact role bytes. */
function surfaceManifestBytes(dispatchedVersion: number): Uint8Array {
  const core = {
    surface: PROMPT_SURFACE,
    catalogMetadataHash: CATALOG_DIGEST,
    roles: [
      {
        roleId: DISPATCHED_ROLE,
        version: dispatchedVersion,
        sha256: DISPATCHED_PROMPT_DIGEST,
      },
      {
        roleId: COMMAND_ROLE,
        version: null,
        sha256: sha256Bytes(ROLE_ARTIFACTS[1].bytes),
      },
    ],
  };
  return new TextEncoder().encode(
    JSON.stringify({
      ...core,
      surfaceDigest: sha256Bytes(new TextEncoder().encode(JSON.stringify(core))),
    }),
  );
}

const SIDECAR_VERSION = getRoleSidecar(DISPATCHED_ROLE)!.version;
const SURFACE_BYTES = surfaceManifestBytes(SIDECAR_VERSION);

function inMemoryStore(): PromptArtifactStore {
  return new InMemoryPromptArtifactStore(
    PROMPT_SURFACE,
    SURFACE_BYTES,
    MANIFEST_BYTES,
    ROLE_ARTIFACTS,
  );
}

function filesystemStore(): PromptArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "cq-prompt-capability-"));
  try {
    writeFileSync(path.join(root, "surface.json"), SURFACE_BYTES);
    writeFileSync(path.join(root, "catalog.json"), MANIFEST_BYTES);
    for (const artifact of ROLE_ARTIFACTS) {
      const artifactPath = path.join(root, "roles", `${artifact.roleId}.md`);
      mkdirSync(path.dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, artifact.bytes);
    }
    return new FileSystemPromptArtifactStore(PROMPT_SURFACE, root);
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
      expect(result.promptSurface).toBe(PROMPT_SURFACE);
      expect(result.renderer).toEqual({
        sharedSourceBlock: {
          classification: "shared-prose",
          sourceBlock: "all prose outside the classified surface-sensitive blocks",
          targetFragment: null,
        },
        fragmentBindings: [FRAGMENT_BINDING],
      });
      expect(result.sourcePath).toBe("agents/plan-advance.md");
      expect(result.workflowDependencies).toEqual([]);
      expect(result.requiredCapabilities).toEqual(["host-tool-vocabulary"]);
      expect(result.intentionalDifferences).toEqual([INTENTIONAL_DIFFERENCE]);
      // The attested root binds exact bytes and the catalog hash (T683).
      expect(result.promptDigest).toBe(DISPATCHED_PROMPT_DIGEST);
      expect(result.catalogHash).toBe(CATALOG_DIGEST);
      // Both schemas present, and they are the @cq/config draft-2020-12 documents.
      expect(result.inputSchema).toBeDefined();
      expect(result.outputSchema).toBeDefined();
      expect(result.inputSchema?.["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(result.outputSchema?.["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    });

    it("an allowlisted debug caller reaches validateInput directly, outside tools/list", () => {
      expect(isAllowlistedValidateInputCaller("agents-tab")).toBe(true);
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
      // DEFAULT-mode PlanStepResult branch of the oneOf (T854).
      const ok = cap.validateOutput(DISPATCHED_ROLE, { mode: "default", action: "noop" });
      expect(ok.ok).toBe(true);
      // An unknown action fails the oneOf.
      const bad = cap.validateOutput(DISPATCHED_ROLE, { mode: "default", action: "bogus" });
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
      expect(result.promptSurface).toBe(PROMPT_SURFACE);
      expect(result.sourcePath).toBe("commands/cq/advance.md");
      expect(result.workflowDependencies).toEqual([
        { kind: "dispatch", targetRoleId: DISPATCHED_ROLE },
      ]);
      expect(result.requiredCapabilities).toEqual(["host-tool-vocabulary"]);
      expect(result.intentionalDifferences).toEqual([INTENTIONAL_DIFFERENCE]);
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

describe("attested version pairing (T683)", () => {
  const mismatchedSurfaceBytes = surfaceManifestBytes(SIDECAR_VERSION + 1);

  function mismatchedInMemoryStore(): PromptArtifactStore {
    return new InMemoryPromptArtifactStore(
      PROMPT_SURFACE,
      mismatchedSurfaceBytes,
      MANIFEST_BYTES,
      ROLE_ARTIFACTS,
    );
  }

  function mismatchedFilesystemStore(): PromptArtifactStore {
    const root = mkdtempSync(path.join(tmpdir(), "cq-prompt-capability-stale-"));
    try {
      writeFileSync(path.join(root, "surface.json"), mismatchedSurfaceBytes);
      writeFileSync(path.join(root, "catalog.json"), MANIFEST_BYTES);
      for (const artifact of ROLE_ARTIFACTS) {
        const artifactPath = path.join(root, "roles", `${artifact.roleId}.md`);
        mkdirSync(path.dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, artifact.bytes);
      }
      return new FileSystemPromptArtifactStore(PROMPT_SURFACE, root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("fails closed when the sidecar version and the attested root version mismatch", () => {
    for (const store of [mismatchedInMemoryStore(), mismatchedFilesystemStore()]) {
      const cap = createPromptCatalogCapability(store);
      expect(() => cap.fetchPrompt(DISPATCHED_ROLE)).toThrow(
        `schema sidecar version ${String(SIDECAR_VERSION)} does not match the attested prompt root version ${String(SIDECAR_VERSION + 1)}`,
      );
      expect(() => cap.validateInput(DISPATCHED_ROLE, { goalId: "G1" })).toThrow(
        "does not match the attested prompt root version",
      );
      expect(() => cap.validateOutput(DISPATCHED_ROLE, {})).toThrow(
        "does not match the attested prompt root version",
      );
    }
  });
});

/**
 * D60 regression: validateInput/validateOutput are called with a JSON STRING
 * when the Claude Code MCP client serializes a nested object arg on the wire.
 * The fix (T422) will add string-tolerance at the promptCatalogCapability
 * entrypoint. Cases (ii)–(iv) are `test.failing` until that fix lands.
 *
 * Case (i) — genuine object — is a normal passing test that belongs here
 * alongside the failing cases so the full regression set is co-located.
 */
describe("D60 regression — validateInput string-tolerance at the capability boundary", () => {
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
