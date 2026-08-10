/** T2042 — packaged cq-codex-role broker/confinement acceptance probe. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
} from "@cq/config";
import { prepareManagedWorktree } from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const roots: string[] = [];
const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "t2042-packaged" };
const INSTALLED_ROLE = process.env["CQ_TEST_CODEX_ROLE_EXECUTABLE"];
const ROLE_SCRIPT = fileURLToPath(
  new URL("../../cq-config/scripts/codex-role-dispatch.ts", import.meta.url),
);
const WORKER_FIXTURE = fileURLToPath(new URL("./fixtures/codexBrokerWorker.ts", import.meta.url));

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
    const stateDir = path.join(repositoryRoot, ".manager-state");
    const managed = await prepareManagedWorktree(
      { repositoryRoot, taskId: "T2042", baseCommit },
      { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
    const refsBefore = await git(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]);

    const store = new InMemoryAttestationStore(NAMESPACE);
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(store),
      promptArtifactStore: artifactStore(),
      repositoryRoot,
      worktreeStateDir: stateDir,
      now: () => "2026-08-10T12:00:00.000Z",
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

    let storedOutput: Record<string, unknown> | undefined;
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          switch (new URL(request.url).pathname) {
            case "/fetch":
              return Response.json(await capability.fetchInput(body as never));
            case "/git-commit":
              if (capability.gitCommit === undefined) throw new Error("git_commit unavailable");
              return Response.json(await capability.gitCommit(body as never));
            case "/store": {
              storedOutput = body["output"] as Record<string, unknown>;
              return Response.json(await capability.storeResult(body as never));
            }
            default:
              throw new Error("unknown packaged broker endpoint");
          }
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 409 },
          );
        }
      },
    });
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "t2042-packaged-fake-"));
    roots.push(fixtureRoot);
    const fakeCodex = path.join(fixtureRoot, "fake-codex");
    const capturePath = path.join(fixtureRoot, "capture.json");
    const promptRoot = path.join(fixtureRoot, "prompts");
    await mkdir(path.join(promptRoot, "roles"), { recursive: true });
    await writeFile(path.join(promptRoot, "roles", "implement-worker.md"), "Use the Git broker.\n");
    await writeFile(
      fakeCodex,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(WORKER_FIXTURE)} "$@"\n`,
    );
    await chmod(fakeCodex, 0o700);
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
        CQ_PROMPT_ROOT: promptRoot,
        CQ_CODEX_EXECUTABLE: fakeCodex,
        CQ_CODEX_LEDGER_COMMAND: "cq-not-invoked-by-recording",
        CQ_T2042_BROKER_ENDPOINT: `http://127.0.0.1:${String(endpoint.port)}`,
        CQ_T2042_BROKER_CAPTURE: capturePath,
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
    endpoint.stop(true);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(handle);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      denied: string[];
      output: Record<string, unknown>;
    };
    expect(capture.denied.sort()).toEqual([
      "base",
      "git-metadata",
      "main",
      "refs",
      "repository",
      "sibling",
      "undeclared-path",
    ]);
    expect(storedOutput).toEqual(capture.output);
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
