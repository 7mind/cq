/**
 * D61 regression reproduction (H41 root cause) — lost update across two
 * independent git-object stores over ONE repo + orphan ref.
 *
 * Scenario: two separately-registered `cq mcp` processes back the SAME repo on
 * the SAME orphan ref (`cq-ledger`). Each holds its OWN GitObjectLedgerBackend
 * instance with NO onMutation wired between them — so there is NO
 * cross-invalidation (the D-COHERENCE channel that LOCK-D01 relies on is
 * absent), exactly the production condition that triggered D61.
 *
 * The interleave is driven as SEQUENTIAL awaited calls. The bug is NOT a lock
 * race: the shared real-fs advisory lockfile under `.cq/.locks` already
 * serialises the two writers. The defect is the POST-LOCK STALE CACHE — under
 * git-object the write path never reloads the in-memory ledger from the
 * orphan-ref tip after taking the cross-process write lock. So:
 *   - storeB's in-memory `ledgers` map (built at init() from the ref tip it saw)
 *     never observes storeA's later commits;
 *   - createMilestone allocates M<n> from storeB's STALE in-memory counter
 *     (reusing an id storeA already allocated);
 *   - writeLedgerFile serializes storeB's WHOLE stale in-memory ledger, and
 *     GitPersistence.advance replaces milestones.md with that stale blob;
 *   - the lock serialised the writers so the CAS expectedOld matches the tip and
 *     updateRef fast-forwards with no StaleRefError → storeB silently clobbers
 *     storeA's milestone and reuses its id.
 *
 * The three assertions below FAIL TODAY (D61 reproduces): the lost write drops
 * one of storeA's titles AND duplicates an M<n> id. To keep `bun run check`
 * GREEN while committing the reproduction, the body runs under bun's
 * `test.failing` — a failing body is reported as an EXPECTED failure (suite
 * green, exit 0); if the body ever unexpectedly PASSES (i.e. the fix lands) the
 * suite turns RED, prompting T425 to flip this to a regular `test`.
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
  MILESTONES_ACTIVE_GROUP_ID,
  type LedgerSchema,
} from "../src/index.js";

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
  const dir = await fs.mkdtemp(path.join(tmpdir(), "git-lost-update-"));
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

describe("D61 — two git-object stores over one repo+ref, no cross-invalidate", () => {
  // EXPECTED to fail today: the lost-update reproduces (clobbered title +
  // duplicate M<n>). Flip to `test` once H41's fix (reload from ref tip after
  // lock) lands (T425).
  test(
    "sequential interleave across two un-invalidated stores loses a milestone write (lost update)",
    async () => {
      const dir = await seedRepo();
      await seedRegistry(dir, [{ name: MILESTONES_LEDGER, schema: MILESTONES_SCHEMA }]);

      // Two INDEPENDENT git-object stores over the SAME repo + orphan ref.
      // NO onMutation wired between them → NO cross-invalidation (simulates the
      // two-separately-registered-`cq mcp`-process condition that caused D61).
      const storeA = new GitObjectLedgerBackend({ repoRoot: dir });
      const storeB = new GitObjectLedgerBackend({ repoRoot: dir });
      // Each builds its in-memory `ledgers` map from the ref tip it sees at init.
      await storeA.init();
      await storeB.init();

      try {
        // The D61 interleave: SEQUENTIAL awaited calls. The shared real-fs
        // lockfile serialises them; the defect is the post-lock STALE CACHE,
        // not a lock race.
        const a1 = await storeA.createMilestone({ title: "W1" });
        const b1 = await storeB.createMilestone({ title: "W2" });
        const a2 = await storeA.createMilestone({ title: "W3" });
        const b2 = await storeB.createMilestone({ title: "W4" });

        const returned = [a1, b1, a2, b2];
        const expectedTitles = new Map(
          returned.map((m) => [m.id, m.fields["title"] as string]),
        );

        // THIRD fresh store: a real init() read from the orphan-ref tip (the
        // authority of record), not any in-memory map.
        const reader = new GitObjectLedgerBackend({ repoRoot: dir });
        await reader.init();
        try {
          const ms = reader.fetch(MILESTONES_LEDGER);
          const activeGroup = ms.milestones.find((g) => g.id === MILESTONES_ACTIVE_GROUP_ID);
          if (activeGroup === undefined) throw new Error("active milestone group missing on ref");
          // Map stored id -> title for the four user milestones (exclude the
          // immortal M-AMBIENT bootstrap milestone).
          const storedById = new Map(
            activeGroup.items
              .filter((it) => typeof it.fields["title"] === "string")
              .map((it) => [it.id, it.fields["title"] as string]),
          );

          // (b) The four returned ids are DISTINCT — no duplicate M<n>.
          const returnedIds = returned.map((m) => m.id);
          expect(new Set(returnedIds).size).toBe(4);

          // (a) All four titles W1..W4 are present in the stored ref.
          const storedTitles = new Set(storedById.values());
          for (const title of ["W1", "W2", "W3", "W4"]) {
            expect(storedTitles.has(title)).toBe(true);
          }

          // (c) Every returned id resolves to a stored milestone with its
          // expected title — no dropped/clobbered write.
          for (const [id, title] of expectedTitles) {
            expect(storedById.get(id)).toBe(title);
          }
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
