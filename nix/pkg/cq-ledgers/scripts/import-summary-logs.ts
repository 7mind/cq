#!/usr/bin/env bun
/**
 * One-time import of historical summary logs from main's git history into the
 * active git-object backend orphan ref (T415 / G49).
 *
 * ## What it does
 *
 * 1. Reads the orphan ref's ledger tree (`ledgers.yaml` + `*.md` files) and
 *    parses every `sessionLogs` field to enumerate all `docs/logs/<f>` paths
 *    that ledger items reference.
 * 2. Restricts to SUMMARY logs only — files directly under `docs/logs/` with a
 *    `.md` extension that do NOT live under `docs/logs/raw/`.  Raw harness
 *    transcripts (`docs/logs/raw/**`) are intentionally EXCLUDED: the
 *    go-forward-only policy applies to those large JSONL files; this script
 *    imports only the already-committed human-readable session summaries.
 * 3. For each referenced summary log path, checks whether the file is already
 *    present in the orphan ref (via `lsTree`).  If it IS present the file is
 *    SKIPPED, which makes the script fully IDEMPOTENT: re-running leaves the
 *    ref SHA unchanged.
 * 4. For each MISSING file, searches the supplied git history ref (`--history`
 *    flag, default `HEAD`) using `git log --all --diff-filter=D -- <path>` to
 *    locate commits that deleted the file (or the last commit before the deletion
 *    that still contained it).  When multiple git revisions carry the same
 *    content (rebases, cherry-picks), only ONE copy is imported — deduplication
 *    is by content SHA (`git hash-object`).
 * 5. Feeds each recovered file through {@link runLogPut} with `--stdin` so the
 *    normal redaction + validation + CAS commit pipeline applies, identical to a
 *    live `cq log put` call.
 *
 * ## SCOPE: summaries only
 *
 * This script imports `docs/logs/*.md` summary files — the already-committed
 * human-readable session notes that were tracked on the main branch before the
 * git-object backend was introduced.  It does NOT import raw JSONL transcripts
 * under `docs/logs/raw/`; those follow the go-forward-only policy.
 *
 * ## DEFERRED live-run
 *
 * The one-time live-run against the real repo is a DEFERRED OPERATIONAL STEP.
 * It must be performed AFTER the D61 fix is deployed and the MCP server has
 * been quiesced (no concurrent writers).  Running this script against the live
 * repo before D61 is deployed may produce an inconsistent state.
 *
 * ## Usage
 *
 *   bun run scripts/import-summary-logs.ts [--cwd /path/to/repo] [--history <git-ref>] [--dry-run]
 *
 * Options:
 *   --cwd <path>      Ledger root (default: script's parent directory, i.e. the
 *                     workspace root where cq.toml lives).
 *   --history <ref>   Git ref or commit whose history is searched for deleted
 *                     docs/logs/*.md files (default: HEAD).
 *   --dry-run         Print what would be imported without actually writing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import {
  GitPlumbing,
  resolveLedgerBackend,
} from "../packages/ledger/src/index.js";
import { runLogPut, parseLogPutArgs } from "../packages/cq-cli/src/logPut.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
let cwdArg: string | undefined;
let historyRef = "HEAD";
let dryRun = false;

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--cwd") {
    cwdArg = rawArgs[++i];
  } else if (a !== undefined && a.startsWith("--cwd=")) {
    cwdArg = a.slice("--cwd=".length);
  } else if (a === "--history") {
    const v = rawArgs[++i];
    if (v === undefined) { process.stderr.write("import-summary-logs: --history requires a value\n"); process.exit(2); }
    historyRef = v;
  } else if (a !== undefined && a.startsWith("--history=")) {
    historyRef = a.slice("--history=".length);
  } else if (a === "--dry-run") {
    dryRun = true;
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const root = cwdArg !== undefined ? path.resolve(cwdArg) : path.resolve(SCRIPT_DIR, "..");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { backend, branch } = resolveLedgerBackend(root);
if (backend !== "git-object") {
  process.stderr.write(
    `import-summary-logs: [ledger] backend='${backend}' — this script only applies to the ` +
      `git-object backend (backend='git-object' in cq.toml).\n`,
  );
  process.exit(2);
}

const ref = `refs/heads/${branch}`;
const git = GitPlumbing.withCwd(root, path.join(root, ".git"));

// --- Step 1: read ledger files from the orphan ref and collect sessionLogs ---

const refSha = await git.readRef(ref);
const treeNames: string[] = refSha === null ? [] : await git.lsTree(ref);
const treeSet = new Set(treeNames);

/**
 * Collect all `docs/logs/<f>` paths referenced in `sessionLogs` fields across
 * ALL files in the orphan ref's tree (active ledger files + all archive files),
 * restricting to summary `.md` files (not under `raw/`).
 *
 * We use a line-oriented regex rather than the full ledger parser so that both
 * active *.md and archive archive-wildcard files are handled uniformly
 * without needing per-schema parse context.  The format is stable:
 *   - sessionLogs: ["docs/logs/foo.md","docs/logs/bar.md"]
 */
