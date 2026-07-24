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

const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly catalog: Array<Record<string, unknown>>;
  readonly catalogJson: string;
  readonly sourcePaths: PromptCatalogFileInput[];
  readonly fragmentPaths: PromptFragmentFileInput[];
}

function fragmentBinding(fragment: (typeof SLOTS)[number]): Record<string, unknown> {
  return {
    fragment,
    sourceBlock: `${fragment} block`,
    supportedSurfaces: ["claude", "codex", "pi"],
    forbiddenVocabulary: {
      claude: [],
      codex: [],
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

  test("uses only the direct catalog JSON and explicit source and fragment paths", () => {
    const fixture = makeFixture();
    const rendererSource = readFileSync(
      path.resolve(import.meta.dir, "../src/promptRenderer.ts"),
      "utf8",
    );

    expect(rendererSource).not.toContain("promptCatalog.gen");
    expect(rendererSource).not.toContain("PROMPT_CATALOG_PROJECTION");
    expect(rendererSource).not.toContain("prompt-surfaces");
    expect(render(fixture).artifacts).toHaveLength(3);
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
