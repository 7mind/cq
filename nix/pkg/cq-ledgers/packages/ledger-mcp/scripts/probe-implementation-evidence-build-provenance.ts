import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryLedgerStore,
  createInMemoryImplementationEvidenceStore,
  type DispatchCapability,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import { implementationEvidenceBuildCommit } from "../src/buildProvenance.js";
import { createProductionImplementationEvidenceService } from "../src/implementationEvidenceRuntime.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const expectedBuildCommit = process.argv[2];
if (expectedBuildCommit === undefined || !FULL_SHA.test(expectedBuildCommit)) {
  throw new Error("installed provenance probe requires the expected clean full source revision");
}
if (implementationEvidenceBuildCommit(undefined) !== expectedBuildCommit) {
  throw new Error("installed provenance module does not match the derivation source revision");
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

interface ObservableService {
  readonly deps: {
    readonly startupBuildCommit?: string;
    readonly repositoryHead: () => Promise<string>;
  };
}

const constructors = [
  ["standalone-mcp", new URL("../src/main.ts", import.meta.url)],
  ["embedded-tui", new URL("../../ledger-tui/src/mcpClient.ts", import.meta.url)],
  ["embedded-web", new URL("../../ledger-web/src/serve.ts", import.meta.url)],
  ["embedded-status", new URL("../../cq-cli/src/implementationEvidenceStatus.ts", import.meta.url)],
] as const;

for (const [name, sourceUrl] of constructors) {
  const source = await readFile(sourceUrl, "utf8");
  if (!source.includes("createProductionImplementationEvidenceService({")) {
    throw new Error(`${name} does not construct the protected implementation-evidence service`);
  }
  if (source.includes("trustedSourceWorkspaceBuildCommit")) {
    throw new Error(`${name} substitutes source-workspace provenance in a shipped constructor`);
  }
}

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
  const services = constructors.map(
    ([name]) =>
      [
        name,
        createProductionImplementationEvidenceService({
          resolved,
          dispatchCapability,
          repositoryRoot: root,
          environment: { CQ_HARNESS: "codex" },
        }) as unknown as ObservableService,
      ] as const,
  );

  for (const [name, service] of services) {
    if (service.deps.startupBuildCommit !== expectedBuildCommit) {
      throw new Error(`${name} did not report the immutable packaged build identity`);
    }
    if ((await service.deps.repositoryHead()) !== firstHead) {
      throw new Error(`${name} did not report the initial live repository HEAD`);
    }
  }

  const secondHead = await commit(root, "second.txt");
  if (secondHead === firstHead) throw new Error("installed provenance probe did not advance HEAD");
  for (const [name, service] of services) {
    if (service.deps.startupBuildCommit !== expectedBuildCommit) {
      throw new Error(`${name} changed its packaged build identity after repository movement`);
    }
    if ((await service.deps.repositoryHead()) !== secondHead) {
      throw new Error(`${name} did not report the advanced live repository HEAD`);
    }
  }

  let substituted = false;
  try {
    createProductionImplementationEvidenceService({
      resolved,
      dispatchCapability,
      repositoryRoot: root,
      environment: { CQ_HARNESS: "codex" },
      trustedSourceWorkspaceBuildCommit: "b".repeat(40),
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