async function collectSessionLogRefs(): Promise<Set<string>> {
  const found = new Set<string>();
  // Scan every .md file in the orphan ref tree (active ledgers + all archives).
  for (const treePath of treeNames) {
    if (!treePath.endsWith(".md")) continue;
    let content: string;
    try {
      content = await git.catFile(ref, treePath);
    } catch {
      continue;
    }
    extractSessionLogsFromText(content, found);
  }
  return found;
}

/**
 * Regex-based extractor: find `- sessionLogs: [...]` lines and pull out
 * all double-quoted `docs/logs/*.md` entries that match {@link isSummaryLogRef}.
 */
function extractSessionLogsFromText(text: string, out: Set<string>): void {
  // Match the sessionLogs field line (may be on one line or spanning a JSON array).
  const LINE_RE = /[-]\s+sessionLogs:\s*(\[.*?\])/g;
  let m: RegExpExecArray | null;
  while ((m = LINE_RE.exec(text)) !== null) {
    const arr = m[1];
    if (arr === undefined) continue;
    // Extract individual quoted strings from the JSON-flow array literal.
    const ENTRY_RE = /"([^"]+)"/g;
    let em: RegExpExecArray | null;
    while ((em = ENTRY_RE.exec(arr)) !== null) {
      const entry = em[1];
      if (entry !== undefined && isSummaryLogRef(entry)) {
        out.add(entry);
      }
    }
  }
}

/**
 * Returns true iff `s` is a docs-relative summary log reference:
 *  - starts with `docs/logs/`
 *  - ends with `.md`
 *  - is NOT under `docs/logs/raw/` (raw transcripts excluded)
 */
function isSummaryLogRef(s: string): boolean {
  if (!s.startsWith("docs/logs/")) return false;
  if (!s.endsWith(".md")) return false;
  // Exclude raw/ subdirectory
  const rel = s.slice("docs/logs/".length);
  if (rel.startsWith("raw/")) return false;
  return true;
}

/**
 * Convert a `docs/`-relative summary log reference (e.g. `docs/logs/foo.md`)
 * to its orphan-ref tree path (e.g. `logs/foo.md`, since the orphan tree is
 * rooted at the docs CONTENTS — no `docs/` prefix).
 */
function refPathFromDocsPath(docsRelPath: string): string {
  // docsRelPath = "docs/logs/foo.md" → orphan tree path = "logs/foo.md"
  return docsRelPath.slice("docs/".length);
}

// --- Step 2: determine which files are missing from the ref -----------------

const sessionLogRefs = await collectSessionLogRefs();

const missing: string[] = [];
for (const docsPath of sessionLogRefs) {
  const treePath = refPathFromDocsPath(docsPath);
  if (!treeSet.has(treePath)) {
    missing.push(docsPath);
  }
}

if (missing.length === 0) {
  process.stdout.write(
    "import-summary-logs: all referenced summary logs are already present in the " +
      `orphan ref ${ref} — nothing to import.\n`,
  );
  process.exit(0);
}

process.stdout.write(
  `import-summary-logs: ${missing.length} summary log(s) referenced by sessionLogs ` +
    `but absent from ${ref}:\n`,
);
for (const p of missing) {
  process.stdout.write(`  missing: ${p}\n`);
}

// --- Step 3: recover each missing file from git history ---------------------

/**
 * Run git in the repo root and return stdout.
 */
async function gitCmd(...args: string[]): Promise<string> {
  const r = await execFileP("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      LC_ALL: "C",
      LANG: "C",
    },
  });
  return r.stdout;
}

/**
 * Recover the content of `docsRelPath` (e.g. `docs/logs/foo.md`) from git
 * history reachable from `historyRef`.  Searches commits where the file was
 * present (the last commit that touched/added it before its deletion) using
 *
 *   git log --all --diff-filter=A --diff-filter=M -- <path>
 *
 * and picks the most recent such commit.  Falls back to searching for D
 * (deleted) commits and using their parent.  Deduplicates by content so
 * rebases that reintroduced the same bytes do not produce duplicate writes.
 *
 * Returns an array of unique content strings (deduped by SHA), or [] if the
 * file cannot be found in history.
 */
