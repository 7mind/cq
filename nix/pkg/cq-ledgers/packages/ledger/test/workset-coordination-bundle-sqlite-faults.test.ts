import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  IDEAS_LEDGER,
  SqliteLedgerStore,
  worksetMemberRefSet,
  type WorksetOwnedGuardedLedger,
} from "../src/index.js";

const roots: string[] = [];
const ledgers: WorksetOwnedGuardedLedger[] = [];

afterAll(async () => {
  for (const ledger of ledgers) await ledger.dispose().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function freshDbPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "owned-write-sqlite-fault-"));
  roots.push(root);
  return path.join(root, "ledger.db");
}

async function open(
  dbPath: string,
): Promise<{ raw: SqliteLedgerStore; ledger: WorksetOwnedGuardedLedger }> {
  const raw = new SqliteLedgerStore({
    dbPath,
    workset: {
      isTargetAdmitted: (target, selectedRoots) => {
        if (selectedRoots.length === 0) return true;
        const graph = closeWorkset(
          selectedRoots,
          buildActiveStateFromLedgerStore(raw),
        );
        return worksetMemberRefSet(graph).has(target) || graph.inactiveRoots.includes(target);
      },
    },
  });
  await raw.init();
  const ledger = createWorksetOwnedGuardedLedger({
    rawStore: raw,
    worksetStore: raw.worksetStore(),
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate) => raw.runAtomicOwnedMutation(mutate),
  });
  ledgers.push(ledger);
  return { raw, ledger };
}

describe("workset coordination-bundle SQLite faults [T1965]", () => {
  it("peer commit remains complete and enters the derived index after invalidation", async () => {
    const dbPath = await freshDbPath();
    const writer = await open(dbPath);
    const reader = await open(dbPath);
    const idea = await writer.ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "sqlite-peer-visible" },
    });
    expect(reader.raw.fetchItem(IDEAS_LEDGER, idea.id).fields.title).toBe(
      "sqlite-peer-visible",
    );
    expect(await reader.raw.ftsSearch("sqlite-peer-visible")).toEqual([]);
    await reader.raw.invalidate(IDEAS_LEDGER);
    expect((await reader.raw.ftsSearch("sqlite-peer-visible")).map((hit) => hit.item.id)).toEqual([
      idea.id,
    ]);
  });

  it("competing database writers serialize allocation without losing either row", async () => {
    const dbPath = await freshDbPath();
    const first = await open(dbPath);
    const second = await open(dbPath);
    const [left, right] = await Promise.all([
      first.ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "sqlite-race-left" },
      }),
      second.ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "sqlite-race-right" },
      }),
    ]);
    expect(left.id).not.toBe(right.id);

    const restarted = await open(dbPath);
    expect(restarted.raw.fetchItem(IDEAS_LEDGER, left.id).fields.title).toBe(
      "sqlite-race-left",
    );
    expect(restarted.raw.fetchItem(IDEAS_LEDGER, right.id).fields.title).toBe(
      "sqlite-race-right",
    );
  });
});
