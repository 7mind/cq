/**
 * D62 regression reproduction — stale registry clobber across two independent
 * git-object stores over ONE repo + orphan ref (REGISTRY path).
 *
 * D62 reproduction contract:
 *   - Two separately-initialised GitObjectLedgerBackend instances over the same
 *     repo + orphan ref share NO onMutation cross-invalidation channel.
 *   - storeA.createLedger('alpha', schemaA) commits a registry entry for 'alpha'.
 *   - storeB's this.registry is STALE — it was built at init() before A's write,
 *     and has never been invalidated — so it does NOT contain 'alpha'.
 *   - storeB.createLedger('beta', schemaB): assertPrefixUnique runs against B's
 *     stale registry (misses 'alpha'), passes, then writeRegistry serializes B's
 *     stale this.registry — clobbering A's committed 'alpha' registry entry.
 *   - A THIRD fresh-init reader reads the orphan-ref tip and asserts BOTH
 *     'alpha' AND 'beta' survive with distinct prefixes. Today, 'alpha' is
 *     dropped, so the assertion fails.
 *
 * The test body is wrapped in bun `test.failing()` so that:
 *   - Today: the body throws (assertion fails on the missing registry entry for
 *     'alpha') — reported as EXPECTED FAILURE, suite stays GREEN.
 *   - After T428 lands the fix: the body passes — suite turns RED, prompting
 *     T428 to flip this to a regular `test()`.
 *
 * Touches NO production code — reproduction only.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  GitObjectLedgerBackend,
  GitPlumbing,
  serializeRegistry,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
  type LedgerSchema,
} from "../src/index.js";

// Custom schemas with prefixes not claimed by any canonical ledger
// (M D T H Q K G R HO I are taken; ALP and BET are free).
const ALPHA_SCHEMA: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  idPrefix: "ALP",
  transitions: { open: ["done"], done: [] },
  fields: { headline: { type: "string", required: true } },
};

const BETA_SCHEMA: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  idPrefix: "BET",
  transitions: { open: ["done"], done: [] },
  fields: { headline: { type: "string", required: true } },
};

const exec = promisify(execFile);
const BRANCH = "cq-ledger";
const REF = `refs/heads/${BRANCH}`;

const repos: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

/** Fresh seeded repo with one real commit + one tracked working file. */
async function seedRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "registry-stale-clobber-"));
  repos.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "src.txt"), "real source, byte-identical\n");
  await git(dir, "add", "src.txt");
  await git(dir, "commit", "-q", "-m", "main: initial");
  return dir;
}

/** Pre-seed the orphan ref with a ledgers.yaml registry so init() finds it. */
async function seedRegistry(
  dir: string,
  seed: Array<{ name: string; schema: LedgerSchema }>,
): Promise<void> {
  const plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
  const yaml = serializeRegistry({ version: 1, ledgers: seed });
  const blob = await plumbing.hashObject(yaml);
  const tree = await plumbing.writeTree([
    { mode: "100644", sha: blob, path: "ledgers.yaml" },
  ]);
  const commit = await plumbing.commitTree(tree, null, "ledger: seed registry");
  await plumbing.updateRef(REF, commit, null);
}

afterAll(async () => {
  for (const d of repos) await fs.rm(d, { recursive: true, force: true });
});

describe("D62 — two git-object stores over one repo+ref, no cross-invalidate (registry/createLedger)", () => {
  // EXPECTED to fail today: storeB's stale registry clobbers storeA's 'alpha'
  // entry. Flip to `test` once D62's fix lands (T428).
  test.failing(
    "sequential createLedger across two un-invalidated stores clobbers the first registry entry (stale registry write)",
    async () => {
      const dir = await seedRepo();
      // Seed only milestones so both stores start with an empty user-ledger
      // registry (just the canonical milestones ledger, no user ledgers yet).
      await seedRegistry(dir, [{ name: MILESTONES_LEDGER, schema: MILESTONES_SCHEMA }]);

      // Two INDEPENDENT git-object stores over the SAME repo + orphan ref.
      // NO onMutation wired between them → NO cross-invalidation (simulates two
      // separately-registered `cq mcp` processes that triggered D62).
      const storeA = new GitObjectLedgerBackend({ repoRoot: dir });
      const storeB = new GitObjectLedgerBackend({ repoRoot: dir });
      // Each builds its in-memory registry from the ref tip it sees at init().
      // At this point both see: registry = [{milestones}] — no user ledgers.
      await storeA.init();
      await storeB.init();

      try {
        // The D62 interleave: SEQUENTIAL awaited calls.
        //
        // storeA writes 'alpha' → orphan-ref tip now has registry [{milestones, alpha}].
        // storeB's this.registry is still [{milestones}] (stale — never invalidated).
        // storeB.createLedger('beta'): assertPrefixUnique checks B's stale
        //   registry → misses 'alpha' → passes.
        // storeB.writeRegistry() serializes B's stale this.registry
        //   ([{milestones, beta}]) → clobbers 'alpha' on the orphan ref.
        await storeA.createLedger("alpha", ALPHA_SCHEMA);
        await storeB.createLedger("beta", BETA_SCHEMA);

        // THIRD fresh store: a real init() read from the orphan-ref tip (the
        // authority of record), not any in-memory registry.
        const reader = new GitObjectLedgerBackend({ repoRoot: dir });
        await reader.init();
        try {
          // Both 'alpha' and 'beta' MUST be present in the committed registry.
          // Today 'alpha' is dropped (clobbered by B's stale writeRegistry call).
          const alphaLedger = reader.fetch("alpha");
          const betaLedger = reader.fetch("beta");

          // Both ledgers must be fetchable (not dropped/clobbered).
          expect(alphaLedger).toBeDefined();
          expect(betaLedger).toBeDefined();

          // They must have distinct id prefixes (T vs D — no collision).
          expect(alphaLedger.schema.idPrefix).not.toBe(betaLedger.schema.idPrefix);
        } finally {
          await reader.dispose();
        }
      } finally {
        await storeA.dispose();
        await storeB.dispose();
      }
    },
    30_000,
  );
});
