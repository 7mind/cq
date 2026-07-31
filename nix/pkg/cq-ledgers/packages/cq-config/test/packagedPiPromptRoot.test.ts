import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  DISPATCHED_ROLE_VERSIONS,
  DISPATCH_RESULT_PLUMBING_TOOL_NAMES,
  LEDGER_CAPABILITY_TOOL_NAMES,
  PI_ROLE_TOOL_PROFILE_MANIFEST_PATH,
  excludedLedgerToolsForRole,
  exposedLedgerToolsForRole,
  serializePiRoleToolProfileManifest,
} from "@cq/config";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "@cq/config/prompt-renderer";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const PI_CONTEXT = path.join(REPO_ROOT, "nix", "pkg", "llm-contexts", "pi-context.md");
const tempDirectories: string[] = [];
const originalScript = process.argv[1] ?? "";
const originalAgentsDir = process.env.CQ_AGENTS_DIR;

interface CatalogRole {
  readonly roleId: string;
  readonly roleKind: "orchestrator-command" | "dispatched-subagent";
  readonly canonicalSource: string;
  readonly sidecar: { readonly schemaRoleId: string } | null;
}

interface FragmentSource {
  readonly surface: "claude" | "codex" | "pi";
  readonly roleId: string;
  readonly fragment: string;
  readonly source: string;
}

interface RegisteredTool {
  readonly name: string;
  readonly execute: (
    toolCallId: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: Readonly<Record<string, unknown>>,
  ) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: Readonly<Record<string, unknown>>;
  }>;
}

async function loadDispatchExtension(): Promise<(api: Readonly<Record<string, unknown>>) => void> {
  mock.module("typebox", () => {
    const identity = <T>(value: T): T => value;
    return {
      Type: {
        Literal: identity,
        Object: identity,
        Optional: identity,
        String: identity,
      },
    };
  });
  const extensionPath = path.join(
    REPO_ROOT,
    "nix",
    "pkg",
    "pi-extensions",
    "cq-subagent-dispatch.ts",
  );
  const extension = (await import(extensionPath)) as {
    readonly default: (api: Readonly<Record<string, unknown>>) => void;
  };
  return extension.default;
}

function run(command: readonly string[]): string {
  const result = Bun.spawnSync([...command], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trimEnd();
}

function evaluateRaw(attribute: string): string {
  return run(["nix", "eval", "--raw", `.#llmAssets.${attribute}`]);
}

function buildPiPromptRoot(): string {
  return run(["nix", "build", "--no-link", "--print-out-paths", ".#pi-prompt-root"]);
}

function directPiTree(catalogJson: string): ReturnType<typeof renderPromptSurfaceTree> {
  const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
  const fragments = JSON.parse(
    evaluateRaw("promptFragmentSourcesJson"),
  ) as readonly FragmentSource[];
  const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
    canonicalSource: role.canonicalSource,
    path: path.join(ASSETS_ROOT, role.canonicalSource),
  }));
  const fragmentPaths: PromptFragmentFileInput[] = fragments
    .filter(({ surface }) => surface === "pi")
    .map(({ roleId, fragment, source }) => ({
      roleId,
      fragment,
      path: path.join(ASSETS_ROOT, source),
    }));
  return renderPromptSurfaceTree({
    surface: "pi",
    catalogJson,
    sourcePaths,
    fragmentPaths,
    roleVersions: DISPATCHED_ROLE_VERSIONS,
    roleToolProfilesJson: serializePiRoleToolProfileManifest(),
  });
}

