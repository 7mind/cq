import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  EXPECTED_FAILURE_INVENTORY,
  ExpectedFailurePolicyError,
  enumerateExpectedFailureSourceFiles,
  readExpectedFailureSources,
  scanExpectedFailures,
  type ExpectedFailureInventoryEntry,
  type ExpectedFailureSource,
} from "../src/index.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const WORKSPACE_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-ledgers");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const IMPLEMENT_ADVANCE = "commands/cq/implement/advance.md";
const CLAUDE_POINTER =
  "Tasks that declare an expected failure follow §6a of\n  `nix/pkg/cq-assets/commands/cq/implement/advance.md`; the production scanner\n  and committed inventory enforce its marker convention.";
const SUCCESS_SECTION_SHA256 = "ef2071b70d0102c33e1d81ea02990fb5d54c3623704160df837639b488528ca3";
const SINGLETON_SENTENCES = [
  "§6a governs only a task that declares an expected failure.",
  "Form (a), inversion marker: use the runner's test.failing or it.failing for an in-suite assertion.",
  "Form (b), subprocess exit-code assertion: spawn the failing tool as a child and assert its non-zero exit code and output.",
  "Form (c), green-on-arrival discriminating control: exercise the same detector with paired inputs or a pure mutation while the task's gate stays green.",
] as const;
const ROLE_BLOCKS = {
  "agents/implement-worker.md":
    "**Expected-failure tasks.** A task that declares an expected failure follows\n   §6a of the implementation orchestrator. Forms (a) and (b) carry the required\n   annotation, live marker, and inventory entry; form (c) needs no marker. A fix\n   replaces the marker with a same-titled plain test and removes its annotation\n   and inventory entry. Never use a red full gate as expected-failure evidence.",
  "agents/implement-reviewer.md":
    "For a task that declares an expected failure, apply §6a of the implementation\norchestrator. Forms (a) and (b) require the annotation, live marker, and\ninventory entry; form (c) needs no marker. A completed fix replaces the marker\nwith a same-titled plain test and removes the annotation and inventory entry.\nReject co-deletion of that triple when no same-titled plain test remains, and\nnever approve a red full gate.",
  "commands/cq/implement-review.md":
    "For a task that declares an expected failure, apply §6a of the implementation\norchestrator. Forms (a) and (b) require the annotation, live marker, and\ninventory entry; form (c) needs no marker. A completed fix replaces the marker\nwith a same-titled plain test and removes the annotation and inventory entry.\nReject co-deletion of that triple when no same-titled plain test remains, and\nnever approve a red full gate.",
  "commands/cq/plan-review.md":
    "When a task declares an expected failure, require §6a of the implementation\norchestrator. Forms (a) and (b) use the annotation, live marker, and inventory\nentry; form (c) needs no marker. The planned fix must replace a marker with a\nsame-titled plain test and remove the annotation and inventory entry. Reject a\nplan that permits triple co-deletion without that plain test or requires a red\nfull gate.",
  "agents/plan-advance.md":
    "When a task declares an expected failure, follow §6a of the implementation\norchestrator. Forms (a) and (b) use the annotation, live marker, and inventory\nentry; form (c) needs no marker. Plan the fix to replace a marker with a\nsame-titled plain test and remove the annotation and inventory entry. Never\nplan triple co-deletion without that plain test or require a red full gate.",
} as const;
const CONCRETE_PROVENANCE = /\b(?:D|G|H|I|K|M|Q|R|RS|T)\d+(?:[-/][A-Za-z0-9]+)*\b/;
const roots: string[] = [];

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function promptSources(): Record<string, string> {
  return Object.fromEntries(
    [IMPLEMENT_ADVANCE, ...Object.keys(ROLE_BLOCKS)].map((relativePath) => [
      relativePath,
      readFileSync(path.join(ASSETS_ROOT, relativePath), "utf8"),
    ]),
  );
}

