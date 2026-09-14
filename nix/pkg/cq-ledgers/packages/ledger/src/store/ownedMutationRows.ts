import { GOALS_LEDGER } from "../constants.js";
import type { Item, Ledger } from "../types.js";
import { WorksetOwnedLifecycleError, type AdmittedOwnedMutation } from "../worksetOwnedLifecycle.js";

export function assertOwnedMutationRows(context: AdmittedOwnedMutation, before: ReadonlyMap<string, Ledger>,
  changedItems: readonly { readonly ledgerId: string; readonly item: Item }[]): void {
  const operation = context.operation;
  const ledgerId = operation.kind === "create-owned" ? operation.input.child.ledgerId
    : operation.kind === "create-ownerless" ? operation.input.ledgerId : GOALS_LEDGER;
  const ownerRef = context.admission.targets[0];
  let created = 0;
  for (const row of changedItems) {
    const prior = before.get(row.ledgerId)?.milestones.flatMap(({ items }) => items).find(({ id }) => id === row.item.id);
    if (prior === undefined) {
      created += 1;
      if (row.ledgerId !== ledgerId || row.item.fields.worksetOwnerRef !== ownerRef) {
        throw new WorksetOwnedLifecycleError("forged-ownership", "owned transaction created a row outside its requested owner/ledger");
      }
    } else if (operation.kind !== "idea-to-goal" || operation.input.consumeIdea !== true || `${row.ledgerId}:${row.item.id}` !== ownerRef) {
      throw new WorksetOwnedLifecycleError("owner-excluded", "owned transaction changed an existing row outside its declared operation");
    }
  }
  if (created > 1) throw new WorksetOwnedLifecycleError("bundle-incomplete", "owned transaction exceeded its declared single-child operation");
}