afterEach(() => {
  process.argv[1] = originalScript;
  if (originalAgentsDir === undefined) {
    delete process.env.CQ_AGENTS_DIR;
  } else {
    process.env.CQ_AGENTS_DIR = originalAgentsDir;
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged Pi prompt root", () => {
  test("projects the direct Nix catalog into the exact 24-role Pi runtime tree", () => {
    const output = buildPiPromptRoot();
    const catalogJson = evaluateRaw("catalogJson");
    const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
    const direct = directPiTree(catalogJson);

    expect(catalog).toHaveLength(24);
    expect(readdirSync(output).sort()).toEqual([
      "catalog.json",
      PI_ROLE_TOOL_PROFILE_MANIFEST_PATH,
      "roles",
      "surface.json",
    ]);
    expect(readFileSync(path.join(output, "catalog.json"), "utf8")).toBe(catalogJson);
    const manifest = JSON.parse(readFileSync(path.join(output, "surface.json"), "utf8")) as {
      readonly surface: string;
      readonly roles: readonly { readonly version: number | null }[];
    };
    expect(manifest.surface).toBe("pi");
    expect(manifest.roles).toHaveLength(catalog.length);
    const profiles = JSON.parse(
      readFileSync(path.join(output, PI_ROLE_TOOL_PROFILE_MANIFEST_PATH), "utf8"),
    ) as {
      readonly ledgerToolNames: readonly string[];
      readonly roles: Readonly<
        Record<
          string,
          {
            readonly roleTools: readonly string[];
            readonly transportTools: readonly string[];
            readonly excludedTools: readonly string[];
          }
        >
      >;
    };
    expect(profiles.ledgerToolNames).toEqual(LEDGER_CAPABILITY_TOOL_NAMES);
    expect(profiles.roles["implement-worker"]?.roleTools).toEqual([]);
    expect(profiles.roles["plan-advance"]?.roleTools).toEqual([
      "fetch_item",
      "fts_search",
      "list_milestone_items",
    ]);
    expect(profiles.roles["plan-reviewer"]?.roleTools).toEqual([
      "fetch_item",
      "create_item",
      "fts_search",
      "list_milestone_items",
    ]);
    expect(profiles.roles["plan-advance"]?.transportTools).toEqual(
      DISPATCH_RESULT_PLUMBING_TOOL_NAMES,
    );
    expect(
      [...new Bun.Glob("**/*.md").scanSync({ cwd: path.join(output, "roles") })].sort(),
    ).toEqual(catalog.map(({ roleId }) => `${roleId}.md`).sort());
    for (const artifact of direct.artifacts.slice(1)) {
      expect(readFileSync(path.join(output, artifact.path), "utf8")).toBe(artifact.content);
    }

    const roles = new Map(
      catalog.map((role) => [
        role.roleId,
        readFileSync(path.join(output, "roles", `${role.roleId}.md`), "utf8"),
      ]),
    );
    expect(roles.get("begin")).toContain('fetch_prompt("<path>")');
    expect(roles.get("begin")).toContain("CQ::advance");
    expect(roles.get("plan/advance")).toContain(
      'dispatch_agent(agent: "<role>", task: "<complete prompt>")',
    );
    for (const call of [
      "derive_predicates({})",
      'get_config({"section":"<section>"})',
      'call `fetch_prompt` with `{ "roleId": "<roleId>" }`',
    ]) {
      expect(roles.get("advance")).toContain(call);
    }
    expect(roles.get("begin")).toContain("$ARGUMENTS");
    expect(roles.get("begin")).not.toContain("You are the **top-level flow sequencer**.");

    const rendered = [...roles.values()].join("\n");
    expect(rendered).not.toContain("$CLAUDE_CODE_SESSION_ID");
    expect(rendered).not.toContain("{{cq:fragment:");
    expect(rendered).not.toContain("CQ_HARNESS");
    expect(rendered).not.toContain("$cq-");
    expect(rendered).not.toContain("mcp__ledger__");
    expect(rendered).not.toContain("Agent(");

    const dispatched = catalog.filter(({ roleKind }) => roleKind === "dispatched-subagent");
    expect(dispatched).toHaveLength(9);
    expect(dispatched.every(({ roleId, sidecar }) => sidecar?.schemaRoleId === roleId)).toBe(true);
    expect(
      catalog
        .filter(({ roleKind }) => roleKind === "orchestrator-command")
        .every(({ sidecar }) => sidecar === null),
    ).toBe(true);
  }, 30_000);

  test("has an exact renderer source closure and excludes nested prompt bodies", () => {
    buildPiPromptRoot();
    const derivationShow = JSON.parse(run(["nix", "derivation", "show", ".#pi-prompt-root"])) as {
      readonly derivations: Readonly<
        Record<string, { readonly inputs: { readonly srcs: readonly string[] } }>
      >;
    };
    const inputSources = (Object.values(derivationShow.derivations)[0]?.inputs.srcs ?? []).map(
      (source) => (path.isAbsolute(source) ? source : path.join("/nix/store", source)),
    );
    const rendererSource = inputSources.find((source) =>
      existsSync(path.join(source, "scripts", "render-prompt-surface.ts")),
    );
    expect(rendererSource).toBeDefined();
    expect(
      [...new Bun.Glob("**/*").scanSync({ cwd: rendererSource!, onlyFiles: true })].sort(),
    ).toEqual([
      "scripts/render-prompt-surface.ts",
      "src/promptCatalog.gen.ts",
      "src/promptCatalog.ts",
      "src/promptRenderer.ts",
      "src/roleToolProfiles.ts",
      // The schema sidecars stamp the per-role contract versions into the
      // attested surface manifest (T683).
      "src/schemas/implement-conflict-resolver.ts",
      "src/schemas/implement-reviewer.ts",
      "src/schemas/implement-worker.ts",
      "src/schemas/investigate-evidence.ts",
      "src/schemas/investigate-explorer.ts",
      "src/schemas/investigate-prober.ts",
      "src/schemas/plan-advance.ts",
      "src/schemas/plan-reviewer.ts",
      "src/schemas/research-experimenter.ts",
      "src/schemas/research-explorer.ts",
    ]);
    const context = readFileSync(PI_CONTEXT, "utf8");
    expect(context).toContain('fetch_prompt("investigate/advance")');
    expect(context).toContain("Substitute any text following the invocation for `$ARGUMENTS`");
    expect(context).not.toContain("You are the **top-level flow sequencer**.");
  }, 30_000);

  // Regression origin: tasks:T1329 acceptance (2026-07-31).
  test("dispatches rendered roles with exact Pi deny lists and no child re-dispatch", async () => {
    const output = buildPiPromptRoot();
    const directory = path.join(tmpdir(), `cq-pi-runtime-${process.pid}-${crypto.randomUUID()}`);
    tempDirectories.push(directory);
    mkdirSync(directory, { recursive: true });
    const capturePath = path.join(directory, "child-args.json");
    const childScript = path.join(directory, "child.ts");
    writeFileSync(
      childScript,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        'const promptIndex = args.indexOf("--append-system-prompt");',
        'const prompt = readFileSync(args[promptIndex + 1], "utf8");',
        'const excludedIndex = args.indexOf("--exclude-tools");',
        'const excluded = new Set(args[excludedIndex + 1].split(","));',
        `const toolList = ${JSON.stringify(LEDGER_CAPABILITY_TOOL_NAMES)}.filter((name) => !excluded.has(name));`,
        `writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args, prompt, initialize: { capabilities: { tools: {} } }, toolsList: toolList }));`,
        'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", content: [{ type: "text", text: "runtime-child-ok" }] } }));',
      ].join("\n"),
    );

    process.argv[1] = childScript;
    process.env.CQ_AGENTS_DIR = path.join(output, "roles");
    let registered: RegisteredTool | undefined;
    const cqSubagentDispatch = await loadDispatchExtension();
    cqSubagentDispatch({
      registerTool(tool: RegisteredTool) {
        registered = tool;
      },
    } as never);

    expect(registered?.name).toBe("dispatch_agent");
    const expectedBuiltInExclusions: Readonly<Record<string, readonly string[]>> = {
      "plan-advance": ["dispatch_agent", "write", "edit", "bash"],
      "plan-reviewer": ["dispatch_agent", "write", "edit", "bash"],
      "implement-worker": ["dispatch_agent"],
      "implement-reviewer": ["dispatch_agent", "write", "edit"],
      "implement-conflict-resolver": ["dispatch_agent"],
      "investigate-explorer": ["dispatch_agent", "write", "edit", "bash"],
      "investigate-prober": ["dispatch_agent"],
      "research-explorer": ["dispatch_agent", "write", "edit", "bash"],
      "research-experimenter": ["dispatch_agent"],
    };

    for (const [agent, builtInExclusions] of Object.entries(expectedBuiltInExclusions)) {
      const exclusions = [...builtInExclusions, ...excludedLedgerToolsForRole(agent)];
      const task = `runtime argument for ${agent}`;
      const result = await registered!.execute(
        `call-${agent}`,
        { agent, task, isolation: "worktree" },
        undefined,
        undefined,
        {
          cwd: REPO_ROOT,
          model: { id: "gpt-5.6-sol", provider: "openai-codex" },
        },
      );
      const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
        readonly args: readonly string[];
        readonly prompt: string;
        readonly initialize: {
          readonly capabilities: { readonly tools: Readonly<Record<string, never>> };
        };
        readonly toolsList: readonly string[];
      };
      const excludeIndex = capture.args.indexOf("--exclude-tools");

      expect(result.content[0]?.text).toBe("runtime-child-ok");
      expect(result.details.isolation).toBe("worktree");
      expect(capture.args.at(-1)).toBe(task);
      expect(excludeIndex).toBeGreaterThan(-1);
      expect(capture.args[excludeIndex + 1]?.split(",")).toEqual(exclusions);
      expect(capture.initialize).toEqual({ capabilities: { tools: {} } });
      expect(capture.toolsList).toEqual(exposedLedgerToolsForRole(agent));
      expect(result.details.roleTools).toEqual(
        exposedLedgerToolsForRole(agent).filter(
          (tool) => !DISPATCH_RESULT_PLUMBING_TOOL_NAMES.includes(tool as never),
        ),
      );
      expect(result.details.transportTools).toEqual(DISPATCH_RESULT_PLUMBING_TOOL_NAMES);
      expect(capture.prompt).not.toContain("{{cq:fragment:");
      expect(capture.prompt).not.toContain("dispatch_agent(");
    }

    const invalidRoot = path.join(directory, "invalid-profile-root");
    const invalidRoles = path.join(invalidRoot, "roles");
    mkdirSync(invalidRoles, { recursive: true });
    writeFileSync(
      path.join(invalidRoles, "implement-worker.md"),
      readFileSync(path.join(output, "roles", "implement-worker.md"), "utf8"),
    );
    const invalidManifest = JSON.parse(
      readFileSync(path.join(output, PI_ROLE_TOOL_PROFILE_MANIFEST_PATH), "utf8"),
    ) as {
      roles: Record<
        string,
        {
          roleTools: string[];
          transportTools: string[];
          excludedTools: string[];
        }
      >;
    };
    invalidManifest.roles["implement-worker"]!.excludedTools = invalidManifest.roles[
      "implement-worker"
    ]!.excludedTools.filter((tool) => tool !== "enumerate_ledgers");
    writeFileSync(
      path.join(invalidRoot, PI_ROLE_TOOL_PROFILE_MANIFEST_PATH),
      JSON.stringify(invalidManifest),
    );
    process.env.CQ_AGENTS_DIR = invalidRoles;
    expect(
      registered!.execute(
        "call-missing-decision",
        { agent: "implement-worker", task: "must fail before prompt construction" },
        undefined,
        undefined,
        {
          cwd: REPO_ROOT,
          model: { id: "gpt-5.6-sol", provider: "openai-codex" },
        },
      ),
    ).rejects.toThrow('tool "enumerate_ledgers" lacks a profile decision');
  }, 30_000);
});
