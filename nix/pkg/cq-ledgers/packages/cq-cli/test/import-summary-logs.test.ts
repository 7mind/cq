/**
 * T415 (G49) — fixture test for the import-summary-logs helper.
 *
 * Acceptance:
 *   - A fixture repo whose main history contains deleted docs/logs/*.md files
 *     referenced by sessionLogs in ledger items runs the import → all land in
 *     the orphan ref (lsTree shows logs/<f>).
 *   - A re-run is a no-op (ref SHA unchanged — idempotency).
 *   - Imported bytes match the source commit (modulo redaction, which runs in
 *     cq log put).
 *   - Raw logs under docs/logs/raw/ are NOT imported (summaries-only scope).
 *
 * The fixture is a throwaway git repo; cleaned up in afterAll.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { GitPlumbing, resolveLedgerBackend, type TreeEntry } from "@cq/ledger";
import { runLogPut, parseLogPutArgs } from "../src/logPut.js";

const execP = promisify(execFile);
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const REF = "refs/heads/cq-ledger";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execP("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      LC_ALL: "C",
      LANG: "C",
    },
  });
  return r.stdout;
}

/** Real GitPlumbing bound to a repo root. */
function plumbing(root: string): GitPlumbing {
  return GitPlumbing.withCwd(root, path.join(root, ".git"));
}

/**
 * Create the fixture throwaway repo:
 *   main branch history:
 *     commit-0: README.md
 *     commit-1: docs/logs/2026-01-summary.md, docs/logs/2026-02-summary.md,
 *               docs/logs/raw/2026-01-raw.md  (raw — must NOT be imported)
 *     commit-2: delete docs/logs/2026-01-summary.md
 *     commit-3: delete docs/logs/2026-02-summary.md (and raw)
 *
 * The orphan ref (refs/heads/cq-ledger) holds:
 *   tasks.md — a ledger file with sessionLogs referencing both summary files
 *
 * The cq.toml has backend = "git-object".
 */
