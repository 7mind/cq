import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "@cq/config/prompt-renderer";

const PROMPT_SURFACES = ["claude", "codex", "pi"] as const;
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const LEDGER_TOOLS_MODULE = path.resolve(import.meta.dir, "../../ledger/src/mcp/ledgerTools.ts");
const { LEDGER_TOOL_NAMES } = (await import(LEDGER_TOOLS_MODULE)) as {
  readonly LEDGER_TOOL_NAMES: readonly string[];
};
const OPERATIONAL_TOOL_SPECS = [
  {
    neutral: "ledger::derive_predicates",
    source: "ledger::derive_predicates",
    candidate: "derive_predicates",
    roleIdArgument: false,
  },
  {
    neutral: 'ledger::get_config("<section>")',
    source: "ledger::get_config(",
    candidate: "get_config",
    roleIdArgument: false,
  },
  {
    neutral: 'prompt-catalog fetch ("<roleId>")',
    source: "prompt-catalog fetch (",
    candidate: "fetch_prompt",
    roleIdArgument: true,
  },
] as const;
const CLAUDE_LEDGER_TOOL_PREFIX = "mcp__ledger__";
const OPERATIONAL_TOOL_SECTION_HEADING = "## Operational tool vocabulary\n";
const LEDGER_RESPONSE_CONTRACT_FRAGMENT = "ledger-response-contract";
const LEDGER_RESPONSE_CONTRACT_ROLES = new Set([
  "begin",
  "plan",
  "plan/advance",
  "research",
  "research/advance",
]);
const LEDGER_RESPONSE_CONTRACT =
  'Item reads require an explicit projection: use `projection: "compact"` for discovery, status, and reference work, and `projection: "full"` only when narrative fields are required. Mutations return fixed acknowledgements, never full entities; issue an explicit full read only when later reasoning needs omitted narrative.';

interface CatalogRole {
  readonly roleId: string;
  readonly roleKind: "dispatched-subagent" | "orchestrator-command";
  readonly canonicalSource: string;
  readonly fragmentBindings: readonly {
    readonly fragment: string;
    readonly intentionalDifference?: unknown;
  }[];
  readonly dispatchRelations: readonly {
    readonly kind: "dispatch" | "recursion";
    readonly targetRoleId: string;
  }[];
}

interface FragmentContract {
  readonly fragment: string;
  readonly intentionalDifference?: unknown;
}

interface FragmentSource {
  readonly surface: (typeof PROMPT_SURFACES)[number];
  readonly roleId: string;
  readonly fragment: string;
  readonly source: string;
}

function evaluateNixJson(attribute: string): string {
  const result = Bun.spawnSync(["nix", "eval", "--raw", `.#llmAssets.${attribute}`], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout);
}

