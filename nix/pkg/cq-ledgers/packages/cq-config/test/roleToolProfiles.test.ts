import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
const CORPUS_AGGREGATOR = path.join(
  REPO_ROOT,
  "nix",
  "pkg",
  "cq-ledgers",
  "packages",
  "cq-config",
  "scripts",
  "aggregate-role-tool-corpus.ts",
);
const CORPUS_EVIDENCE = path.join(
  REPO_ROOT,
  "nix",
  "pkg",
  "cq-ledgers",
  "packages",
  "cq-config",
  "evidence",
  "role-tool-corpus.json",
);
const CORPUS_MANIFEST = path.join(
  REPO_ROOT,
  "docs",
  "drafts",
  "20260725-2130-t679-rs3-remeasure",
  "corpus-manifest.json",
);

interface RoleCorpusEvidence {
  readonly schemaVersion: 1;
  readonly manifest: {
    readonly path: string;
    readonly sha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
  };
  readonly transcripts: number;
  readonly unclassifiedTranscripts: number;
  readonly roles: Readonly<
    Record<
      string,
      {
        readonly transcripts: number;
        readonly zeroLedgerTranscripts: number;
        readonly ledgerCalls: Readonly<Record<string, number>>;
      }
    >
  >;
}

const roleCorpusEvidence = JSON.parse(
  readFileSync(CORPUS_EVIDENCE, "utf8"),
) as RoleCorpusEvidence;
const verifyRawCorpus =
  process.env["CQ_T1325_VERIFY_RAW_CORPUS"] === "1" ? test : test.skip;

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

  test("maps checked-in, manifest-bound corpus evidence without treating retired behavior as authority", () => {
    const manifestBytes = readFileSync(CORPUS_MANIFEST);
    expect(roleCorpusEvidence.schemaVersion).toBe(1);
    expect(roleCorpusEvidence.manifest).toEqual({
      path: ROLE_IDENTIFIED_CORPUS.manifest,
      sha256: createHash("sha256").update(manifestBytes).digest("hex"),
      fileCount: ROLE_IDENTIFIED_CORPUS.transcripts,
      totalBytes: 95_152_796,
    });
    expect(roleCorpusEvidence.transcripts).toBe(roleCorpusEvidence.manifest.fileCount);
    expect(roleCorpusEvidence.transcripts).toBe(ROLE_IDENTIFIED_CORPUS.transcripts);
    expect(roleCorpusEvidence.unclassifiedTranscripts).toBe(
      ROLE_IDENTIFIED_CORPUS.unclassifiedTranscripts,
    );
    expect(Object.keys(roleCorpusEvidence.roles).sort()).toEqual(
      Object.keys(ROLE_IDENTIFIED_CORPUS.roles).sort(),
    );

    for (const [roleId, declared] of Object.entries(ROLE_IDENTIFIED_CORPUS.roles)) {
      const observation = roleCorpusEvidence.roles[roleId];
      expect(observation, roleId).toBeDefined();
      if (observation === undefined) {
        throw new Error(`missing checked-in corpus role "${roleId}"`);
      }
      const declaredCalls = {
        ...declared.currentLedgerCalls,
        ...declared.retiredCalls,
      };
      expect({
        transcripts: observation.transcripts,
        zeroLedgerTranscripts: observation.zeroLedgerTranscripts,
      }).toEqual({
        transcripts: declared.transcripts,
        zeroLedgerTranscripts: declared.zeroLedgerTranscripts,
      });
      expect(Object.values(observation.ledgerCalls).reduce((sum, count) => sum + count, 0)).toBe(
        Object.values(declaredCalls).reduce((sum, count) => sum + count, 0),
      );
      for (const [tool, observedCount] of Object.entries(observation.ledgerCalls)) {
        const declaredCount = declaredCalls[tool as keyof typeof declaredCalls];
        if (declaredCount !== undefined) {
          expect(observedCount, `${roleId} observed ${tool}`).toBeLessThanOrEqual(declaredCount);
        }
      }
      const exposed = new Set<string>(exposedLedgerToolsForRole(roleId));
      for (const tool of Object.keys(declared.currentLedgerCalls)) {
        expect(
          exposed.has(tool) || declared.supersededCalls.includes(tool),
          `${roleId} mapped ${tool} without an exposure or supersession decision`,
        ).toBe(true);
      }
    }
  });

  verifyRawCorpus("ON-DEMAND: raw corpus regenerates the checked-in evidence exactly", () => {
    expect(existsSync(CORPUS_AGGREGATOR)).toBe(true);
    expect(existsSync(CORPUS_MANIFEST)).toBe(true);
    const args = [process.execPath, CORPUS_AGGREGATOR, "--manifest", CORPUS_MANIFEST];
    const corpusRoot = process.env["CQ_T1325_CORPUS_ROOT"];
    if (corpusRoot !== undefined) args.push("--corpus-root", corpusRoot);
    const aggregate = Bun.spawnSync(
      args,
      {
        cwd: path.join(REPO_ROOT, "nix", "pkg", "cq-ledgers"),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(aggregate.exitCode, aggregate.stderr.toString()).toBe(0);
    const observed = JSON.parse(aggregate.stdout.toString()) as RoleCorpusEvidence;
    expect(observed).toEqual(roleCorpusEvidence);
  }, 10_000);

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
    expect(LEDGER_CAPABILITY_TOOL_NAMES).toHaveLength(29);
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
