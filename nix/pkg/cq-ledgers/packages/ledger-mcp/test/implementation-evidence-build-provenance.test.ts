import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryLedgerStore,
  createInMemoryImplementationEvidenceStore,
  type DispatchCapability,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import {
  implementationEvidenceBuildCommit,
  resolveImplementationEvidenceBuildCommit,
} from "../src/buildProvenance.js";
import { createProductionImplementationEvidenceService } from "../src/implementationEvidenceRuntime.js";

const BUILD_COMMIT = "a".repeat(40);

async function git(root: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function commit(root: string, name: string, contents: string): Promise<string> {
  await writeFile(path.join(root, name), contents);
  await git(root, ["add", name]);
  await git(root, ["commit", "-q", "-m", name]);
  return await git(root, ["rev-parse", "HEAD"]);
}

interface ConstructedService {
  readonly deps: {
    readonly startupBuildCommit?: string;
    readonly repositoryHead: () => Promise<string>;
  };
}

async function constructSourceWorkspaceService(
  repositoryRoot: string,
): Promise<ConstructedService> {
  const store = new InMemoryLedgerStore();
  await store.init();
  const resolved = {
    store,
    implementationEvidenceStore: createInMemoryImplementationEvidenceStore(),
  } as unknown as ResolvedLedgerStore;
  const dispatchCapability = {
    observeEvidence: async () => ({ state: "missing" as const }),
  } as unknown as DispatchCapability;
  return createProductionImplementationEvidenceService({
    resolved,
    dispatchCapability,
    repositoryRoot,
    environment: { CQ_HARNESS: "codex" },
    trustedSourceWorkspaceBuildCommit: BUILD_COMMIT,
  }) as unknown as ConstructedService;
}

// regression: defects:D430 — one immutable cq output must not derive build identity from live HEAD.
test("D430 keeps startup build identity immutable across repository HEAD movement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cq-build-provenance-regression-"));
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "provenance-test"]);
    await git(root, ["config", "user.email", "provenance-test@example.invalid"]);
    const firstHead = await commit(root, "first.txt", "first\n");
    const firstService = await constructSourceWorkspaceService(root);
    const secondHead = await commit(root, "second.txt", "second\n");
    const secondService = await constructSourceWorkspaceService(root);

    expect(firstHead).not.toBe(secondHead);
    expect(firstService.deps.startupBuildCommit).toBe(BUILD_COMMIT);
    expect(secondService.deps.startupBuildCommit).toBe(BUILD_COMMIT);
    expect(await firstService.deps.repositoryHead()).toBe(secondHead);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one constructed service retains its startup identity while repositoryHead remains live", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cq-build-provenance-control-"));
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "provenance-test"]);
    await git(root, ["config", "user.email", "provenance-test@example.invalid"]);
    const firstHead = await commit(root, "first.txt", "first\n");
    const service = await constructSourceWorkspaceService(root);
    expect(await service.deps.repositoryHead()).toBe(firstHead);
    const secondHead = await commit(root, "second.txt", "second\n");

    expect(service.deps.startupBuildCommit).toBe(BUILD_COMMIT);
    expect(await service.deps.repositoryHead()).toBe(secondHead);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts valid packaged and trusted source-workspace build provenance", () => {
  expect(resolveImplementationEvidenceBuildCommit(BUILD_COMMIT, undefined)).toBe(BUILD_COMMIT);
  expect(resolveImplementationEvidenceBuildCommit(undefined, BUILD_COMMIT)).toBe(BUILD_COMMIT);
});

test("rejects missing build provenance", () => {
  expect(() => resolveImplementationEvidenceBuildCommit(undefined, undefined)).toThrow(
    "provenance is unavailable",
  );
  expect(() => implementationEvidenceBuildCommit(undefined)).toThrow(
    "packaged implementation-evidence build provenance is unavailable",
  );
});

test("rejects dirty build provenance", () => {
  expect(() =>
    resolveImplementationEvidenceBuildCommit(`${BUILD_COMMIT}-dirty`, undefined),
  ).toThrow("provenance is dirty");
});

test("rejects malformed build provenance", () => {
  expect(() => resolveImplementationEvidenceBuildCommit("not-a-commit", undefined)).toThrow(
    "provenance is malformed",
  );
});

test("rejects substituted packaged build provenance", () => {
  const otherCommit = "b".repeat(40);
  expect(() => resolveImplementationEvidenceBuildCommit(BUILD_COMMIT, otherCommit)).toThrow(
    "cannot substitute packaged provenance",
  );
});

test("all shipped constructors consume packaged provenance without a live-HEAD injection", async () => {
  const sources = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../../ledger-tui/src/mcpClient.ts", import.meta.url), "utf8"),
    readFile(new URL("../../ledger-web/src/serve.ts", import.meta.url), "utf8"),
    readFile(new URL("../../cq-cli/src/implementationEvidenceStatus.ts", import.meta.url), "utf8"),
  ]);
  for (const source of sources) {
    expect(source).toContain("createProductionImplementationEvidenceService({");
    expect(source).not.toContain("trustedSourceWorkspaceBuildCommit");
  }
});

test("the cq derivation requires clean self.rev and runs the installed provenance probe", async () => {
  const flake = await readFile(new URL("../../../../../../flake.nix", import.meta.url), "utf8");
  expect(flake).toContain("self ? rev");
  expect(flake).toContain('builtins.match "^[0-9a-f]{40}$" self.rev');
  expect(flake).toContain("!(self ? dirtyRev)");
  expect(flake).toContain('export const PACKAGED_BUILD_COMMIT = "${sourceRevision}" as const;');
  expect(flake).toContain("probe-implementation-evidence-build-provenance.ts");
  expect(flake).toContain("doInstallCheck = true;");
});
