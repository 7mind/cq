import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "@cq/config/prompt-renderer";

const SLOTS = [
  "cq-command-invocation",
  "subagent-dispatch",
  "inline-command-recursion",
  "host-tool-vocabulary",
] as const;

const PROMPT_SURFACES = ["claude", "codex", "pi"] as const;
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const CONFIG_PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly catalog: Array<Record<string, unknown>>;
  readonly catalogJson: string;
  readonly sourcePaths: PromptCatalogFileInput[];
  readonly fragmentPaths: PromptFragmentFileInput[];
}

interface NixCatalogFragmentBinding {
  readonly fragment: string;
  readonly forbiddenVocabulary: Readonly<
    Record<(typeof PROMPT_SURFACES)[number], readonly string[]>
  >;
}

interface NixCatalogRole {
  readonly roleId: string;
  readonly canonicalSource: string;
  readonly fragmentBindings: readonly NixCatalogFragmentBinding[];
}

interface NixFixture {
  readonly root: string;
  readonly surface: (typeof PROMPT_SURFACES)[number];
  readonly catalog: readonly NixCatalogRole[];
  readonly catalogJson: string;
  readonly sourcePaths: readonly PromptCatalogFileInput[];
  readonly fragmentPaths: readonly PromptFragmentFileInput[];
}

function fragmentBinding(fragment: (typeof SLOTS)[number]): Record<string, unknown> {
  return {
    fragment,
    sourceBlock: `${fragment} block`,
    supportedSurfaces: ["claude", "codex", "pi"],
    forbiddenVocabulary: {
      claude: [],
      codex: fragment === "subagent-dispatch" ? ["Agent(", "dispatch_agent("] : [],
      pi: [],
    },
    intentionalDifference: {
      kind: "tool-vocabulary",
      reason: `${fragment} differs by host`,
      surfaces: ["claude", "codex", "pi"],
    },
  };
}

function role(
  roleId: string,
  canonicalSource: string,
  fragments: readonly (typeof SLOTS)[number][],
): Record<string, unknown> {
  return {
    roleId,
    roleKind: "orchestrator-command",
    canonicalSource,
    name: `/cq:${roleId.replaceAll("/", ":")}`,
    surfaces: ["claude", "codex", "pi"],
    sharedSourceBlock: {
      sourceBlock: "shared prose",
      classification: "shared-prose",
      targetFragment: null,
    },
    fragmentBindings: fragments.map(fragmentBinding),
    sidecar: null,
    dispatchRelations: [],
    intentionalDifferences: [],
  };
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "cq-prompt-renderer-"));
  roots.push(root);
  const catalog = [
    role("first", "commands/cq/first.md", SLOTS),
    role("nested/second", "commands/cq/nested/second.md", ["host-tool-vocabulary"]),
  ];
  const sourcePaths: PromptCatalogFileInput[] = [];
  const fragmentPaths: PromptFragmentFileInput[] = [];

  for (const entry of catalog) {
    const roleId = entry.roleId as string;
    const canonicalSource = entry.canonicalSource as string;
    const sourcePath = path.join(root, canonicalSource);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(
      sourcePath,
      roleId === "first"
        ? [
            "---",
            "description: fixture command",
            'argument-hint: "<goalId>"',
            "---",
            "",
            "Shared prose preserves $ARGUMENTS, {{runtime_value}}, and <taskId>.",
            ...SLOTS.map((slot) => `{{cq:fragment:${slot}}}`),
            "",
          ].join("\n")
        : [
            "---",
            "description: second fixture",
            "---",
            "",
            "Second shared block.",
            "{{cq:fragment:host-tool-vocabulary}}",
            "",
          ].join("\n"),
    );
    sourcePaths.push({ canonicalSource, path: sourcePath });

    for (const binding of entry.fragmentBindings as Array<Record<string, unknown>>) {
      const fragment = binding.fragment as string;
      const fragmentPath = path.join(
        root,
        "fragments",
        "codex",
        roleId,
        `${fragment}.md`,
      );
      mkdirSync(path.dirname(fragmentPath), { recursive: true });
      writeFileSync(fragmentPath, `codex ${roleId} ${fragment}`);
      fragmentPaths.push({ roleId, fragment, path: fragmentPath });
    }
  }

  return {
    root,
    catalog,
    catalogJson: JSON.stringify(catalog),
    sourcePaths,
    fragmentPaths,
  };
}

