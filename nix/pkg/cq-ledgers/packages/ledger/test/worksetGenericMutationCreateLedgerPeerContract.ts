import { describe, expect, it } from "bun:test";
import {
  MILESTONES_LEDGER,
  TASKS_LEDGER,
  type LedgerSchema,
  type WorksetGuardedLedger,
} from "../src/index.js";

const X_SCHEMA: LedgerSchema = {
  idPrefix: "X",
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { title: { type: "string", required: true } },
};
const Y_SCHEMA: LedgerSchema = {
  idPrefix: "Y",
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { title: { type: "string", required: true } },
};

export interface GenericCreateLedgerPeerFixture {
  readonly first: WorksetGuardedLedger;
  readonly second: WorksetGuardedLedger;
  openReader(): Promise<WorksetGuardedLedger>;
}

export interface GenericCreateLedgerPeerFactory {
  readonly name: string;
  build(): Promise<GenericCreateLedgerPeerFixture>;
}

async function assertBothPersisted(fixture: GenericCreateLedgerPeerFixture): Promise<void> {
  const reader = await fixture.openReader();
  try {
    await reader.init();
    expect(reader.enumerate()).toEqual(expect.arrayContaining(["xenos", "yttrium"]));
    expect(reader.fetch("xenos").schema.idPrefix).toBe("X");
    expect(reader.fetch("yttrium").schema.idPrefix).toBe("Y");
    await expect(reader.mutations.createLedger("duplicate-x", X_SCHEMA)).rejects.toThrow(
      /prefix/i,
    );
  } finally {
    await reader.dispose();
  }
}

async function disposePeers(fixture: GenericCreateLedgerPeerFixture): Promise<void> {
  await fixture.first.dispose();
  await fixture.second.dispose();
}

export function runGenericCreateLedgerPeerContract(
  factory: GenericCreateLedgerPeerFactory,
): void {
  describe(`generic createLedger peer registry contract — ${factory.name}`, () => {
    for (const order of ["x-then-y", "y-then-x"] as const) {
      it(`preserves both peer ledgers after restart (${order})`, async () => {
        const fixture = await factory.build();
        await fixture.first.init();
        await fixture.second.init();
        try {
          if (order === "x-then-y") {
            await fixture.first.mutations.createLedger("xenos", X_SCHEMA);
            await fixture.second.mutations.createLedger("yttrium", Y_SCHEMA);
          } else {
            await fixture.first.mutations.createLedger("yttrium", Y_SCHEMA);
            await fixture.second.mutations.createLedger("xenos", X_SCHEMA);
          }
          await assertBothPersisted(fixture);
        } finally {
          await disposePeers(fixture);
        }
      });
    }

    it("preserves both peer ledgers after concurrent creation and restart", async () => {
      const fixture = await factory.build();
      await fixture.first.init();
      await fixture.second.init();
      try {
        await Promise.all([
          fixture.first.mutations.createLedger("xenos", X_SCHEMA),
          fixture.second.mutations.createLedger("yttrium", Y_SCHEMA),
        ]);
        await assertBothPersisted(fixture);
      } finally {
        await disposePeers(fixture);
      }
    });

    it("includes a newly discovered peer ledger in an archive sweep", async () => {
      const fixture = await factory.build();
      await fixture.first.init();
      await fixture.second.init();
      try {
        await fixture.first.mutations.createLedger("xenos", X_SCHEMA);
        const milestone = await fixture.first.mutations.createMilestone({
          title: "peer archive sweep",
        });
        const member = await fixture.first.mutations.createItem("xenos", milestone.id, {
          status: "done",
          fields: { title: "peer member" },
        });
        await fixture.first.mutations.updateMilestone(milestone.id, { status: "done" });

        // The second peer remains fully stale. Empty roots admit the outer call;
        // the native generic transaction must discover and sweep the new ledger.
        await fixture.second.mutations.archiveMilestone(milestone.id, "peer sweep");

        const reader = await fixture.openReader();
        try {
          await reader.init();
          const memberArchive = await reader.fetchArchive("xenos", milestone.id);
          expect(memberArchive.kind).toBe("group");
          if (memberArchive.kind === "group") {
            expect(memberArchive.milestone.items).toEqual([
              expect.objectContaining({ id: member.id }),
            ]);
          }
          const milestoneArchive = await reader.fetchArchive(
            MILESTONES_LEDGER,
            milestone.id,
          );
          expect(milestoneArchive.kind).toBe("item");
          if (milestoneArchive.kind === "item") {
            expect(milestoneArchive.item.id).toBe(milestone.id);
          }
        } finally {
          await reader.dispose();
        }
      } finally {
        await disposePeers(fixture);
      }
    });

    it("reindexes peer changes absorbed by an unrelated generic mutation", async () => {
      const fixture = await factory.build();
      await fixture.first.init();
      await fixture.second.init();
      try {
        const milestone = await fixture.first.mutations.createMilestone({
          title: "peer index reconciliation",
        });
        const task = await fixture.first.mutations.createItem(TASKS_LEDGER, milestone.id, {
          status: "planned",
          fields: { headline: "zqxoldalpha" },
        });
        await fixture.second.invalidate(MILESTONES_LEDGER);
        await fixture.second.invalidate(TASKS_LEDGER);
        expect(
          (await fixture.second.ftsSearch("zqxoldalpha"))
            .filter((hit) => hit.ledgerId === TASKS_LEDGER)
            .map((hit) => hit.item.id),
        ).toContain(task.id);
        await fixture.first.mutations.updateItem(TASKS_LEDGER, task.id, {
          fields: { headline: "vbwnewomega" },
        });

        await fixture.second.mutations.updateMilestone(milestone.id, {
          description: "trigger authoritative reconciliation",
        });

        expect(fixture.second.fetchItem(TASKS_LEDGER, task.id).fields.headline).toBe(
          "vbwnewomega",
        );
        expect(
          (await fixture.second.ftsSearch("vbwnewomega"))
            .filter((hit) => hit.ledgerId === TASKS_LEDGER)
            .map((hit) => hit.item.id),
        ).toContain(task.id);
        expect(
          (await fixture.second.ftsSearch("zqxoldalpha"))
            .filter((hit) => hit.ledgerId === TASKS_LEDGER)
            .map((hit) => hit.item.id),
        ).not.toContain(task.id);
      } finally {
        await disposePeers(fixture);
      }
    });
  });
}