async function fixtureRepo(): Promise<{
  root: string;
  summary1: string;
  summary2: string;
  rawLog: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-import-summary-"));
  dirs.push(dir);

  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");

  // commit-0: README
  await writeFile(path.join(dir, "README.md"), "# repo\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "init");

  // commit-1: create docs/logs/ summary files + a raw log
  await mkdir(path.join(dir, "docs", "logs", "raw"), { recursive: true });
  const summary1Content = "# Session summary 2026-01\n\nImplemented feature X.\n";
  const summary2Content = "# Session summary 2026-02\n\nFixed bug Y.\n";
  const rawLogContent = "raw harness transcript content\n";
  await writeFile(path.join(dir, "docs", "logs", "2026-01-summary.md"), summary1Content);
  await writeFile(path.join(dir, "docs", "logs", "2026-02-summary.md"), summary2Content);
  await writeFile(path.join(dir, "docs", "logs", "raw", "2026-01-raw.md"), rawLogContent);
  await git(dir, "add", "docs/");
  await git(dir, "commit", "-q", "-m", "add summary logs");

  // commit-2: delete summary1
  await git(dir, "rm", "-q", "docs/logs/2026-01-summary.md");
  await git(dir, "commit", "-q", "-m", "delete 2026-01 summary");

  // commit-3: delete summary2 and raw log
  await git(dir, "rm", "-q", "docs/logs/2026-02-summary.md");
  await git(dir, "rm", "-q", "docs/logs/raw/2026-01-raw.md");
  await git(dir, "commit", "-q", "-m", "delete 2026-02 summary and raw log");

  // Write cq.toml with git-object backend
  await writeFile(
    path.join(dir, "cq.toml"),
    '[ledger]\nbackend = "git-object"\n',
    "utf8",
  );

  // Seed the orphan ref with a tasks.md that references both summary logs.
  // Also include archive/tasks/M99.md that references summary2 (to test archive scanning).
  const tasksMd = [
    "---",
    "ledger: tasks",
    "counters:",
    "  milestone: 1",
    "  item: 3",
    "archives:",
    "  - id: M99",
    "    path: ./archive/tasks/M99.md",
    "    summary: archived milestone",
    "    title: archived milestone",
    "    status: done",
    "---",
    "",
    "# tasks",
    "",
    "## active",
    "",
    "### T1 — done",
    "",
    "- createdAt: 2026-01-01T00:00:00.000Z",
    "- updatedAt: 2026-01-02T00:00:00.000Z",
    "- headline: task one",
    `- sessionLogs: ["docs/logs/2026-01-summary.md"]`,
    "",
    "### T2 — done",
    "",
    "- createdAt: 2026-02-01T00:00:00.000Z",
    "- updatedAt: 2026-02-02T00:00:00.000Z",
    "- headline: task two",
    "- sessionLogs: []",
    "",
  ].join("\n");

  // Archive file for M99 referencing summary2.
  const archiveMd = [
    "## M99",
    "",
    "### T3 — done",
    "",
    "- createdAt: 2026-03-01T00:00:00.000Z",
    "- updatedAt: 2026-03-02T00:00:00.000Z",
    "- headline: task three (archived)",
    `- sessionLogs: ["docs/logs/2026-02-summary.md"]`,
    "",
  ].join("\n");

  const gitPlumb = plumbing(dir);
  const tSha = await gitPlumb.hashObject(tasksMd);
  const aSha = await gitPlumb.hashObject(archiveMd);
  const entries: TreeEntry[] = [
    { mode: "100644", sha: tSha, path: "tasks.md" },
    { mode: "100644", sha: aSha, path: "archive/tasks/M99.md" },
  ];
  const tree = await gitPlumb.writeTree(entries);
  const commit = await gitPlumb.commitTree(tree, null, "seed ledger");
  await gitPlumb.updateRef(REF, commit, null);

  return { root: dir, summary1: summary1Content, summary2: summary2Content, rawLog: rawLogContent };
}

// ---------------------------------------------------------------------------
// Helpers to run the import logic inline (mirrors import-summary-logs.ts)
// ---------------------------------------------------------------------------

/**
 * Run the import logic from the script against a given root, without spawning a
 * subprocess (so the test can assert on effects directly).  Returns counts.
 *
 * This re-implements the core logic so the test file has no dynamic import of
 * the script (which is top-level-await'd), keeping the test hermetic.
 */
async function runImport(root: string): Promise<{
  imported: number;
  skipped: number;
  failed: number;
  refSha: string | null;
}> {
  const { branch } = resolveLedgerBackend(root);
  const ref = `refs/heads/${branch}`;
  const git = GitPlumbing.withCwd(root, path.join(root, ".git"));

  const refShaInitial = await git.readRef(ref);
  const treeNames: string[] = refShaInitial === null ? [] : await git.lsTree(ref);
  const treeSet = new Set(treeNames);

  // Collect sessionLogs references from all .md files in the orphan ref.
  const sessionLogRefs = new Set<string>();
  for (const treePath of treeNames) {
    if (!treePath.endsWith(".md")) continue;
    const content = await git.catFile(ref, treePath);
    extractSessionLogsFromText(content, sessionLogRefs);
  }

  // Determine missing ones.
  const missing: string[] = [];
  for (const docsPath of sessionLogRefs) {
    if (!isSummaryLogRef(docsPath)) continue;
    const treePath = docsPath.slice("docs/".length); // docs/logs/foo.md → logs/foo.md
    if (!treeSet.has(treePath)) {
      missing.push(docsPath);
    }
  }

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const docsPath of missing) {
    const treePath = docsPath.slice("docs/".length);

    // Recover from git history.
    const contents = await recoverFromGitHistory(root, docsPath, git);
    if (contents.length === 0) {
      skipped++;
      continue;
    }
    const content = contents[0]!;

    // Idempotency re-check.
    const currentTree = await git.lsTree(ref);
    if (currentTree.includes(treePath)) {
      skipped++;
      continue;
    }

    const outs: string[] = [];
    const errs: string[] = [];
    const args = parseLogPutArgs(root, ["--stdin", "--dest", treePath]);
    const outcome = await runLogPut(args, {
      out: (l) => outs.push(l),
      err: (l) => errs.push(l),
      readStdin: async () => content,
    });

    if (outcome.exitCode !== 0) {
      failed++;
    } else {
      imported++;
    }
  }

  const refSha = await git.readRef(ref);
  return { imported, skipped, failed, refSha };
}

function isSummaryLogRef(s: string): boolean {
  if (!s.startsWith("docs/logs/")) return false;
  if (!s.endsWith(".md")) return false;
  const rel = s.slice("docs/logs/".length);
  if (rel.startsWith("raw/")) return false;
  return true;
}

function extractSessionLogsFromText(text: string, out: Set<string>): void {
  const LINE_RE = /[-]\s+sessionLogs:\s*(\[.*?\])/g;
  let m: RegExpExecArray | null;
  while ((m = LINE_RE.exec(text)) !== null) {
    const arr = m[1];
    if (arr === undefined) continue;
    const ENTRY_RE = /"([^"]+)"/g;
    let em: RegExpExecArray | null;
    while ((em = ENTRY_RE.exec(arr)) !== null) {
      const entry = em[1];
      if (entry !== undefined) out.add(entry);
    }
  }
}