function evaluateNixCatalogJson(): string {
  const result = Bun.spawnSync(
    ["nix", "eval", "--raw", ".#llmAssets.catalogJson"],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout);
}

function makeNixFixture(surface: (typeof PROMPT_SURFACES)[number]): NixFixture {
  const root = mkdtempSync(path.join(tmpdir(), `cq-prompt-renderer-nix-${surface}-`));
  roots.push(root);
  const catalogJson = evaluateNixCatalogJson();
  const catalog = JSON.parse(catalogJson) as readonly NixCatalogRole[];
  const sourcePaths: PromptCatalogFileInput[] = [];
  const fragmentPaths: PromptFragmentFileInput[] = [];

  for (const role of catalog) {
    const sourcePath = path.join(root, "sources", role.canonicalSource);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(
      sourcePath,
      [
        "---",
        `description: rendered ${role.roleId}`,
        "---",
        "",
        `Shared ${role.roleId} prose preserves $ARGUMENTS and {{runtime_value}}.`,
        ...role.fragmentBindings.map(
          ({ fragment }) => `{{cq:fragment:${fragment}}}`,
        ),
        "",
      ].join("\n"),
    );
    sourcePaths.push({ canonicalSource: role.canonicalSource, path: sourcePath });

    for (const { fragment } of role.fragmentBindings) {
      const fragmentPath = path.join(
        root,
        "fragments",
        surface,
        role.roleId,
        `${fragment}.md`,
      );
      mkdirSync(path.dirname(fragmentPath), { recursive: true });
      writeFileSync(
        fragmentPath,
        `${surface} ${fragment} adapter for ${role.roleId}; preserve <taskId>`,
      );
      fragmentPaths.push({ roleId: role.roleId, fragment, path: fragmentPath });
    }
  }
  return { root, surface, catalog, catalogJson, sourcePaths, fragmentPaths };
}

function renderNixFixture(fixture: NixFixture) {
  return renderPromptSurfaceTree({
    surface: fixture.surface,
    catalogJson: fixture.catalogJson,
    sourcePaths: fixture.sourcePaths,
    fragmentPaths: fixture.fragmentPaths,
  });
}