function evaluateNixValue<Value>(attribute: string): Value {
  const result = Bun.spawnSync(["nix", "eval", "--json", `.#llmAssets.${attribute}`], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as Value;
}

function registeredToolName(candidate: string): string {
  const registered = LEDGER_TOOL_NAMES.find((toolName) => toolName === candidate);
  if (registered === undefined) {
    throw new Error(`required operational tool "${candidate}" is absent from LEDGER_TOOL_NAMES`);
  }
  return registered;
}

function surfaceToolName(
  surface: (typeof PROMPT_SURFACES)[number],
  registeredName: string,
): string {
  return surface === "claude" ? `${CLAUDE_LEDGER_TOOL_PREFIX}${registeredName}` : registeredName;
}

function expectedOperationalToolMapping(
  surface: (typeof PROMPT_SURFACES)[number],
  spec: (typeof OPERATIONAL_TOOL_SPECS)[number],
): string {
  const target = surfaceToolName(surface, registeredToolName(spec.candidate));
  if (spec.candidate === "get_config") {
    return `- \`${spec.neutral}\` → \`${target}({"section":"<section>"})\``;
  }
  if (!spec.roleIdArgument) {
    return `- \`${spec.neutral}\` → \`${target}({})\``;
  }
  return `- \`${spec.neutral}\` → call \`${target}\` with \`{ "roleId": "<roleId>" }\``;
}

function assertOperationalToolMappings(
  surface: (typeof PROMPT_SURFACES)[number],
  content: string,
): void {
  const sectionTail = content.split(OPERATIONAL_TOOL_SECTION_HEADING)[1];
  expect(sectionTail).toBeDefined();
  const section = sectionTail!.split("\n## ")[0]!;
  const mappedTargets = [...section.matchAll(/→ (?:`|call `)([A-Za-z0-9_]+)/g)].map(
    (match) => match[1]!,
  );

  expect(mappedTargets).toHaveLength(OPERATIONAL_TOOL_SPECS.length);
  for (const surfaceTarget of mappedTargets) {
    if (surface === "claude") {
      expect(surfaceTarget).toStartWith(CLAUDE_LEDGER_TOOL_PREFIX);
    } else {
      expect(surfaceTarget).not.toStartWith(CLAUDE_LEDGER_TOOL_PREFIX);
    }
    const baseToolName = surfaceTarget.replace(CLAUDE_LEDGER_TOOL_PREFIX, "");
    expect(LEDGER_TOOL_NAMES).toContain(baseToolName);
  }
  for (const spec of OPERATIONAL_TOOL_SPECS) {
    expect(section).toContain(expectedOperationalToolMapping(surface, spec));
  }
}

function assertFollowUpPlannerResumeWorkflow(
  followUp: string,
  advance: string,
): void {
  const claim = followUp.indexOf('claim_plan(purpose: "follow-up")');
  const descriptionMutation = followUp.indexOf(
    "Append each scope to the existing description",
  );
  const ideaMutation = followUp.indexOf("For each idea, preserve refs while adding");

  expect(claim).toBeGreaterThanOrEqual(0);
  expect(descriptionMutation).toBeGreaterThan(claim);
  expect(ideaMutation).toBeGreaterThan(claim);
  expect(followUp).toMatch(
    /Any rejected claim result exits\s+before appending scope or mutating the goal or ideas/,
  );
  expect(followUp).toMatch(
    /enter `CQ::plan\/advance` at\s+\*\*§2\. Resolve planners and dispatch\*\*/,
  );
  expect(followUp).toMatch(
    /Do not run its §1 pre-claim gate or request a\s+second `purpose: "initial"` claim/,
  );
  expect(advance).toMatch(
    /When `CQ::plan\/follow-up` transfers an acknowledged active follow-up claim/,
  );
  expect(advance).toMatch(
    /resume at \*\*§2\. Resolve\s+planners and dispatch\*\* with that claim/,
  );
  expect(followUp).toMatch(
    /For an unmanaged goal, move `planned` or `building` through `planning` to\s+`clarifying`/,
  );
  expect(followUp).toMatch(
    /For an unmanaged goal now in `clarifying`, run\s+`CQ::plan\/advance <goalId>` inline/,
  );
}

describe("orchestrator command prompt sources", () => {
  test("derives every operational mapping target from the registered ledger tool surface", () => {
    for (const spec of OPERATIONAL_TOOL_SPECS) {
      expect(LEDGER_TOOL_NAMES).toContain(spec.candidate);
      expect(registeredToolName(spec.candidate)).toBe(spec.candidate);
    }
  });

  test("keeps the shared ledger response fragment byte-identical without difference metadata", () => {
    const fragmentContracts =
      evaluateNixValue<readonly FragmentContract[]>("fragmentContracts");
    const sharedContract = fragmentContracts.find(
      ({ fragment }) => fragment === LEDGER_RESPONSE_CONTRACT_FRAGMENT,
    );
    expect(sharedContract).toBeDefined();
    expect(sharedContract).not.toHaveProperty("intentionalDifference");

    const catalog = JSON.parse(evaluateNixJson("catalogJson")) as readonly CatalogRole[];
    const sharedBindings = catalog.flatMap((role) =>
      role.fragmentBindings.filter(
        ({ fragment }) => fragment === LEDGER_RESPONSE_CONTRACT_FRAGMENT,
      ),
    );
    expect(sharedBindings).toHaveLength(LEDGER_RESPONSE_CONTRACT_ROLES.size);
    for (const binding of sharedBindings) {
      expect(binding).not.toHaveProperty("intentionalDifference");
    }

    const fragmentSources = JSON.parse(
      evaluateNixJson("promptFragmentSourcesJson"),
    ) as readonly FragmentSource[];
    const renderedBytes = PROMPT_SURFACES.map((surface) => {
      const entries = fragmentSources.filter(
        (entry) =>
          entry.surface === surface &&
          entry.fragment === LEDGER_RESPONSE_CONTRACT_FRAGMENT,
      );
      expect(entries).toHaveLength(LEDGER_RESPONSE_CONTRACT_ROLES.size);
      const surfaceBytes = new Set(
        entries.map((entry) =>
          readFileSync(path.join(ASSETS_ROOT, entry.source)).toString("hex"),
        ),
      );
      expect(surfaceBytes.size).toBe(1);
      return [...surfaceBytes][0]!;
    });
    expect(new Set(renderedBytes).size).toBe(1);
  });

  test("renders cq:begin from the canonical source and explicit typed fragments", () => {
    const catalog = JSON.parse(evaluateNixJson("catalogJson")) as readonly CatalogRole[];
    const fragmentSources = JSON.parse(
      evaluateNixJson("promptFragmentSourcesJson"),
    ) as readonly FragmentSource[];
    const begin = catalog.find(({ roleId }) => roleId === "begin");
    expect(begin).toBeDefined();

    const sourcePaths: PromptCatalogFileInput[] = [
      {
        canonicalSource: begin!.canonicalSource,
        path: path.join(ASSETS_ROOT, begin!.canonicalSource),
      },
    ];

    for (const surface of PROMPT_SURFACES) {
      const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
        .filter((entry) => entry.surface === surface && entry.roleId === "begin")
        .map((entry) => ({
          roleId: entry.roleId,
          fragment: entry.fragment,
          path: path.join(ASSETS_ROOT, entry.source),
        }));
      const tree = renderPromptSurfaceTree({
        surface,
        catalogJson: JSON.stringify([begin]),
        sourcePaths,
        fragmentPaths,
        roleVersions: {},
      });

      const manifest = JSON.parse(tree.artifacts[1]!.content) as {
        readonly surface: string;
        readonly roles: readonly { readonly roleId: string; readonly version: number | null }[];
      };
      expect(manifest.surface).toBe(surface);
      expect(manifest.roles).toHaveLength(1);
      expect(manifest.roles[0]!.roleId).toBe("begin");
      expect(manifest.roles[0]!.version).toBeNull();
      expect(tree.artifacts[2]!.path).toBe("roles/begin.md");
      expect(tree.artifacts[2]!.content).toStartWith("---\n");
      expect(tree.artifacts[2]!.content).toContain("$ARGUMENTS");
      expect(tree.artifacts[2]!.content).not.toContain("{{cq:fragment:");
      expect(tree.artifacts[2]!.content).not.toContain("CQ_HARNESS");
      expect(fragmentPaths).toHaveLength(begin!.fragmentBindings.length);
      expect(readFileSync(sourcePaths[0]!.path, "utf8")).toContain(
        "{{cq:fragment:inline-command-recursion}}",
      );
    }
  });

  test("renders the complete command roster with frontmatter and dispatch closure", () => {
    const catalogJson = evaluateNixJson("orchestratorCatalogJson");
    const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
    const fragmentSources = JSON.parse(
      evaluateNixJson("promptFragmentSourcesJson"),
    ) as readonly FragmentSource[];
    const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
      canonicalSource: role.canonicalSource,
      path: path.join(ASSETS_ROOT, role.canonicalSource),
    }));
    const roleIds = new Set(catalog.map(({ roleId }) => roleId));
    const commandFragmentSources = fragmentSources.filter(({ roleId }) => roleIds.has(roleId));

    expect(catalog.some(({ roleId }) => roleId === "begin")).toBe(true);
    expect(commandFragmentSources).toHaveLength(
      catalog.reduce((count, role) => count + role.fragmentBindings.length, 0) *
        PROMPT_SURFACES.length,
    );

    for (const role of catalog) {
      const source = readFileSync(path.join(ASSETS_ROOT, role.canonicalSource), "utf8");
      expect(source).toStartWith("---\n");
      for (const { fragment } of role.fragmentBindings) {
        expect(source.match(new RegExp(`\\{\\{cq:fragment:${fragment}\\}\\}`, "g"))).toHaveLength(
          1,
        );
      }
      for (const relation of role.dispatchRelations) {
        expect(source).toContain(relation.targetRoleId);
      }
    }

    for (const surface of PROMPT_SURFACES) {
      const fragmentPaths: PromptFragmentFileInput[] = commandFragmentSources
        .filter((entry) => entry.surface === surface)
        .map((entry) => ({
          roleId: entry.roleId,
          fragment: entry.fragment,
          path: path.join(ASSETS_ROOT, entry.source),
        }));
      const input = { surface, catalogJson, sourcePaths, fragmentPaths, roleVersions: {} };
      const first = renderPromptSurfaceTree(input);
      const second = renderPromptSurfaceTree(input);

      expect(second).toEqual(first);
      expect(first.artifacts).toHaveLength(catalog.length + 2);
      for (const [index, role] of catalog.entries()) {
        const content = first.artifacts[index + 2]!.content;
        const source = readFileSync(path.join(ASSETS_ROOT, role.canonicalSource), "utf8");
        const description = source.split("\n").find((line) => line.startsWith("description:"));
        expect(first.artifacts[index + 2]!.path).toBe(`roles/${role.roleId}.md`);
        expect(content).toStartWith("---\n");
        expect(content).toContain("\n---\n");
        expect(content).toContain(description!);
        expect(content).not.toContain("{{cq:fragment:");
        expect(content).not.toContain("CQ_HARNESS");
        const usesNeutralOperationalToken = OPERATIONAL_TOOL_SPECS.some((spec) =>
          source.includes(spec.source),
        );
        expect(
          role.fragmentBindings.some(({ fragment }) => fragment === "operational-tool-vocabulary"),
        ).toBe(usesNeutralOperationalToken);
        if (usesNeutralOperationalToken) {
          assertOperationalToolMappings(surface, content);
        }
        if (role.fragmentBindings.some(({ fragment }) => fragment === "host-tool-vocabulary")) {
          if (surface === "claude") {
            expect(content).toMatch(/^allowed-tools:/m);
          } else {
            expect(content).not.toMatch(/^allowed-tools:/m);
          }
        }
        const hasLedgerResponseContract = role.fragmentBindings.some(
          ({ fragment }) => fragment === LEDGER_RESPONSE_CONTRACT_FRAGMENT,
        );
        expect(hasLedgerResponseContract).toBe(LEDGER_RESPONSE_CONTRACT_ROLES.has(role.roleId));
        if (hasLedgerResponseContract) {
          expect(content).toContain(LEDGER_RESPONSE_CONTRACT);
        }
        for (const relation of role.dispatchRelations) {
          expect(content).toContain(relation.targetRoleId);
        }
      }

      const followUpIndex = catalog.findIndex(({ roleId }) => roleId === "plan/follow-up");
      const advanceIndex = catalog.findIndex(({ roleId }) => roleId === "plan/advance");
      expect(followUpIndex).toBeGreaterThanOrEqual(0);
      expect(advanceIndex).toBeGreaterThanOrEqual(0);
      assertFollowUpPlannerResumeWorkflow(
        first.artifacts[followUpIndex + 2]!.content,
        first.artifacts[advanceIndex + 2]!.content,
      );
    }
  });

  test("rejects missing and unconsumed fragments against the real command roster", () => {
    const catalogJson = evaluateNixJson("orchestratorCatalogJson");
    const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
    const fragmentSources = JSON.parse(
      evaluateNixJson("promptFragmentSourcesJson"),
    ) as readonly FragmentSource[];
    const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
      canonicalSource: role.canonicalSource,
      path: path.join(ASSETS_ROOT, role.canonicalSource),
    }));
    const roleIds = new Set(catalog.map(({ roleId }) => roleId));
    const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
      .filter((entry) => entry.surface === "codex" && roleIds.has(entry.roleId))
      .map((entry) => ({
        roleId: entry.roleId,
        fragment: entry.fragment,
        path: path.join(ASSETS_ROOT, entry.source),
      }));
    const missing = fragmentPaths.slice(1);
    expect(() =>
      renderPromptSurfaceTree({
        surface: "codex",
        catalogJson,
        sourcePaths,
        fragmentPaths: missing,
        roleVersions: {},
      }),
    ).toThrow('fragments.begin.cq-command-invocation: missing slot input for surface "codex"');

    const root = mkdtempSync(path.join(tmpdir(), "cq-command-source-"));
    try {
      const begin = catalog.find(({ roleId }) => roleId === "begin");
      expect(begin).toBeDefined();
      const copiedSource = path.join(root, "begin.md");
      writeFileSync(
        copiedSource,
        readFileSync(path.join(ASSETS_ROOT, begin!.canonicalSource), "utf8").replace(
          "{{cq:fragment:inline-command-recursion}}\n",
          "",
        ),
      );
      const copiedPaths = sourcePaths.map((entry) =>
        entry.canonicalSource === begin!.canonicalSource ? { ...entry, path: copiedSource } : entry,
      );
      expect(() =>
        renderPromptSurfaceTree({
          surface: "codex",
          catalogJson,
          sourcePaths: copiedPaths,
          fragmentPaths,
          roleVersions: {},
        }),
      ).toThrow("fragments.begin.inline-command-recursion: unconsumed slot input");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
