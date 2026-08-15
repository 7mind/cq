import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  FsLedgerStore,
  IDEAS_LEDGER,
  worksetMemberRefSet,
  type FsLedgerStoreOpts,
  type WorksetOwnedGuardedLedger,
} from "../src/index.js";

const roots: string[] = [];
const ledgers: WorksetOwnedGuardedLedger[] = [];

afterAll(async () => {
  for (const ledger of ledgers) await ledger.dispose().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function open(
  root: string,
  options: Omit<FsLedgerStoreOpts, "root"> = {},
): Promise<{ raw: FsLedgerStore; ledger: WorksetOwnedGuardedLedger }> {
  const raw = new FsLedgerStore({ root, ...options });
  const worksetStore = raw.createWorksetStore({
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

describe("workset coordination-bundle filesystem faults [T1963]", () => {
  it("two store instances serialize ownerless allocation without losing either write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "owned-write-fs-race-"));
    roots.push(root);
    const first = await open(root);
    const second = await open(root);
    const [left, right] = await Promise.all([
      first.ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "fs-race-left" },
      }),
      second.ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "fs-race-right" },
      }),
    ]);
    expect(left.id).not.toBe(right.id);
    await first.raw.invalidate(IDEAS_LEDGER);
    expect(first.raw.search(IDEAS_LEDGER, "fs-race-").map((item) => item.id).sort()).toEqual(
      [left.id, right.id].sort(),
    );
  });
});
