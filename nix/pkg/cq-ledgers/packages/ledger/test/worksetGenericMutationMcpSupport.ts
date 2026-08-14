import {
  InMemoryLedgerStore,
  TASKS_LEDGER,
  type LedgerSchema,
} from "../src/index.js";

export const CUSTOM_LEDGER_SCHEMA: LedgerSchema = {
  idPrefix: "X",
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { headline: { type: "string", required: true } },
};

export const EXCLUDED_GENERIC_MUTATION_CASES = [
  {
    tool: "update_item",
    input: {
      ledger_id: TASKS_LEDGER,
      item_id: "T1",
      fields: { headline: "Excluded update" },
      author: "t1982",
      session: "t1982-transport",
    },
    code: "target-excluded",
  },
  {
    tool: "update_item",
    input: {
      ledger_id: "milestones",
      item_id: "M2",
      fields: { title: "Excluded milestone update" },
      author: "t1982",
      session: "t1982-transport",
    },
    code: "target-excluded",
  },
  {
    tool: "create_item",
    input: {
      ledger_id: TASKS_LEDGER,
      milestone_id: "M1",
      id: "T99",
      status: "planned",
      fields: { headline: "Excluded create" },
      author: "t1982",
      session: "t1982-transport",
    },
    code: "creation-denied",
  },
  {
    tool: "create_item",
    input: {
      ledger_id: "milestones",
      id: "M99",
      status: "open",
      fields: { title: "Excluded milestone create" },
      author: "t1982",
      session: "t1982-transport",
    },
    code: "creation-denied",
  },
  {
    tool: "create_ledger",
    input: { name: "excludedCustom", schema: CUSTOM_LEDGER_SCHEMA },
    code: "create-ledger-denied",
  },
  {
    tool: "archive_milestone",
    input: { milestone_id: "M2", summary: "Excluded archive" },
    code: "archive-sweep-incomplete",
  },
  {
    tool: "reopen_item",
    input: { ledger_id: TASKS_LEDGER, item_id: "T3", to_status: "planned" },
    code: "target-excluded",
  },
  {
    tool: "unarchive_item",
    input: { ledger_id: TASKS_LEDGER, milestone_id: "M3", item_id: "T5" },
    code: "unarchive-not-exact-inactive-root",
  },
] as const;

export async function seedExcludedGenericMutationStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  for (const milestoneId of ["M1", "M2", "M3"] as const) {
    await store.createMilestone({ id: milestoneId, title: milestoneId });
  }
  for (const [itemId, milestoneId, status] of [
    ["T1", "M1", "planned"],
    ["T2", "M1", "planned"],
    ["T3", "M1", "done"],
    ["T4", "M2", "done"],
    ["T5", "M3", "done"],
  ] as const) {
    await store.createItem(TASKS_LEDGER, milestoneId, {
      id: itemId,
      status,
      fields: { headline: itemId },
      author: "t1982",
      session: "t1982-transport",
    });
  }
  await store.updateMilestone("M2", { status: "done" });
  await store.updateMilestone("M3", { status: "done" });
  await store.archiveMilestone("M3", "seed archived item");
  await store.worksetStore().setRoots(["tasks:T2"]);
  return store;
}

export function genericStoreBytes(store: InMemoryLedgerStore): string {
  return JSON.stringify(
    store.enumerate().sort().map((ledgerId) => store.fetch(ledgerId)),
  );
}

export function textPayload(result: unknown): string {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("generic mutation transport returned no text payload");
  }
  return first.text;
}
