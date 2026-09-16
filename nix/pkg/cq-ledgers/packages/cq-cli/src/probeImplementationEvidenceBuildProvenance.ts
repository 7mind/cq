import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryLedgerStore,
  createInMemoryImplementationEvidenceStore,
  type DispatchCapability,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import { createStandaloneImplementationEvidenceService } from "@cq/ledger-mcp";
import { createEmbeddedTuiImplementationEvidenceService } from "@cq/ledger-tui";
import { createEmbeddedWebImplementationEvidenceService } from "@cq/ledger-web";
import { createEmbeddedStatusImplementationEvidenceService } from "./implementationEvidenceStatus.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const expectedBuildCommit = process.argv[2];
if (expectedBuildCommit === undefined || !FULL_SHA.test(expectedBuildCommit)) {
  throw new Error("installed provenance probe requires the expected clean full source revision");
}
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

async function commit(root: string, name: string): Promise<string> {
  await writeFile(path.join(root, name), `${name}\n`);
  await git(root, ["add", name]);
  await git(root, ["commit", "-q", "-m", name]);
  return await git(root, ["rev-parse", "HEAD"]);
}

const constructors = [
  ["standalone-mcp", createStandaloneImplementationEvidenceService],
  ["embedded-tui", createEmbeddedTuiImplementationEvidenceService],
  ["embedded-web", createEmbeddedWebImplementationEvidenceService],
  ["embedded-status", createEmbeddedStatusImplementationEvidenceService],
] as const;

const root = await mkdtemp(path.join(tmpdir(), "cq-installed-build-provenance-"));
try {
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "installed-provenance-probe"]);
  await git(root, ["config", "user.email", "installed-provenance-probe@example.invalid"]);
  const firstHead = await commit(root, "first.txt");
  const store = new InMemoryLedgerStore();
  await store.init();
  const resolved = {
    store,
    implementationEvidenceStore: createInMemoryImplementationEvidenceStore(),
  } as unknown as ResolvedLedgerStore;
  const dispatchCapability = {
    observeEvidence: async () => ({ state: "missing" as const }),
  } as unknown as DispatchCapability;
  const serviceOptions = {
    resolved,
    dispatchCapability,
    repositoryRoot: root,
    environment: { CQ_HARNESS: "codex" },
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
        resultCommit: expectedBuildCommit,
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
  const services = constructors.map(
    ([name, construct]) =>
      [
        name,
        construct(serviceOptions),
      ] as const,
  );

  for (const [name, service] of services) {
    const status = await service.evidenceServiceStatus();
    if (status.startupBuildCommit !== expectedBuildCommit) {
      throw new Error(`${name} did not report the immutable packaged build identity`);
    }
    if (status.repositoryHead !== firstHead) {
      throw new Error(`${name} did not report the initial live repository HEAD`);
    }
  }

  const secondHead = await commit(root, "second.txt");
  if (secondHead === firstHead) throw new Error("installed provenance probe did not advance HEAD");
  for (const [name, service] of services) {
    const status = await service.evidenceServiceStatus();
    if (status.startupBuildCommit !== expectedBuildCommit) {
      throw new Error(`${name} changed its packaged build identity after repository movement`);
    }
    if (status.repositoryHead !== secondHead) {
      throw new Error(`${name} did not report the advanced live repository HEAD`);
    }
  }

  let substituted = false;
  try {
    createStandaloneImplementationEvidenceService({
      resolved,
      dispatchCapability,
      repositoryRoot: root,
      environment: { CQ_HARNESS: "codex" },
      trustedSourceWorkspaceBuildCommit: "b".repeat(40),
      readBootstrapAuthority: serviceOptions.readBootstrapAuthority,
    });
  } catch (error) {
    substituted = error instanceof Error && error.message.includes("cannot substitute");
  }
  if (!substituted) throw new Error("installed service accepted substituted build provenance");

  process.stdout.write(
    `${JSON.stringify({
      startupBuildCommit: expectedBuildCommit,
      firstRepositoryHead: firstHead,
      secondRepositoryHead: secondHead,
      constructors: constructors.map(([name]) => name),
    })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