function assertPromptPolicy(sources: Readonly<Record<string, string>>): void {
  expect(Object.keys(sources).sort()).toEqual(
    [IMPLEMENT_ADVANCE, ...Object.keys(ROLE_BLOCKS)].sort(),
  );
  const advance = sources[IMPLEMENT_ADVANCE]!;
  const successStart = advance.indexOf("## 6. Success authority");
  const policyStart = advance.indexOf("## 6a. Expected-failure tasks");
  const mergeStart = advance.indexOf("## 7. Merge in DAG order");
  expect(successStart).toBeGreaterThanOrEqual(0);
  expect(policyStart).toBeGreaterThan(successStart);
  expect(mergeStart).toBeGreaterThan(policyStart);
  expect(sha256(advance.slice(successStart, policyStart))).toBe(SUCCESS_SECTION_SHA256);
  const policy = advance.slice(policyStart, mergeStart);
  for (const sentence of SINGLETON_SENTENCES) expect(occurrences(advance, sentence)).toBe(1);
  expect(policy).toContain("Forms (a) and (b) express the expected failure inside a green full gate.");
  expect(policy).toContain("Form\n(c) carries no marker.");
  expect(policy).toContain("A red full gate remains unmergeable.");
  expect(policy).toContain("may supplement, but never replace, these controls");

  for (const [relativePath, block] of Object.entries(ROLE_BLOCKS)) {
    const roleSource = sources[relativePath]!;
    expect(occurrences(roleSource, block)).toBe(1);
    const blockStart = roleSource.indexOf(block);
    expect(roleSource.slice(blockStart, blockStart + block.length)).not.toMatch(
      CONCRETE_PROVENANCE,
    );
  }
}

function assertClaudeConvention(source: string): void {
  expect(occurrences(source, CLAUDE_POINTER)).toBe(1);
}

function source(file: string, body: string): ExpectedFailureSource {
  return { file, source: body };
}

function inventory(file: string, title: string, ledgerRef = "tasks:T1"): ExpectedFailureInventoryEntry {
  return { file, title, ledgerRef };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("the canonical policy and all five role blocks remain bounded and provenance-free", () => {
  assertPromptPolicy(promptSources());
  assertClaudeConvention(readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8"));
});

test("the bounded prompt detector rejects mutations to every canonical block", () => {
  const original = promptSources();
  for (const relativePath of Object.keys(ROLE_BLOCKS)) {
    const block = ROLE_BLOCKS[relativePath as keyof typeof ROLE_BLOCKS];
    expect(() =>
      assertPromptPolicy({
        ...original,
        [relativePath]: original[relativePath]!.replace(
          block,
          block.replace("\n", "\nT999\n"),
        ),
      }),
    ).toThrow();
    expect(() =>
      assertPromptPolicy({
        ...original,
        [relativePath]: original[relativePath]!.replace(block, ""),
      }),
    ).toThrow();
  }
  expect(() =>
    assertPromptPolicy({
      ...original,
      [IMPLEMENT_ADVANCE]: original[IMPLEMENT_ADVANCE]!.replace(
        "A task may merge only when all of these hold:",
        "A task may merge when these usually hold:",
      ),
    }),
  ).toThrow();
  expect(() => assertClaudeConvention("# ledger-suite\n")).toThrow();
});

test("the deterministic enumerator includes package source trees and excludes forbidden trees and symlink directories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cq-expected-failure-enumerator-"));
  roots.push(root);
  for (const relativePath of [
    "packages/a/src/a.ts",
    "packages/a/src/catalogue.gen.ts",
    "packages/a/test/a.test.tsx",
    "packages/a/scripts/tool.ts",
    "packages/a/dist/hidden.ts",
    "packages/a/node_modules/hidden.ts",
    "packages/a/docs/hidden.ts",
  ]) {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, "export {};\n");
  }
  symlinkSync(path.join(root, "packages", "a", "src"), path.join(root, "packages", "a", "test", "linked"));
  expect(enumerateExpectedFailureSourceFiles(root).map((file) => path.relative(root, file))).toEqual([
    "packages/a/scripts/tool.ts",
    "packages/a/src/a.ts",
    "packages/a/src/catalogue.gen.ts",
    "packages/a/test/a.test.tsx",
  ]);
});

