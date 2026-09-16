import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const RETAINED_CQ_OUTPUT =
  "/nix/store/h0b861ap8lg30p7jl0a0wra86vnjjpfz-cq-0.0.1";

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
  readonly deps: { readonly startupBuildCommit?: string };
}

async function constructRetainedService(repositoryRoot: string): Promise<ConstructedService> {
  const workspace = path.join(RETAINED_CQ_OUTPUT, "share/cq/packages");
  const runtime = await import(
    pathToFileURL(path.join(workspace, "ledger-mcp/src/implementationEvidenceRuntime.ts")).href
  );
  const ledger = await import(pathToFileURL(path.join(workspace, "ledger/src/index.ts")).href);
  const store = new ledger.InMemoryLedgerStore();
  await store.init();
  const service = runtime.createProductionImplementationEvidenceService({
    resolved: {
      store,
      implementationEvidenceStore: ledger.createInMemoryImplementationEvidenceStore(),
    },
    dispatchCapability: { observeEvidence: async () => ({ state: "missing" }) },
    repositoryRoot,
    environment: { CQ_HARNESS: "codex" },
  });
  return service as ConstructedService;
}

// regression: defects:D430 — one immutable cq output must not derive build identity from live HEAD.
test("D430 keeps startup build identity immutable across repository HEAD movement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cq-build-provenance-regression-"));
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "provenance-test"]);
    await git(root, ["config", "user.email", "provenance-test@example.invalid"]);
    const firstHead = await commit(root, "first.txt", "first\n");
    const firstService = await constructRetainedService(root);
    const secondHead = await commit(root, "second.txt", "second\n");
    const secondService = await constructRetainedService(root);

    expect(firstHead).not.toBe(secondHead);
    expect(firstService.deps.startupBuildCommit).toBe(secondService.deps.startupBuildCommit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one constructed service retains its startup identity after repository HEAD movement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cq-build-provenance-control-"));
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "provenance-test"]);
    await git(root, ["config", "user.email", "provenance-test@example.invalid"]);
    await commit(root, "first.txt", "first\n");
    const service = await constructRetainedService(root);
    const startupBuildCommit = service.deps.startupBuildCommit;
    await commit(root, "second.txt", "second\n");

    expect(service.deps.startupBuildCommit).toBe(startupBuildCommit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
