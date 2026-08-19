/**
 * T823/T824 — orchestrator intake for upstream findings.
 * Creates ordinary records on the public upstream ledger. No HTTP.
 */
import { MILESTONES_AMBIENT_ID, UPSTREAM_LEDGER } from "./constants.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import type { Item } from "./types.js";

export interface UpstreamIssueRecord {
  readonly headline: string;
  readonly package: string;
  readonly reportingClassification: "ordinary" | "security-sensitive" | "uncertain";
  readonly trackerKind?: string;
  readonly sourceRefs?: readonly string[];
}

export async function recordUpstreamIssues(
  store: LedgerStore,
  records: readonly UpstreamIssueRecord[],
  milestoneId: string = MILESTONES_AMBIENT_ID,
): Promise<Item[]> {
  const created: Item[] = [];
  for (const record of records) {
    created.push(
      await store.createItem(UPSTREAM_LEDGER, milestoneId, {
        status: "open",
        fields: {
          headline: record.headline,
          package: record.package,
          reportingClassification: record.reportingClassification,
          ...(record.trackerKind === undefined ? {} : { trackerKind: record.trackerKind }),
          ...(record.sourceRefs === undefined ? {} : { sourceRefs: [...record.sourceRefs] }),
        },
      }),
    );
  }
  return created;
}
