import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  parseArguments,
  readCredential,
  sanitizeUniqueTypedRejection,
  type CredentialRuntime,
} from "../scripts/guardedRebaseProbeRuntime.js";

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

describe("guarded-rebase rejection probe policy [Behavioral-Active Blackbox-Atomic]", () => {
  test("parses the fixed handle-free T6411 invocation", () => {
    expect(
      parseArguments([
        "--candidate", "candidate", "--credential-file", "credential", "--repository", "repo",
        "--worktree", "worktree", "--branch", "implement/T6411", "--head", "a".repeat(40),
        "--recovery-ref", "refs/cq/recovery/T6411",
      ]),
    ).toMatchObject({ branch: "implement/T6411", recoveryRef: "refs/cq/recovery/T6411" });
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
          path: "input.baseCommit",
          detail: "baseCommit does not equal ontoCommit",
        },
        secret,
      ),
    ).toEqual({ path: "input.baseCommit", detail: "baseCommit does not equal ontoCommit" });
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
  });

  test("uses one immutable candidate through real stdio and Git without disclosing its credential [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t6411-probe-"));
    try {
      await git(root, ["init", "-q", "-b", "implement/T6411"]);
      await git(root, ["config", "user.name", "T6411"]);
      await git(root, ["config", "user.email", "t6411@example.invalid"]);
      await writeFile(path.join(root, "seed.txt"), "seed\n");
      await git(root, ["add", "seed.txt"]);
      await git(root, ["commit", "-q", "-m", "seed"]);
      const head = await git(root, ["rev-parse", "HEAD"]);
      const candidateExecutable = Bun.which("cq");
      if (candidateExecutable === null) throw new Error("cq candidate is unavailable");
      const candidate = path.join(root, "candidate");
      await symlink(path.dirname(path.dirname(await realpath(candidateExecutable))), candidate);
      const credential = path.join(root, "credential");
      const secret = `cq-guarded-rebase:v1:${"0".repeat(64)}`;
      await writeFile(credential, `${secret}\n`);
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
          root,
          "--branch",
          "implement/T6411",
          "--head",
          head,
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
      expect(exit).toBe(1);
      expect(stdout).toBe("");
      expect(`${stdout}${stderr}`).not.toContain(secret);
      expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
      expect(await git(root, ["status", "--porcelain", "--untracked-files=all"])).toBe(statusBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