function render(fixture: Fixture) {
  return renderPromptSurfaceTree({
    surface: "codex",
    catalogJson: fixture.catalogJson,
    sourcePaths: fixture.sourcePaths,
    fragmentPaths: fixture.fragmentPaths,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("deterministic prompt renderer core", () => {
  test("renders shared prose and every typed fragment in catalog order", () => {
    const fixture = makeFixture();
    const tree = render(fixture);

    expect(tree.surface).toBe("codex");
    expect(tree.artifacts.map((artifact) => artifact.path)).toEqual([
      "catalog.json",
      "roles/first.md",
      "roles/nested/second.md",
    ]);
    expect(tree.artifacts[0]!.content).toBe(fixture.catalogJson);

    const first = tree.artifacts[1]!.content;
    expect(first).toStartWith(
      [
        "---",
        "description: fixture command",
        'argument-hint: "<goalId>"',
        "---",
      ].join("\n"),
    );
    expect(first).toContain("Shared prose preserves $ARGUMENTS, {{runtime_value}}, and <taskId>.");
    for (const slot of SLOTS) {
      expect(first).toContain(`codex first ${slot}`);
    }
    expect(first).not.toContain("{{cq:fragment:");
  });

  test("produces byte-identical in-memory artifacts on repeated renders", () => {
    const fixture = makeFixture();
    expect(render(fixture)).toEqual(render(fixture));
  });

  for (const surface of PROMPT_SURFACES) {
    test(`renders direct Nix catalog JSON through explicit absolute ${surface} inputs`, () => {
      const fixture = makeNixFixture(surface);
      const tree = renderNixFixture(fixture);

      expect(fixture.sourcePaths.every((input) => path.isAbsolute(input.path))).toBe(true);
      expect(fixture.fragmentPaths.every((input) => path.isAbsolute(input.path))).toBe(true);
      expect(tree.surface).toBe(surface);
      expect(tree.artifacts).toHaveLength(fixture.catalog.length + 1);
      expect(tree.artifacts[0]).toEqual({
        path: "catalog.json",
        content: fixture.catalogJson,
      });
      expect(tree.artifacts[1]!.content).toContain("$ARGUMENTS");
      expect(tree.artifacts[1]!.content).toContain("{{runtime_value}}");
      expect(tree.artifacts.every((artifact) => !artifact.content.includes("{{cq:fragment:"))).toBe(
        true,
      );
    });
  }

  test("builds and executes the isolated prompt-renderer package export", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cq-prompt-renderer-isolated-"));
    roots.push(root);
    const packageRoot = path.join(root, "node_modules", "@cq", "config");
    const packageSource = path.join(packageRoot, "src");
    mkdirSync(packageSource, { recursive: true });
    for (const relativePath of [
      "package.json",
      "src/promptCatalog.ts",
      "src/promptRenderer.ts",
    ]) {
      const destination = path.join(packageRoot, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        readFileSync(path.join(CONFIG_PACKAGE_ROOT, relativePath), "utf8"),
      );
    }

    const sourcePath = path.join(root, "inputs", "source.md");
    const fragmentPath = path.join(root, "inputs", "fragment.md");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(
      sourcePath,
      "---\ndescription: isolated\n---\nShared $ARGUMENTS.\n{{cq:fragment:host-tool-vocabulary}}\n",
    );
    writeFileSync(fragmentPath, "isolated codex adapter");
    const catalogJson = JSON.stringify([
      role("isolated", "commands/cq/isolated.md", ["host-tool-vocabulary"]),
    ]);
    const entryPath = path.join(root, "entry.ts");
    const bundlePath = path.join(root, "bundle.mjs");
    writeFileSync(
      entryPath,
      [
        'import { renderPromptSurfaceTree } from "@cq/config/prompt-renderer";',
        `const tree = renderPromptSurfaceTree(${JSON.stringify({
          surface: "codex",
          catalogJson,
          sourcePaths: [
            { canonicalSource: "commands/cq/isolated.md", path: sourcePath },
          ],
          fragmentPaths: [
            {
              roleId: "isolated",
              fragment: "host-tool-vocabulary",
              path: fragmentPath,
            },
          ],
        })});`,
        "process.stdout.write(JSON.stringify(tree));",
      ].join("\n"),
    );

    const build = Bun.spawnSync(
      ["bun", "build", entryPath, "--target=bun", "--outfile", bundlePath],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(new TextDecoder().decode(build.stderr)).toBe("");
    expect(build.exitCode).toBe(0);
    rmSync(path.join(root, "node_modules"), { recursive: true, force: true });

    const executed = Bun.spawnSync(["bun", bundlePath], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(executed.stderr)).toBe("");
    expect(executed.exitCode).toBe(0);
    const tree = JSON.parse(new TextDecoder().decode(executed.stdout)) as {
      readonly artifacts: readonly { readonly path: string; readonly content: string }[];
    };
    expect(tree.artifacts).toEqual([
      { path: "catalog.json", content: catalogJson },
      {
        path: "roles/isolated.md",
        content:
          "---\ndescription: isolated\n---\nShared $ARGUMENTS.\nisolated codex adapter\n",
      },
    ]);
  });
});

describe("prompt renderer boundary failures", () => {
  test("rejects a missing fragment input", () => {
    const fixture = makeFixture();
    fixture.fragmentPaths.splice(0, 1);
    expect(() => render(fixture)).toThrow(
      'fragments.first.cq-command-invocation: missing slot input for surface "codex"',
    );
  });

  test("rejects a duplicate source slot", () => {
    const fixture = makeFixture();
    const sourcePath = fixture.sourcePaths[0]!.path;
    writeFileSync(
      sourcePath,
      `${readFileSync(sourcePath, "utf8")}{{cq:fragment:cq-command-invocation}}\n`,
    );
    expect(() => render(fixture)).toThrow(
      'sources.first.cq-command-invocation: duplicate slot marker',
    );
  });

  test("rejects an unknown source slot", () => {
    const fixture = makeFixture();
    const sourcePath = fixture.sourcePaths[0]!.path;
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, "utf8").replace(
        "{{cq:fragment:cq-command-invocation}}",
        "{{cq:fragment:terminal-command}}",
      ),
    );
    expect(() => render(fixture)).toThrow(
      'sources.first.terminal-command: unknown slot marker',
    );
  });

  test("rejects an unconsumed declared slot input", () => {
    const fixture = makeFixture();
    const sourcePath = fixture.sourcePaths[0]!.path;
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, "utf8").replace(
        "{{cq:fragment:cq-command-invocation}}\n",
        "",
      ),
    );
    expect(() => render(fixture)).toThrow(
      'fragments.first.cq-command-invocation: unconsumed slot input',
    );
  });

  test("rejects unsupported surfaces", () => {
    const fixture = makeFixture();
    expect(() =>
      renderPromptSurfaceTree({
        surface: "terminal",
        catalogJson: fixture.catalogJson,
        sourcePaths: fixture.sourcePaths,
        fragmentPaths: fixture.fragmentPaths,
      }),
    ).toThrow('surface: unsupported prompt surface "terminal"');

    const catalog = structuredClone(fixture.catalog);
    catalog[0]!.surfaces = ["claude", "pi"];
    expect(() =>
      renderPromptSurfaceTree({
        surface: "codex",
        catalogJson: JSON.stringify(catalog),
        sourcePaths: fixture.sourcePaths,
        fragmentPaths: fixture.fragmentPaths,
      }),
    ).toThrow('catalog[0].surfaces: surface "codex" is unsupported for role "first"');
  });

  test("rejects canonical sources and fragments containing harness branches", () => {
    const fixture = makeFixture();
    writeFileSync(
      fixture.sourcePaths[0]!.path,
      `${readFileSync(fixture.sourcePaths[0]!.path, "utf8")}\nCQ_HARNESS=codex\n`,
    );
    expect(() => render(fixture)).toThrow(
      "sources.first: forbidden harness branch CQ_HARNESS",
    );

    const second = makeFixture();
    writeFileSync(second.fragmentPaths[0]!.path, "if CQ_HARNESS then branch");
    expect(() => render(second)).toThrow(
      "fragments.first.cq-command-invocation: forbidden harness branch CQ_HARNESS",
    );
  });

  test("rejects catalog-declared forbidden vocabulary in a fragment", () => {
    const fixture = makeFixture();
    const input = fixture.fragmentPaths.find(
      ({ roleId, fragment }) => roleId === "first" && fragment === "subagent-dispatch",
    );
    expect(input).toBeDefined();
    writeFileSync(input!.path, "Agent(subagent_type: renderer-escape)");

    expect(() => render(fixture)).toThrow(
      'fragments.first.subagent-dispatch: forbidden vocabulary "Agent(" for surface "codex"',
    );
  });

  test("rejects catalog-declared forbidden vocabulary in final shared output", () => {
    const fixture = makeFixture();
    const sourcePath = fixture.sourcePaths[0]!.path;
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, "utf8").replace(
        "Shared prose",
        "Shared Agent( prose",
      ),
    );

    expect(() => render(fixture)).toThrow(
      'rendered.first: forbidden vocabulary "Agent(" for surface "codex"',
    );
  });

  for (const surface of PROMPT_SURFACES) {
    test(`rejects a ${surface} harness token declared by the direct Nix catalog`, () => {
      const fixture = makeNixFixture(surface);
      const roleWithToken = fixture.catalog.find((role) =>
        role.fragmentBindings.some(
          (binding) => binding.forbiddenVocabulary[surface].length > 0,
        ),
      );
      if (roleWithToken === undefined) {
        throw new Error(`Nix catalog declares no forbidden ${surface} vocabulary`);
      }
      const bindingWithToken = roleWithToken.fragmentBindings.find(
        (binding) => binding.forbiddenVocabulary[surface].length > 0,
      );
      if (bindingWithToken === undefined) {
        throw new Error(`Nix catalog role has no forbidden ${surface} vocabulary`);
      }
      const token = bindingWithToken.forbiddenVocabulary[surface][0];
      if (token === undefined) {
        throw new Error(`Nix catalog role has an empty forbidden ${surface} token list`);
      }
      const input = fixture.fragmentPaths.find(
        ({ roleId, fragment }) =>
          roleId === roleWithToken.roleId && fragment === bindingWithToken.fragment,
      );
      if (input === undefined) {
        throw new Error(`fixture omitted ${roleWithToken.roleId}:${bindingWithToken.fragment}`);
      }
      writeFileSync(input.path, `adapter prefix ${token} adapter suffix`);

      expect(() => renderNixFixture(fixture)).toThrow(
        `fragments.${roleWithToken.roleId}.${bindingWithToken.fragment}: forbidden vocabulary "${token}" for surface "${surface}"`,
      );
    });

    test(`rejects a ${surface} harness token in direct Nix-catalog final output deterministically`, () => {
      const fixture = makeNixFixture(surface);
      const roleWithToken = fixture.catalog.find((role) =>
        role.fragmentBindings.some(
          (binding) => binding.forbiddenVocabulary[surface].length > 0,
        ),
      );
      if (roleWithToken === undefined) {
        throw new Error(`Nix catalog declares no forbidden ${surface} vocabulary`);
      }
      const bindingWithToken = roleWithToken.fragmentBindings.find(
        (binding) => binding.forbiddenVocabulary[surface].length > 0,
      );
      if (bindingWithToken === undefined) {
        throw new Error(`Nix catalog role has no forbidden ${surface} vocabulary`);
      }
      const token = bindingWithToken.forbiddenVocabulary[surface][0];
      if (token === undefined) {
        throw new Error(`Nix catalog role has an empty forbidden ${surface} token list`);
      }
      const sourceInput = fixture.sourcePaths.find(
        ({ canonicalSource }) => canonicalSource === roleWithToken.canonicalSource,
      );
      if (sourceInput === undefined) {
        throw new Error(`fixture omitted ${roleWithToken.canonicalSource}`);
      }
      writeFileSync(
        sourceInput.path,
        readFileSync(sourceInput.path, "utf8").replace(
          "Shared ",
          `Shared ${token} `,
        ),
      );
      const expected =
        `rendered.${roleWithToken.roleId}: forbidden vocabulary ` +
        `"${token}" for surface "${surface}"`;

      expect(() => renderNixFixture(fixture)).toThrow(expected);
      expect(() => renderNixFixture(fixture)).toThrow(expected);
    });
  }

  test("rejects undeclared source and fragment inputs", () => {
    const fixture = makeFixture();
    const sourcePath = path.join(fixture.root, "extra.md");
    writeFileSync(sourcePath, "extra");
    fixture.sourcePaths.push({ canonicalSource: "commands/cq/extra.md", path: sourcePath });
    expect(() => render(fixture)).toThrow(
      'sourcePaths[2]: undeclared canonical source "commands/cq/extra.md"',
    );

    const second = makeFixture();
    const fragmentPath = path.join(second.root, "extra-fragment.md");
    writeFileSync(fragmentPath, "extra");
    second.fragmentPaths.push({
      roleId: "first",
      fragment: "terminal-command",
      path: fragmentPath,
    });
    expect(() => render(second)).toThrow(
      'fragmentPaths[5]: undeclared fragment input "first:terminal-command"',
    );
  });
});
