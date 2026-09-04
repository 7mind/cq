#!/usr/bin/env bun

import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const NIX_OUTPUT = /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/;

interface Arguments {
  readonly candidate: string;
  readonly credentialFile: string;
  readonly repository: string;
  readonly worktree: string;
  readonly branch: string;
  readonly head: string;
  readonly recoveryRef: string;
}

function required(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index < 0 ? undefined : arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function parseArguments(arguments_: readonly string[]): Arguments {
  return {
    candidate: required(arguments_, "--candidate"),
    credentialFile: required(arguments_, "--credential-file"),
    repository: required(arguments_, "--repository"),
    worktree: required(arguments_, "--worktree"),
    branch: required(arguments_, "--branch"),
    head: required(arguments_, "--head"),
    recoveryRef: required(arguments_, "--recovery-ref"),
  };
}

async function readCredential(file: string): Promise<string> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600) {
    throw new Error("credential file is not a regular mode-0600 file");
  }
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
      throw new Error("credential file changed during no-follow open");
    }
    const value = (await handle.readFile()).toString("utf8").trim();
    if (value.length === 0) throw new Error("credential file is empty");
    return value;
  } finally {
    await handle.close();
  }
}

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...arguments_], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exit !== 0) throw new Error("coordinate inspection failed");
  return stdout.trim();
}

async function coordinates(arguments_: Arguments): Promise<Readonly<Record<string, string>>> {
  const [repository, branch, head, recoveryRef, clean] = await Promise.all([
    git(arguments_.worktree, ["rev-parse", "--show-toplevel"]),
    git(arguments_.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(arguments_.worktree, ["rev-parse", "HEAD"]),
    git(arguments_.worktree, ["rev-parse", "--verify", arguments_.recoveryRef]),
    git(arguments_.worktree, ["status", "--porcelain", "--untracked-files=all"]),
  ]);
  if (
    repository !== path.resolve(arguments_.worktree) ||
    branch !== arguments_.branch ||
    head !== arguments_.head ||
    clean !== ""
  ) {
    throw new Error("candidate coordinates drifted");
  }
  return { repository, branch, head, recoveryRef, clean };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const candidateLink = await fs.lstat(arguments_.candidate);
  if (!candidateLink.isSymbolicLink()) throw new Error("candidate must be a symlink");
  const candidate = await fs.realpath(arguments_.candidate);
  if (!NIX_OUTPUT.test(candidate) || (await fs.lstat(candidate)).isSymbolicLink()) {
    throw new Error("candidate does not resolve once to an immutable Nix output");
  }
  const credential = await readCredential(arguments_.credentialFile);
  const before = await coordinates(arguments_);
  const sdkRoot = path.resolve(import.meta.dir, "..", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(path.join(sdkRoot, "client", "index.js")).href),
    import(pathToFileURL(path.join(sdkRoot, "client", "stdio.js")).href),
  ]);
  const transport = new StdioClientTransport({
    command: path.join(candidate, "bin", "cq"),
    args: ["mcp", "--cwd", arguments_.repository, "--management"],
    env: { ...process.env },
    stderr: "pipe",
  });
  const client = new Client({ name: "t6411-guarded-rebase-probe", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const response = (await client.callTool({
      name: "prepare_dispatch",
      arguments: {
        roleId: "implement-worker",
        input: {
          taskId: "T6411",
          headline: "guarded-rebase rejection probe",
          description: "bounded operator verification",
          acceptance: "reject without allocating authority",
          worktreePath: arguments_.worktree,
          branch: arguments_.branch,
          baseCommit: arguments_.head,
          round: 1,
          startingCommit: arguments_.head,
          priorResultCommit: arguments_.head,
        },
        idempotencyKey: "T6411-guarded-rebase-probe",
        timeoutMs: 60_000,
        expectedChild: { childId: "t6411-operator-probe", runId: "t6411-operator-probe" },
        guardedRebase: credential,
      },
    })) as { readonly content?: readonly { readonly type: string; readonly text?: string }[] };
    const text = response.content?.find((entry) => entry.type === "text")?.text;
    if (text === undefined) throw new Error("management server returned no decision");
    const decision = JSON.parse(text) as Record<string, unknown>;
    if (
      decision["accepted"] !== false ||
      decision["allocated"] !== false ||
      decision["path"] === "guardedRebase" ||
      typeof decision["path"] !== "string" ||
      typeof decision["detail"] !== "string" ||
      Object.hasOwn(decision, "handle") ||
      Object.hasOwn(decision, "prepared")
    ) {
      throw new Error("probe observed generic rejection or accidental admission");
    }
    const after = await coordinates(arguments_);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("candidate coordinates drifted");
    process.stdout.write(`${JSON.stringify({ candidate: path.basename(candidate), path: decision["path"], detail: decision["detail"] })}\n`);
  } finally {
    await client.close();
  }
}

void main().catch(() => {
  process.stderr.write("guarded-rebase probe failed\n");
  process.exitCode = 1;
});