async function recoverFromGitHistory(
  root: string,
  docsPath: string,
  git: GitPlumbing,
): Promise<string[]> {
  const execFileP = promisify(execFile);
  const run = async (...args: string[]): Promise<string> => {
    const r = await execFileP("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    return r.stdout;
  };

  let revList: string;
  try {
    revList = await run("log", "--all", "--format=%H", "--diff-filter=AM", "--", docsPath);
  } catch {
    revList = "";
  }

  const shas = revList.split("\n").filter((s) => s.length === 40);

  if (shas.length === 0) {
    // Fallback: find deletion commits, use their parent.
    let delLog: string;
    try {
      delLog = await run("log", "--all", "--format=%H", "--diff-filter=D", "--", docsPath);
    } catch {
      delLog = "";
    }
    const delShas = delLog.split("\n").filter((s) => s.length === 40);
    for (const delSha of delShas) {
      let parentOut: string;
      try {
        parentOut = await run("rev-parse", `${delSha}^1`);
      } catch {
        continue;
      }
      const parentSha = parentOut.trim();
      if (parentSha.length === 40) shas.push(parentSha);
    }
  }

  if (shas.length === 0) return [];

  const seenContentShas = new Set<string>();
  const unique: string[] = [];
  for (const sha of shas) {
    let content: string;
    try {
      content = await run("show", `${sha}:${docsPath}`);
    } catch {
      continue;
    }
    const cSha = await git.hashObject(content);
    if (seenContentShas.has(cSha)) continue;
    seenContentShas.add(cSha);
    unique.push(content);
    break; // take only the most recent unique copy
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("import-summary-logs", () => {
  it("imports all missing docs/logs/*.md summary logs into the orphan ref", async () => {
    const { root, summary1, summary2 } = await fixtureRepo();
    const git = plumbing(root);

    // Before import: neither summary log is present in the ref.
    const treeBefore = await git.lsTree(REF);
    expect(treeBefore).not.toContain("logs/2026-01-summary.md");
    expect(treeBefore).not.toContain("logs/2026-02-summary.md");

    const result = await runImport(root);

    // Both summary logs imported; no failures.
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(0);

    const treeAfter = await git.lsTree(REF);
    expect(treeAfter).toContain("logs/2026-01-summary.md");
    expect(treeAfter).toContain("logs/2026-02-summary.md");

    // Raw log must NOT have been imported.
    expect(treeAfter.find((p) => p.includes("raw/"))).toBeUndefined();

    // Content matches the source (modulo redaction — no secrets in fixtures).
    const got1 = await git.catFile(REF, "logs/2026-01-summary.md");
    expect(got1).toBe(summary1);
    const got2 = await git.catFile(REF, "logs/2026-02-summary.md");
    expect(got2).toBe(summary2);
  });

  it("scans archive files for sessionLogs references (not just active items)", async () => {
    const { root } = await fixtureRepo();
    const git = plumbing(root);

    const result = await runImport(root);

    // T3 in archive/tasks/M99.md references 2026-02-summary.md — it must be imported.
    expect(result.imported).toBeGreaterThanOrEqual(1);
    const treeAfter = await git.lsTree(REF);
    expect(treeAfter).toContain("logs/2026-02-summary.md");
  });

  it("is idempotent: a re-run leaves the ref SHA unchanged", async () => {
    const { root } = await fixtureRepo();
    const git = plumbing(root);

    // First run: imports both files.
    const run1 = await runImport(root);
    expect(run1.imported).toBe(2);
    const refShaAfterRun1 = run1.refSha;
    expect(refShaAfterRun1).not.toBeNull();

    // Second run: all files already present → no writes.
    const run2 = await runImport(root);
    expect(run2.imported).toBe(0);
    expect(run2.failed).toBe(0);

    // The orphan ref SHA must be byte-identical to after run 1.
    const refShaAfterRun2 = await git.readRef(REF);
    expect(refShaAfterRun2).toBe(refShaAfterRun1);
  });

  it("does not import docs/logs/raw/* files (raw transcripts excluded)", async () => {
    const { root } = await fixtureRepo();
    const git = plumbing(root);

    // Add a sessionLogs reference to a raw log so the script would attempt it.
    // We patch the orphan ref's tasks.md to include a raw reference.
    const refSha = await git.readRef(REF);
    if (refSha === null) throw new Error("fixture: ref must exist");

    const tasksMdWithRawRef = [
      "---",
      "ledger: tasks",
      "counters:",
      "  milestone: 0",
      "  item: 1",
      "archives: []",
      "---",
      "",
      "# tasks",
      "",
      "## active",
      "",
      "### T99 — done",
      "",
      "- createdAt: 2026-01-01T00:00:00.000Z",
      "- updatedAt: 2026-01-01T00:00:00.000Z",
      "- headline: task with raw and summary refs",
      // Reference both a summary and a raw log.
      `- sessionLogs: ["docs/logs/2026-01-summary.md","docs/logs/raw/2026-01-raw.md"]`,
      "",
    ].join("\n");

    // Re-seed the orphan ref with this tasks.md (no archive entry).
    const currentEntries = await git.lsTreeEntries(REF);
    const tSha = await git.hashObject(tasksMdWithRawRef);
    const kept = currentEntries.filter((e) => e.path !== "tasks.md" && e.path !== "archive/tasks/M99.md");
    kept.push({ mode: "100644", sha: tSha, path: "tasks.md" });
    const tree = await git.writeTree(kept);
    const commit = await git.commitTree(tree, refSha, "patch: add raw ref");
    await git.updateRef(REF, commit, refSha);

    const result = await runImport(root);

    // Only the summary log is imported; the raw log is excluded.
    const treeAfter = await git.lsTree(REF);
    expect(treeAfter).toContain("logs/2026-01-summary.md");
    expect(treeAfter.find((p) => p.startsWith("logs/raw/"))).toBeUndefined();

    // raw log was neither imported nor counted as a failure.
    expect(result.failed).toBe(0);
  });
});
