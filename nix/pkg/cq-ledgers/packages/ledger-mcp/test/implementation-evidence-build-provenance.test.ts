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

async function sourceWorkspaceServiceOptions(
  repositoryRoot: string,
) {
  const store = new InMemoryLedgerStore();
  await store.init();
  const resolved = {
    store,
    implementationEvidenceStore: createInMemoryImplementationEvidenceStore(),
  } as unknown as ResolvedLedgerStore;
  const dispatchCapability = {
    observeEvidence: async () => ({ state: "missing" as const }),
  } as unknown as DispatchCapability;
  return {
    resolved,
    dispatchCapability,
    repositoryRoot,
    environment: { CQ_HARNESS: "codex" },
    trustedSourceWorkspaceBuildCommit: BUILD_COMMIT,
    readBootstrapAuthority: async () => ({
      goalRef: "goals:G176",
      finalizedManifestDigest: "f".repeat(64),
      mappings: {
        evidenceTaskRef: "tasks:T3000",
        historicalTaskRef: "tasks:T3001",
        activationTaskRef: "tasks:T3002",
      },
      evidenceTask: {
        taskRef: "tasks:T3000",
        status: "done",
        resultCommit: BUILD_COMMIT,
        ready: false,
      },
      historicalTask: {
        taskRef: "tasks:T3001",
        status: "planned",
        resultCommit: null,
        ready: true,
      },
      activationTask: {
        taskRef: "tasks:T3002",
        status: "planned",
        resultCommit: null,
        ready: false,
        actionKey: "activate-implementation-evidence",
      },
    }),
  } as const;
}

async function constructSourceWorkspaceService(
  repositoryRoot: string,
): Promise<ConstructedService> {
  return createProductionImplementationEvidenceService(
    await sourceWorkspaceServiceOptions(repositoryRoot),
  ) as unknown as ConstructedService;
}

type ShippedFactory = typeof createProductionImplementationEvidenceService;

function exportedFactory(module: unknown, name: string): ShippedFactory {
  const factory = (module as Record<string, unknown>)[name];
  expect(typeof factory).toBe("function");
  return factory as ShippedFactory;
}

async function shippedFactories(): Promise<ReadonlyArray<readonly [string, ShippedFactory]>> {
  const importModule = async (specifier: string): Promise<unknown> => await import(specifier);
  const [standalone, tui, web, status] = await Promise.all([
    importModule("../src/main.js"),
    importModule("../../ledger-tui/src/mcpClient.js"),
    importModule("../../ledger-web/src/serve.js"),
    importModule("../../cq-cli/src/implementationEvidenceStatus.js"),
  ]);
  return [
    [
      "standalone-mcp",
      exportedFactory(standalone, "createStandaloneImplementationEvidenceService"),
    ],
    ["embedded-tui", exportedFactory(tui, "createEmbeddedTuiImplementationEvidenceService")],
    ["embedded-web", exportedFactory(web, "createEmbeddedWebImplementationEvidenceService")],
    [
      "embedded-status",
      exportedFactory(status, "createEmbeddedStatusImplementationEvidenceService"),
    ],
  ];
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

test("all shipped constructors expose immutable provenance through public protected status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cq-shipped-provenance-control-"));
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "provenance-test"]);
    await git(root, ["config", "user.email", "provenance-test@example.invalid"]);
    const firstHead = await commit(root, "first.txt", "first\n");
    const options = await sourceWorkspaceServiceOptions(root);
    const services = (await shippedFactories()).map(
      ([name, factory]) => [name, factory(options)] as const,
    );

    for (const [name, service] of services) {
      const status = await service.evidenceServiceStatus();
      expect(status.startupBuildCommit, name).toBe(BUILD_COMMIT);
      expect(status.repositoryHead, name).toBe(firstHead);
    }

    const secondHead = await commit(root, "second.txt", "second\n");
    expect(secondHead).not.toBe(firstHead);
    for (const [name, service] of services) {
      const status = await service.evidenceServiceStatus();
      expect(status.startupBuildCommit, name).toBe(BUILD_COMMIT);
      expect(status.repositoryHead, name).toBe(secondHead);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the cq derivation requires clean self.rev and runs the installed provenance probe", async () => {
  const flake = await readFile(new URL("../../../../../../flake.nix", import.meta.url), "utf8");
  expect(flake).toContain("self ? rev");
  expect(flake).toContain('builtins.match "^[0-9a-f]{40}$" self.rev');
  expect(flake).toContain("!(self ? dirtyRev)");
  expect(flake).toContain('export const PACKAGED_BUILD_COMMIT = "${sourceRevision}" as const;');
  expect(flake).toContain("probeImplementationEvidenceBuildProvenance.ts");
  expect(flake).toContain("doInstallCheck = true;");
});
