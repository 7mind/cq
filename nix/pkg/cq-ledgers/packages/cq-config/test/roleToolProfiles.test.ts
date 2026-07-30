import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  CODEX_ROLE_TOOL_PROFILE_PROBE,
  DOMAIN_LEDGER_TOOL_NAMES,
  HARNESS_ROLE_TOOL_ENFORCEMENT,
  LEDGER_CAPABILITY_TOOL_NAMES,
  ROLE_IDENTIFIED_CORPUS,
  ROLE_TOOL_CAPABILITY_MATRIX,
  exposedLedgerToolsForRole,
} from "@cq/config";
import { PROMPT_CATALOG_PROJECTION } from "../src/promptCatalog.gen.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const CODEX_PROBE = path.join(
  REPO_ROOT,
  "nix",
  "pkg",
  "cq-ledgers",
  "packages",
  "cq-config",
  "scripts",
  "probe-codex-role-tool-profile.ts",
);

describe("T1325 role tool capability matrix", () => {
  test("covers every prompt-catalogue command and dispatched role exactly once", () => {
    const catalogRoles = PROMPT_CATALOG_PROJECTION.catalog.map(({ roleId }) => roleId).sort();
    expect(Object.keys(ROLE_TOOL_CAPABILITY_MATRIX).sort()).toEqual(catalogRoles);
    expect(catalogRoles).toHaveLength(24);
    expect(
      Object.values(ROLE_TOOL_CAPABILITY_MATRIX).filter(
        ({ roleKind }) => roleKind === "dispatched-subagent",
      ),
    ).toHaveLength(9);
  });

  test("every contract-required tool is exposed and zero-domain roles expose no domain tool", () => {
    const domainTools = new Set<string>(DOMAIN_LEDGER_TOOL_NAMES);
    for (const profile of Object.values(ROLE_TOOL_CAPABILITY_MATRIX)) {
      const exposed = new Set<string>(exposedLedgerToolsForRole(profile.roleId));
      for (const required of profile.contractRequiredTools) {
        expect(exposed.has(required), `${profile.roleId} requires ${required}`).toBe(true);
      }
      const exposedDomain = [...exposed].filter((tool) => domainTools.has(tool));
      if (profile.zeroDomainCalls) expect(exposedDomain, profile.roleId).toEqual([]);
    }

    for (const catalogRole of PROMPT_CATALOG_PROJECTION.catalog) {
      const source = readFileSync(
        path.join(REPO_ROOT, "nix", "pkg", "cq-assets", catalogRole.canonicalSource),
        "utf8",
      );
      const exposed = new Set<string>(exposedLedgerToolsForRole(catalogRole.roleId));
      for (const tool of LEDGER_CAPABILITY_TOOL_NAMES) {
        const mentioned = new RegExp(`(^|[^a-z_])${tool}([^a-z_]|$)`, "m").test(source);
        if (mentioned) {
          expect(exposed.has(tool), `${catalogRole.roleId} mentions ${tool}`).toBe(true);
        }
      }
    }
  });

  test("maps the role-identified 357-transcript corpus without treating retired behavior as authority", () => {
    expect(ROLE_IDENTIFIED_CORPUS.transcripts).toBe(357);
    expect(ROLE_IDENTIFIED_CORPUS.unclassifiedTranscripts).toBe(0);
    expect(ROLE_IDENTIFIED_CORPUS.roles["plan-advance"]?.transcripts).toBe(51);
    expect(ROLE_IDENTIFIED_CORPUS.roles["implement-worker"]?.zeroLedgerTranscripts).toBe(66);
    expect(ROLE_IDENTIFIED_CORPUS.roles["investigate-prober"]?.zeroLedgerTranscripts).toBe(2);

    for (const [roleId, observation] of Object.entries(ROLE_IDENTIFIED_CORPUS.roles)) {
      const exposed = new Set<string>(exposedLedgerToolsForRole(roleId));
      for (const tool of Object.keys(observation.currentLedgerCalls)) {
        expect(
          exposed.has(tool) || observation.supersededCalls.includes(tool),
          `${roleId} observed ${tool} without an exposure or supersession decision`,
        ).toBe(true);
      }
    }
  });

  test("records pre-context enforcement seams for Claude, Pi, and Codex", () => {
    expect(HARNESS_ROLE_TOOL_ENFORCEMENT.claude).toMatchObject({
      childBoundary: "process",
      filteringStage: "before-model-context",
      mechanism: "strict-per-dispatch-mcp",
    });
    expect(HARNESS_ROLE_TOOL_ENFORCEMENT.pi).toMatchObject({
      childBoundary: "process",
      filteringStage: "before-model-context",
      mechanism: "--exclude-tools",
    });
    expect(HARNESS_ROLE_TOOL_ENFORCEMENT.codex).toMatchObject({
      childBoundary: "repository-owned-process",
      filteringStage: "before-model-context",
      mechanism: "mcp-server-enabled-tools",
      nativePerAgentFiltering: false,
    });
    expect(LEDGER_CAPABILITY_TOOL_NAMES).toHaveLength(32);
  });

  test("ships an executable Codex child-boundary probe, not a configuration-only assertion", () => {
    expect(CODEX_ROLE_TOOL_PROFILE_PROBE).toEqual({
      script: "packages/cq-config/scripts/probe-codex-role-tool-profile.ts",
      allowTool: "fetch_item",
      denyTool: "create_item",
    });
    expect(existsSync(CODEX_PROBE)).toBe(true);
    const source = readFileSync(CODEX_PROBE, "utf8");
    expect(source).toContain("capturedModelTools");
    expect(source).toContain("enabled_tools");
    expect(source).toContain("fetch_item");
    expect(source).toContain("create_item");
    const probe = Bun.spawnSync([process.execPath, CODEX_PROBE], {
      cwd: path.join(REPO_ROOT, "nix", "pkg", "cq-ledgers"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(probe.exitCode, probe.stderr.toString()).toBe(0);
    const observation = JSON.parse(probe.stdout.toString()) as {
      readonly boundary: string;
      readonly allowedName: string;
      readonly deniedName: string;
      readonly capturedModelTools: readonly string[];
      readonly deniedDefinitionReachedModelContext: boolean;
    };
    expect(observation.boundary).toBe("codex-exec-process");
    expect(observation.capturedModelTools).toContain(observation.allowedName);
    expect(observation.capturedModelTools).not.toContain(observation.deniedName);
    expect(observation.deniedDefinitionReachedModelContext).toBe(false);
  });
});