async function recoverFromHistory(docsRelPath: string): Promise<string[]> {
  // Use `git log --all --follow -- <path>` with null-terminated output to find
  // commits that touched the file.  We want the LAST commit that STILL HAD the
  // file (before or at the deletion point).
  let revList: string;
  try {
    revList = await gitCmd(
      "log",
      "--all",
      "--format=%H",
      "--diff-filter=AM",  // only Added / Modified (i.e. commits that HAD the file)
      "--",
      docsRelPath,
    );
  } catch {
    revList = "";
  }

  const shas = revList.split("\n").filter((s) => s.length === 40);
  if (shas.length === 0) {
    // Fallback: look for commits where the file was deleted, then use the
    // parent commit (which still had the file).
    let delLog: string;
    try {
      delLog = await gitCmd(
        "log",
        "--all",
        "--format=%H",
        "--diff-filter=D",
        "--",
        docsRelPath,
      );
    } catch {
      delLog = "";
    }
    const delShas = delLog.split("\n").filter((s) => s.length === 40);
    for (const delSha of delShas) {
      // The parent (^1) still had the file.
      let parentLog: string;
      try {
        parentLog = await gitCmd("rev-parse", `${delSha}^1`);
      } catch {
        continue;
      }
      const parentSha = parentLog.trim();
      if (parentSha.length === 40) {
        shas.push(parentSha);
      }
    }
  }

  if (shas.length === 0) {
    return [];
  }

  // Recover content from each candidate SHA, deduplicating by content SHA.
  const seenContentShas = new Set<string>();
  const unique: string[] = [];

  for (const sha of shas) {
    let content: string;
    try {
      content = await gitCmd("show", `${sha}:${docsRelPath}`);
    } catch {
      continue;
    }
    // Use git hash-object for content-addressed dedup.
    const contentSha = await git.hashObject(content);
    if (seenContentShas.has(contentSha)) continue;
    seenContentShas.add(contentSha);
    unique.push(content);
    // We only want the MOST RECENT unique copy (first in the log order = newest).
    break;
  }

  return unique;
}

// --- Step 4: import each missing file via cq log put ------------------------

let imported = 0;
let skipped = 0;
let failed = 0;

for (const docsPath of missing) {
  const treePath = refPathFromDocsPath(docsPath);     // e.g. logs/foo.md
  const destArg = treePath;                            // --dest logs/foo.md

  process.stdout.write(`  recovering: ${docsPath} ...\n`);

  const contents = await recoverFromHistory(docsPath);
  if (contents.length === 0) {
    process.stderr.write(
      `  [WARN] import-summary-logs: could not find ${docsPath} in git history ` +
        `(searched from ${historyRef} and --all); skipping.\n`,
    );
    skipped++;
    continue;
  }

  const content = contents[0]!;

  if (dryRun) {
    process.stdout.write(`  [dry-run] would import: ${docsPath} (${content.length} bytes)\n`);
    imported++;
    continue;
  }

  // Re-check idempotency immediately before the write (in case a concurrent
  // run already imported this file between the earlier check and now).
  const currentTree = await git.lsTree(ref);
  if (currentTree.includes(treePath)) {
    process.stdout.write(`  [skip] ${docsPath} now present in ref (concurrent import?) — idempotent skip\n`);
    skipped++;
    continue;
  }

  const outs: string[] = [];
  const errs: string[] = [];
  const logPutArgs = parseLogPutArgs(root, ["--stdin", "--dest", destArg]);
  const outcome = await runLogPut(
    logPutArgs,
    {
      out: (l) => outs.push(l),
      err: (l) => errs.push(l),
      readStdin: async () => content,
    },
  );

  if (outcome.exitCode !== 0) {
    process.stderr.write(
      `  [ERROR] import-summary-logs: cq log put failed for ${docsPath}:\n` +
        errs.map((e) => `    ${e}`).join("\n") + "\n",
    );
    failed++;
  } else {
    process.stdout.write(`  [ok] imported: ${docsPath}\n`);
    imported++;
  }
}

const refAfter = await git.readRef(ref);
process.stdout.write(
  `\nimport-summary-logs: done. imported=${imported} skipped=${skipped} failed=${failed}\n` +
    `  orphan ref ${ref} tip: ${refAfter ?? "(absent)"}\n`,
);

if (failed > 0) {
  process.exit(1);
}
