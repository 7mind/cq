import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createGitObjectWorksetStore,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  GitObjectLedgerBackend,
  GitPlumbing,
  IDEAS_LEDGER,
  worksetMemberRefSet,
  type WorksetOwnedGuardedLedger,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];
const ledgers: WorksetOwnedGuardedLedger[] = [];

afterAll(async () => {
  for (const ledger of ledgers) await ledger.dispose().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function seedRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "owned-write-git-fault-"));
  roots.push(root);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "test"], { cwd: root });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  return root;
}

async function open(
  repoRoot: string,
  git: GitPlumbing = GitPlumbing.withCwd(repoRoot, path.join(repoRoot, ".git")),
  onMutation?: (ledgerId: string) => void,
): Promise<{ raw: GitObjectLedgerBackend; ledger: WorksetOwnedGuardedLedger }> {
  const raw = new GitObjectLedgerBackend({
    repoRoot,
    git,
    ...(onMutation !== undefined ? { onMutation } : {}),
  });
  const worksetStore = await createGitObjectWorksetStore({
    repoRoot,
    git,
    isTargetAdmitted: (target, selectedRoots) => {
      if (selectedRoots.length === 0) return true;
      const graph = closeWorkset(
        selectedRoots,
        buildActiveStateFromLedgerStore(raw),
      );
      return worksetMemberRefSet(graph).has(target) || graph.inactiveRoots.includes(target);
    },
  });
  const ledger = createWorksetOwnedGuardedLedger({
    rawStore: raw,
    worksetStore,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate) => raw.runAtomicOwnedMutation(mutate),
  });
  await ledger.init();
  ledgers.push(ledger);
  return { raw, ledger };
}

describe("workset coordination-bundle Git-object faults [T1964]", () => {
  it("a committed ref becomes visible to a peer only after invalidation", async () => {
    const repoRoot = await seedRepo();
    const mutations: string[] = [];
    const writer = await open(repoRoot, undefined, (ledgerId) => mutations.push(ledgerId));
    const reader = await open(repoRoot);
    const idea = await writer.ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "git-peer-visible" },
    });
    expect(() => reader.raw.fetchItem(IDEAS_LEDGER, idea.id)).toThrow();
    await reader.raw.invalidate(IDEAS_LEDGER);
    expect(reader.raw.fetchItem(IDEAS_LEDGER, idea.id).fields.title).toBe("git-peer-visible");
    expect(mutations).toEqual([IDEAS_LEDGER]);
  });

  it("competing object writers serialize without losing either ref update", async () => {
    const repoRoot = await seedRepo();
    const first = await open(repoRoot);
    const second = await open(repoRoot);
    const [left, right] = await Promise.all([
      first.ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "git-race-left" },
      }),
      second.ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "git-race-right" },
      }),
    ]);
    expect(left.id).not.toBe(right.id);

    const restarted = await open(repoRoot);
    expect(restarted.raw.fetchItem(IDEAS_LEDGER, left.id).fields.title).toBe(
      "git-race-left",
    );
    expect(restarted.raw.fetchItem(IDEAS_LEDGER, right.id).fields.title).toBe(
      "git-race-right",
    );
  });
});
