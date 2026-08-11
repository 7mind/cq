/** T2042 — packaged cq-codex-role broker/confinement acceptance probe. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FsAttestationBackend, sequentialDispatchRandomBytes } from "@cq/config";
import {
  createLedgerStore,
  fsAttestationProductionRoot,
  prepareManagedWorktree,
  resolveSingleProjectAttestationNamespace,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const roots: string[] = [];
const INSTALLED_ROLE = process.env["CQ_TEST_CODEX_ROLE_EXECUTABLE"];
const ROLE_SCRIPT = fileURLToPath(
  new URL("../../cq-config/scripts/codex-role-dispatch.ts", import.meta.url),
);
const WORKER_FIXTURE = fileURLToPath(new URL("./fixtures/codexBrokerWorker.ts", import.meta.url));
const CQ_CLI_SCRIPT = fileURLToPath(new URL("../../cq-cli/src/main.ts", import.meta.url));

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn([process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git", ...args], {
    cwd,
    env: {
      ...globalThis.process.env,
      GIT_AUTHOR_NAME: "T2042",
      GIT_AUTHOR_EMAIL: "t2042@example.invalid",
      GIT_COMMITTER_NAME: "T2042",
      GIT_COMMITTER_EMAIL: "t2042@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

function artifactStore(): PromptArtifactStore {
  const metadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const,
    promptDigest: "a".repeat(64),
    schemaVersion: 6,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: "codex",
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("packaged cq-codex-role Git broker", () => {
  test("contains installed-only worker and conflict-resolver provider gates", async () => {
    const source = await readFile(import.meta.filename, "utf8");
    expect(source).not.toContain("ROLE_SCRIPT");
    expect(source).toContain("codexBrokerWorker.ts");
    expect(source).toContain("codexBrokerResolver.ts");
    expect(source).toContain('roleId: "implement-conflict-resolver"');
  });

  test("makes two receipt-verified commits while every confinement negative remains unchanged", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t2042-packaged-role-"));
    roots.push(repositoryRoot);
    await git(repositoryRoot, ["init", "-q"]);
    await git(repositoryRoot, ["config", "user.name", "T2042"]);
    await git(repositoryRoot, ["config", "user.email", "t2042@example.invalid"]);
    await writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
    await git(repositoryRoot, ["add", "file.txt"]);
    await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repositoryRoot, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    const ledgerStore = await createLedgerStore(repositoryRoot);
    await ledgerStore.store.dispose();
    const baseTree = await git(repositoryRoot, ["rev-parse", `${baseCommit}^{tree}`]);
    const commonObject = path.join(
      repositoryRoot,
      ".git",
      "objects",
      baseTree.slice(0, 2),
      baseTree.slice(2),
    );
    const objectBefore = await readFile(commonObject);
    const canary = path.join(repositoryRoot, ".git", "T2042-canary");
    await writeFile(canary, "unchanged\n");

    const siblingPath = await mkdtemp(path.join(tmpdir(), "t2042-packaged-sibling-"));
    roots.push(siblingPath);
    await rm(siblingPath, { recursive: true });
    await git(repositoryRoot, ["worktree", "add", "-q", "-b", "sibling", siblingPath, baseCommit]);
    const managed = await prepareManagedWorktree(
      { repositoryRoot, taskId: "T2042", baseCommit },
      { skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
    const refsBefore = await git(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]);

    const namespace = await resolveSingleProjectAttestationNamespace({
      construction: "direct",
      backend: "fs",
      repoRoot: repositoryRoot,
      projectId: null,
    });
    const backend = new FsAttestationBackend({
      namespace,
      root: fsAttestationProductionRoot(repositoryRoot),
    });
    const dispatchNow = new Date().toISOString();
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore(),
      repositoryRoot,
      now: () => dispatchNow,
      randomBytes: sequentialDispatchRandomBytes(128),
    });
    const prepared = await capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2042",
        headline: "packaged broker probe",
        description: "make two broker commits",
        acceptance: "all confinement negatives remain unchanged",
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
        baseCommit,
        round: 0,
        startingCommit: baseCommit,
      },
      idempotencyKey: "T2042-packaged-role",
      timeoutMs: 600_000,
      expectedChild: { childId: "t2042-packaged-child", runId: "t2042-packaged-run" },
    });
    if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
      throw new Error("packaged worker dispatch did not receive Git capability");
    }
    await backend.close();
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "t2042-packaged-fake-"));
    roots.push(fixtureRoot);
    const fakeCodex = path.join(fixtureRoot, "fake-codex");
    const capturePath = path.join(fixtureRoot, "capture.json");
    const workerStderrPath = path.join(fixtureRoot, "worker.stderr");
    await writeFile(
      fakeCodex,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(WORKER_FIXTURE)} "$@" 2>"$CQ_T2042_WORKER_STDERR"\n`,
    );
    await chmod(fakeCodex, 0o700);
    const ledgerCommand =
      INSTALLED_ROLE === undefined ? path.join(fixtureRoot, "cq") : path.join(path.dirname(INSTALLED_ROLE), "cq");
    if (INSTALLED_ROLE === undefined) {
      await writeFile(
        ledgerCommand,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(CQ_CLI_SCRIPT)} -- "$@"\n`,
      );
      await chmod(ledgerCommand, 0o700);
    }
    const roleArgv =
      INSTALLED_ROLE === undefined ? [process.execPath, "run", ROLE_SCRIPT] : [INSTALLED_ROLE];
    const handle = {
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
    };
    const child = Bun.spawn(roleArgv, {
      cwd: managed.handle.absolutePath,
      env: {
        ...process.env,
        CQ_CODEX_EXECUTABLE: fakeCodex,
        CQ_CODEX_LEDGER_COMMAND: ledgerCommand,
        CQ_T2042_BROKER_CAPTURE: capturePath,
        CQ_T2042_WORKER_STDERR: workerStderrPath,
        CQ_T2042_WORKTREE: managed.handle.absolutePath,
        CQ_T2042_LEDGER_ROOT: repositoryRoot,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(
      `${JSON.stringify({
        roleId: "implement-worker",
        handle,
        inputCapability: prepared.prepared.inputCapability,
        resultCapability: prepared.prepared.resultCapability,
        gitChangeCapability: prepared.prepared.gitChangeCapability,
        cwd: managed.handle.absolutePath,
        ledgerCwd: repositoryRoot,
        model: "test-model",
        reasoningEffort: "high",
        sandboxMode: "workspace-write",
        timeoutMs: 30_000,
      })}\n`,
    );
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const workerStderr = await readFile(workerStderrPath, "utf8").catch(() => "");
    expect(exitCode, `${stderr}\n${workerStderr}`).toBe(0);
    expect(JSON.parse(stdout)).toEqual(handle);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      boundary: {
        codexCwd: string;
        ledgerCommand: string;
        ledgerArgs: string[];
        ledgerCwd: string;
        listedTools: string[];
      };
      denied: string[];
      output: Record<string, unknown>;
    };
    expect(capture.boundary).toMatchObject({
      codexCwd: managed.handle.absolutePath,
      ledgerCommand,
      ledgerCwd: repositoryRoot,
      listedTools: ["fetch_dispatch_input", "git_commit", "store_result"],
    });
    expect(capture.boundary.ledgerArgs).toContain("--prompt-root");
    expect(capture.denied.sort()).toEqual([
      "base",
      "git-metadata",
      "main",
      "refs",
      "repository",
      "sibling",
      "undeclared-path",
    ]);
    const receipts = capture.output["gitReceipts"] as Record<string, unknown>[];
    expect(receipts).toHaveLength(2);
    expect(receipts[1]?.["oldHead"]).toBe(receipts[0]?.["newHead"]);
    expect(receipts[1]?.["newHead"]).toBe(capture.output["resultCommit"]);
    expect(receipts.flatMap((receipt) => receipt["paths"] as string[]).sort()).toEqual([
      "file.txt",
      "file.txt",
    ]);
    expect(await git(repositoryRoot, ["rev-parse", "HEAD"])).toBe(baseCommit);
    expect(await readFile(path.join(repositoryRoot, "file.txt"), "utf8")).toBe("before\n");
    expect(await git(siblingPath, ["rev-parse", "HEAD"])).toBe(baseCommit);
    expect(await readFile(path.join(siblingPath, "file.txt"), "utf8")).toBe("before\n");
    const refsAfter = await git(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]);
    expect(
      refsAfter
        .split("\n")
        .filter((line) => !line.startsWith(`refs/heads/${managed.handle.branch} `)),
    ).toEqual(
      refsBefore
        .split("\n")
        .filter((line) => !line.startsWith(`refs/heads/${managed.handle.branch} `)),
    );
    expect(await readFile(canary, "utf8")).toBe("unchanged\n");
    expect(await readFile(commonObject)).toEqual(objectBefore);
    expect(
      await git(managed.handle.absolutePath, ["status", "--porcelain", "--untracked-files=all"]),
    ).toBe("");
    expect(
      await git(managed.handle.absolutePath, [
        "diff",
        "--name-only",
        baseCommit,
        String(capture.output["resultCommit"]),
      ]),
    ).toBe("file.txt");
    await git(managed.handle.absolutePath, [
      "merge-base",
      "--is-ancestor",
      baseCommit,
      String(capture.output["resultCommit"]),
    ]);
  }, 30_000);
});
