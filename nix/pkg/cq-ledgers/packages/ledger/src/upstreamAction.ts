/**
 * T807 — deterministic upstream action planning (no network).
 * Filing eligibility is ordinary+github only. Batch mode never files.
 */
import type { Item } from "./types.js";
import { UpstreamFilingClaimedError, UpstreamFinalizeTokenError } from "./types.js";
import { UPSTREAM_LEDGER } from "./constants.js";
import type { LedgerStore } from "./store/LedgerStore.js";

export const UPSTREAM_BATCH_LIMIT = 10;
export const UPSTREAM_RECHECK_STATUSES = new Set(["reported", "accepted", "fixed-upstream"]);

export type UpstreamEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "security" | "missing-classification" | "unsupported-tracker" };

export type UpstreamPreparePlan =
  | { readonly kind: "file"; readonly itemId: string }
  | { readonly kind: "recheck"; readonly itemIds: readonly string[] }
  | { readonly kind: "claimed"; readonly itemId: string; readonly operationId: string }
  | { readonly kind: "refused"; readonly reason: string; readonly itemId?: string };

function field(item: Item, name: string): string {
  const value = item.fields[name];
  return typeof value === "string" ? value : "";
}

export function classifyUpstreamEligibility(item: Item): UpstreamEligibility {
  const classification = field(item, "reportingClassification");
  if (classification === "") return { ok: false, reason: "missing-classification" };
  if (classification !== "ordinary") return { ok: false, reason: "security" };
  if (field(item, "trackerKind") !== "github") return { ok: false, reason: "unsupported-tracker" };
  return { ok: true };
}

export function selectUpstreamRecheckBatch(items: readonly Item[]): Item[] {
  const eligible = items.filter((item) => {
    if (!UPSTREAM_RECHECK_STATUSES.has(item.status)) return false;
    return classifyUpstreamEligibility(item).ok;
  });
  eligible.sort((a, b) => {
    const aChecked = field(a, "lastCheckedAt");
    const bChecked = field(b, "lastCheckedAt");
    if (aChecked === "" && bChecked !== "") return -1;
    if (aChecked !== "" && bChecked === "") return 1;
    if (aChecked !== bChecked) return aChecked < bChecked ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return eligible.slice(0, UPSTREAM_BATCH_LIMIT);
}

export function planExplicitPrepare(item: Item): UpstreamPreparePlan {
  const eligibility = classifyUpstreamEligibility(item);
  if (!eligibility.ok) {
    return { kind: "refused", reason: eligibility.reason, itemId: item.id };
  }
  const existing = field(item, "filingOperationId");
  if (existing !== "") {
    return { kind: "claimed", itemId: item.id, operationId: existing };
  }
  if (item.status === "open") return { kind: "file", itemId: item.id };
  if (UPSTREAM_RECHECK_STATUSES.has(item.status)) {
    return { kind: "recheck", itemIds: [item.id] };
  }
  return { kind: "refused", reason: "illegal-status", itemId: item.id };
}

export async function claimUpstreamFiling(
  store: LedgerStore,
  itemId: string,
  operationId: string,
  claimedAt: string,
): Promise<Item> {
  try {
    return await store.updateItem(UPSTREAM_LEDGER, itemId, {
      fields: {
        filingOperationId: operationId,
        filingState: "claimed",
        filingClaimedAt: claimedAt,
      },
    });
  } catch (error) {
    if (error instanceof UpstreamFilingClaimedError) throw error;
    throw error;
  }
}

export type UpstreamObservation =
  | { readonly kind: "bookkeeping"; readonly outcome: string; readonly checkedAt: string }
  | { readonly kind: "confirmed-url"; readonly url: string; readonly checkedAt: string }
  | { readonly kind: "confirmed-release"; readonly checkedAt: string; readonly fixedVersion?: string }
  | { readonly kind: "unknown-submission"; readonly checkedAt: string }
  | { readonly kind: "wontfix"; readonly checkedAt: string };

export async function finalizeUpstreamAction(
  store: LedgerStore,
  itemId: string,
  observation: UpstreamObservation,
  operationId?: string,
): Promise<Item> {
  const item = store.fetchItem(UPSTREAM_LEDGER, itemId);
  const claimed = field(item, "filingOperationId");
  if (claimed !== "") {
    if (operationId === undefined || operationId !== claimed) {
      throw new UpstreamFinalizeTokenError(itemId);
    }
  }
  const fields: Record<string, string | string[]> = {
    lastCheckedAt: observation.checkedAt,
    lastCheckOutcome: observation.kind,
  };
  let status: string | undefined;
  if (observation.kind === "bookkeeping") {
    fields.lastCheckOutcome = observation.outcome;
  } else if (observation.kind === "confirmed-url") {
    const existing = item.fields["reportUrls"];
    const urls = Array.isArray(existing) ? [...existing] : [];
    if (!urls.includes(observation.url)) urls.push(observation.url);
    fields.reportUrls = urls;
    fields.trackingUrl = observation.url;
    fields.filingState = "filed";
    if (item.status === "open") status = "reported";
  } else if (observation.kind === "confirmed-release") {
    if (observation.fixedVersion !== undefined) fields.fixedVersion = observation.fixedVersion;
    if (item.status === "fixed-upstream" || item.status === "accepted" || item.status === "reported") {
      status = "released";
    }
    fields.filingState = "filed";
  } else if (observation.kind === "unknown-submission") {
    fields.filingState = "reconciliation-required";
  } else if (observation.kind === "wontfix") {
    if (item.status !== "released" && item.status !== "wontfix") status = "wontfix";
  }
  return store.updateItem(UPSTREAM_LEDGER, itemId, {
    ...(status === undefined ? {} : { status }),
    fields,
  });
}
