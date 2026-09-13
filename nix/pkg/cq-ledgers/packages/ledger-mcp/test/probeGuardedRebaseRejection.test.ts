import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteAttestationBackend,
  xdgAttestationDbPath,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
} from "@cq/config";
import {
  createLedgerStore,
  MILESTONES_AMBIENT_ID,
  prepareManagedWorktree,
  resolveSingleProjectAttestationNamespace,
  TASKS_LEDGER,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";
import {
  parseArguments,
  readCredential,
  sanitizeUniqueTypedRejection,
  GUARDED_REBASE_PROBE_REJECTION,
  type CredentialRuntime,
} from "../scripts/guardedRebaseProbeRuntime.js";

import { useIsolatedXdgSuite } from "../../cq-config/test/xdgSuiteFixture.js";

useIsolatedXdgSuite(async () => {});

function status(overrides: Partial<{ mode: number; uid: number; dev: number; ino: number }> = {}) {
  return {
    mode: overrides.mode ?? 0o100600,
    uid: overrides.uid ?? 501,
    dev: overrides.dev ?? 1,
    ino: overrides.ino ?? 2,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function credentialRuntime(
  before = status(),
  opened = before,
  content = "cq-guarded-rebase:v1:secret",
): CredentialRuntime {
  return {
    getuid: () => 501,
    lstat: async () => before,
    open: async () => ({
      stat: async () => opened,
      readFile: async () => new TextEncoder().encode(content),
      close: async () => {},
    }),
  };
}

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...arguments_], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(`git ${arguments_.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function buildCandidate(): Promise<string> {
  const repository = await git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const child = Bun.spawn(["nix", "build", "--no-link", "--print-out-paths", ".#cq"], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const candidate = stdout.trim();
  if (exit !== 0 || !/^\/nix\/store\/[a-z0-9]{32}-[^/]+$/u.test(candidate)) {
    throw new Error(`cq candidate build failed: ${stderr}`);
  }
  return candidate;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactStore(): PromptArtifactStore {
  const metadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const,
    promptDigest: "a".repeat(64),
    schemaVersion: 9,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: "codex" as const,
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

async function guardedRebaseSource(root: string, candidate: string): Promise<{
  readonly worktree: string;
  readonly branch: string;
  readonly head: string;
  readonly priorResultCommit: string;
  readonly reference: string;
}> {
  const store = await createLedgerStore(root);
  const taskId = "T6411";
  try {
    await store.store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: taskId,
      status: "wip",
      fields: { headline: "guarded-rebase rejection probe" },
    });
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    const managed = await prepareManagedWorktree(
      { repositoryRoot: root, taskId, baseCommit },
      { skipInstall: true, bunWorkspaceRoot: root },
    );
    if (managed.status !== "prepared") throw new Error("T6411 worktree was not prepared");
    const namespace: AttestationNamespace = await resolveSingleProjectAttestationNamespace({
      construction: "stdio",
      backend: "xdg",
      repoRoot: root,
      projectId: null,
    });
    const attestationDbPath = xdgAttestationDbPath(namespace.projectKey);
    await mkdir(path.dirname(attestationDbPath), { recursive: true });
    const backend = new SqliteAttestationBackend({ namespace, dbPath: attestationDbPath });
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore(),
      repositoryRoot: root,
      randomBytes: sequentialDispatchRandomBytes(6_411),
    });
    const prepared = await capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId,
        headline: "guarded-rebase rejection probe",
        description: "create the terminal source for the operator probe",
        acceptance: "the candidate resolves one bounded guarded-rebase rejection",
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
        baseCommit,
        round: 0,
        startingCommit: baseCommit,
      },
      idempotencyKey: "T6411-probe-source",
      timeoutMs: 60_000,
      expectedChild: { childId: "t6411-probe-source", runId: "t6411-probe-source" },
    });
    if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
      throw new Error("T6411 source dispatch was not prepared for Git effects");
    }
    await capability.fetchInput({
      ...prepared.handle,
      inputCapability: prepared.prepared.inputCapability,
    });
    const sourcePath = "source.txt";
    const sourceBody = "terminal source\n";
    await writeFile(path.join(managed.handle.absolutePath, sourcePath), sourceBody);
    const receipt = await capability.gitCommit!({
      ...prepared.handle,
      gitChangeCapability: prepared.prepared.gitChangeCapability,
      operationId: "T6411-probe-source-commit",
      expectedHead: baseCommit,
      message: "T6411 probe source",
      changes: [{ kind: "add", path: sourcePath, newState: { mode: "100644", digest: sha256(sourceBody) } }],
    });
    await capability.abort({ ...prepared.handle, reason: "parent-lost" });
    await backend.close();
    await writeFile(path.join(root, "main.txt"), "advance main\n");
    await git(root, ["add", "main.txt"]);
    await git(root, ["commit", "-q", "-m", "advance main"]);
    const ontoCommit = await git(root, ["rev-parse", "HEAD"]);
    const child = Bun.spawn(
      [path.join(candidate, "bin", "cq"), "gate", "git-effect", "--operation", "rebase", "--cwd", root, "--task-id", taskId,
        "--commit", ontoCommit, "--operation-id", "T6411-probe-rebase"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) throw new Error(`T6411 guarded rebase failed: ${stderr}`);
    const reference = /^CQ_GUARDED_REBASE_REFERENCE=(\S+)$/mu.exec(stdout)?.[1];
    if (reference === undefined) throw new Error("T6411 guarded rebase emitted no reference");
    const head = await git(managed.handle.absolutePath, ["rev-parse", "HEAD"]);
    if (head === receipt.newHead) throw new Error("T6411 guarded rebase did not advance the source");
    return {
      worktree: managed.handle.absolutePath,
      branch: managed.handle.branch,
      head,
      priorResultCommit: receipt.newHead,
      reference,
    };
  } finally {
    await store.store.dispose();
  }
}

describe("guarded-rebase rejection probe policy [Behavioral-Active Blackbox-Atomic]", () => {
  test("parses the fixed handle-free T6411 invocation", () => {
    expect(
      parseArguments([
        "--candidate", "candidate", "--credential-file", "credential", "--repository", "repo",
        "--worktree", "worktree", "--branch", "implement/T6411", "--head", "a".repeat(40),
        "--prior-result-commit", "b".repeat(40),
        "--recovery-ref", "refs/cq/recovery/T6411",
      ]),
    ).toMatchObject({
      branch: "implement/T6411",
      priorResultCommit: "b".repeat(40),
      recoveryRef: "refs/cq/recovery/T6411",
    });
    expect(() => parseArguments(["--candidate"])).toThrow("missing --candidate");
  });

  test("accepts only same-user mode-0600 credentials across no-follow open", async () => {
    await expect(readCredential("credential", credentialRuntime())).resolves.toBe(
      "cq-guarded-rebase:v1:secret",
    );
    await expect(readCredential("credential", credentialRuntime(status({ uid: 502 })))).rejects.toThrow(
      "owned by this user",
    );
    await expect(
      readCredential("credential", credentialRuntime(status(), status({ mode: 0o100644 }))),
    ).rejects.toThrow("secure no-follow open");
    await expect(
      readCredential("credential", credentialRuntime(status(), status({ uid: 502 }))),
    ).rejects.toThrow("secure no-follow open");
  });

  test("emits only a capability-free typed rejection and never a secret-bearing detail", () => {
    const secret = "cq-guarded-rebase:v1:secret";
    expect(
      sanitizeUniqueTypedRejection(
        {
          accepted: false,
          allocated: false,
          ...GUARDED_REBASE_PROBE_REJECTION,
        },
        secret,
      ),
    ).toEqual(GUARDED_REBASE_PROBE_REJECTION);
    expect(() =>
      sanitizeUniqueTypedRejection(
        { accepted: false, allocated: false, path: "input.baseCommit", detail: secret },
        secret,
      ),
    ).toThrow("containing the guarded-rebase reference");
    expect(() =>
      sanitizeUniqueTypedRejection(
        {
          accepted: false,
          allocated: false,
          path: "input.baseCommit",
          detail: "safe detail",
          gitChangeCapability: "forbidden",
        },
        secret,
      ),
    ).toThrow("accidental admission");
    expect(() =>
      sanitizeUniqueTypedRejection(
        {
          accepted: false,
          allocated: false,
          path: "input.startingCommit",
          detail:
            "guarded rebase continuation requires startingCommit to equal the journaled rebased head",
        },
        secret,
      ),
    ).toThrow("unrelated typed rejection");
    expect(() =>
      sanitizeUniqueTypedRejection(
        {
          accepted: false,
          allocated: false,
          path: "input.baseCommit",
          detail: "unexpected sanitized coordinate failure",
        },
        secret,
      ),
    ).toThrow("unrelated typed rejection");
  });

  test("uses one immutable candidate through real stdio and Git without disclosing its credential [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "t6411-probe-"));
    const root = path.join(fixture, "repository");
    try {
      const candidateOutput = await buildCandidate();
      await Bun.write(path.join(fixture, "placeholder"), "");
      await git(fixture, ["init", "-q", "-b", "main", root]);
      await git(root, ["config", "user.name", "T6411"]);
      await git(root, ["config", "user.email", "t6411@example.invalid"]);
      await writeFile(path.join(root, "seed.txt"), "seed\n");
      await writeFile(path.join(root, ".gitignore"), ".cq/\n.claude/\n");
      await writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
      await git(root, ["add", "seed.txt"]);
      await git(root, ["add", ".gitignore", "cq.toml"]);
      await git(root, ["commit", "-q", "-m", "seed"]);
      const source = await guardedRebaseSource(root, candidateOutput);
      const candidate = path.join(fixture, "candidate");
      await symlink(candidateOutput, candidate);
      const credential = path.join(fixture, "credential");
      await writeFile(credential, `${source.reference}\n`);
      await chmod(credential, 0o600);
      const statusBefore = await git(root, ["status", "--porcelain", "--untracked-files=all"]);
      const script = new URL("../scripts/probe-guarded-rebase-rejection.ts", import.meta.url).pathname;
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          script,
          "--candidate",
          candidate,
          "--credential-file",
          credential,
          "--repository",
          root,
          "--worktree",
          source.worktree,
          "--branch",
          source.branch,
          "--head",
          source.head,
          "--prior-result-commit",
          source.priorResultCommit,
          "--recovery-ref",
          "HEAD",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit).toBe(0);
      expect(stdout).toBe(
        `${JSON.stringify({ candidate: path.basename(await realpath(candidate)), ...GUARDED_REBASE_PROBE_REJECTION })}\n`,
      );
      expect(`${stdout}${stderr}`).not.toContain(source.reference);
      expect(await git(source.worktree, ["rev-parse", "HEAD"])).toBe(source.head);
      expect(await git(root, ["status", "--porcelain", "--untracked-files=all"])).toBe(statusBefore);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 120_000);
});