test("the syntax-aware scanner ignores comments and literals and accepts both supported calls", () => {
  const file = "packages/example/test/example.test.ts";
  const sources = [
    source(
      file,
      [
        "// test.failing('comment', () => {});",
        "const quoted = \"it.failing('string', () => {})\";",
        "const template = `test.failing('template', () => {})`;",
        "// expected-failure: tasks:T1",
        "test.failing('alpha', () => {});",
        "// expected-failure: tasks:T2",
        "it.failing(\"beta\", () => {});",
      ].join("\n"),
    ),
  ];
  expect(scanExpectedFailures(sources, [inventory(file, "alpha"), inventory(file, "beta", "tasks:T2")])).toEqual([
    { file, title: "alpha", ledgerRef: "tasks:T1", line: 5 },
    { file, title: "beta", ledgerRef: "tasks:T2", line: 7 },
  ]);
});

test("the scanner reports unsupported live syntax with file and line", () => {
  const file = "packages/example/test/example.test.ts";
  for (const body of [
    "// expected-failure: tasks:T1\ntest.failing(title, () => {});",
    "// expected-failure: tasks:T1\ntest['failing']('alpha', () => {});",
    "// expected-failure: tasks:T1\ntest.failing(`alpha`, () => {});",
  ]) {
    try {
      scanExpectedFailures([source(file, body)], [inventory(file, "alpha")]);
      throw new Error("expected policy failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ExpectedFailurePolicyError);
      expect(String(error)).toContain(`${file}:2:`);
    }
  }
});

test("the scanner rejects orphan annotations and both marker/inventory mismatch directions", () => {
  const file = "packages/example/test/example.test.ts";
  expect(() =>
    scanExpectedFailures([source(file, "// expected-failure: tasks:T1\nconst value = 1;\n")], []),
  ).toThrow("orphan expected-failure annotation");
  expect(() =>
    scanExpectedFailures(
      [source(file, "// expected-failure: tasks:T1\ntest.failing('alpha', () => {});\n")],
      [],
    ),
  ).toThrow("lacks an inventory entry");
  expect(() => scanExpectedFailures([], [inventory(file, "alpha")])).toThrow(
    "inventory entry has no live marker",
  );
  expect(() =>
    scanExpectedFailures(
      [source(file, "// expected-failure: tasks:T2\ntest.failing('alpha', () => {});\n")],
      [inventory(file, "alpha")],
    ),
  ).toThrow("annotation and inventory ledger references differ");
});

test("the scanner rejects duplicate live markers sharing one inventory entry", () => {
  const file = "packages/example/test/example.test.ts";
  const duplicateMarkers = [
    "// expected-failure: tasks:T1",
    "test.failing('alpha', () => {});",
    "// expected-failure: tasks:T1",
    "test.failing('alpha', () => {});",
  ].join("\n");
  expect(() =>
    scanExpectedFailures([source(file, duplicateMarkers)], [inventory(file, "alpha")]),
  ).toThrow("duplicate live expected-failure marker");
});

test("the scanner rejects a computed expected-failure title", () => {
  const file = "packages/example/test/example.test.ts";
  const computedTitle = [
    "const suffix = '-computed';",
    "// expected-failure: tasks:T1",
    "test.failing('alpha' + suffix, () => {});",
  ].join("\n");
  expect(() =>
    scanExpectedFailures([source(file, computedTitle)], [inventory(file, "alpha")]),
  ).toThrow(`${file}:3: expected-failure title must be solely a quoted string literal`);
});

test("the committed inventory agrees bidirectionally with exactly ten live markers", () => {
  const sources = readExpectedFailureSources(WORKSPACE_ROOT, REPO_ROOT);
  const markers = scanExpectedFailures(sources, EXPECTED_FAILURE_INVENTORY);
  expect(markers).toHaveLength(10);
  expect(markers.map(({ ledgerRef }) => ledgerRef)).toEqual([
    ...Array(4).fill("defects:D342"),
    ...Array(6).fill("tasks:T826"),
  ]);
});
