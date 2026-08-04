import type { FieldValue, FetchedLedger, Item } from "../types.js";
import type { FtsSearchHit } from "../search/LedgerSearchIndex.js";
import type { FetchedMilestoneItem } from "../store/LedgerStore.js";
import type { LedgerToolName } from "./ledgerTools.js";

const PRODUCED_WIRE_DTO = Symbol("cq.producedWireDto");

export type ProducedWireDto<T extends object> = T & {
  readonly [PRODUCED_WIRE_DTO]: true;
};

export type ItemProjection = "compact" | "full";

export const COMPACT_ITEM_FIELD_NAMES = [
  "headline",
  "title",
  "question",
  "summary",
  "severity",
  "suggestedModel",
  "tags",
  "sourceRefs",
  "dependsOn",
  "blockedBy",
  "ledgerRefs",
] as const;

export const ITEM_PROJECTION_DESCRIPTION =
  "required projection: compact retains id, milestoneId, status, createdAt, updatedAt, optional author/session, and only headline/title/question/summary/severity/suggestedModel/tags/sourceRefs/dependsOn/blockedBy/ledgerRefs in fields; full retains every item field";

export const ITEM_MUTATION_ACK_DESCRIPTION =
  "Returns fixed acknowledgement { item: { id, milestoneId, status, fields: { dependsOn?, blockedBy?, ledgerRefs? }, createdAt, updatedAt, author?, session? } }; narrative fields are not returned.";

export const MILESTONE_MUTATION_ACK_DESCRIPTION =
  "Returns fixed acknowledgement { milestone: { id, status, fields: { dependsOn?, blockedBy? }, createdAt, updatedAt, author?, session? } }; title and description are not returned.";

export const LEDGER_MUTATION_ACK_DESCRIPTION =
  "Returns fixed acknowledgement { ledger: { id } }; the schema and items are not returned.";

export const GET_REVIEWERS_SECTION_RESPONSE_DESCRIPTION =
  "{ configured, reviewers: [{ harness, model, provider, alias, effort }] }";

export const GET_PLANNERS_SECTION_RESPONSE_DESCRIPTION =
  "{ configured, planners: [{ harness, model, provider, alias, effort }] }";

export type CompactItemFieldName = (typeof COMPACT_ITEM_FIELD_NAMES)[number];

export type CompactItemFieldsDto = Partial<Record<CompactItemFieldName, FieldValue>>;

export interface CompactItemDto {
  id: string;
  milestoneId: string;
  status: string;
  fields: CompactItemFieldsDto;
  createdAt: string;
  updatedAt: string;
  author?: string;
  session?: string;
}

export type FullItemDto = Item;

export type ItemDto = CompactItemDto | FullItemDto;

export type FetchedLedgerDto = Omit<FetchedLedger, "milestones"> & {
  milestones: Array<
    Omit<FetchedLedger["milestones"][number], "items"> & {
      items: ItemDto[];
    }
  >;
};

export interface PaginatedLedgerDto {
  ledger: Omit<FetchedLedger, "milestones">;
  items: ItemDto[];
  total: number;
  offset: number;
  limit: number | null;
  nextOffset: number | null;
}

export type FtsSearchResultDto = Omit<FtsSearchHit, "item"> & {
  item: ItemDto;
};

export type FetchedMilestoneDto = Omit<FetchedMilestoneItem, "milestone"> & {
  milestone: ItemDto;
};

export type MilestoneItemGroupsDto = Record<string, ItemDto[]>;

export interface ItemReferenceFieldsDto {
  dependsOn?: string[];
  blockedBy?: string[];
  ledgerRefs?: string[];
}

export interface MilestoneReferenceFieldsDto {
  dependsOn?: string[];
  blockedBy?: string[];
}

export interface ItemMutationAckDto {
  id: string;
  milestoneId: string;
  status: string;
  fields: ItemReferenceFieldsDto;
  createdAt: string;
  updatedAt: string;
  author?: string;
  session?: string;
}

export interface LedgerMutationAckDto {
  id: string;
}

export interface MilestoneMutationAckDto {
  id: string;
  status: string;
  fields: MilestoneReferenceFieldsDto;
  createdAt: string;
  updatedAt: string;
  author?: string;
  session?: string;
}

export interface MandatoryItemProjectionContract {
  readonly kind: "mandatory-item-projection";
  readonly projections: readonly ["compact", "full"];
  readonly responseDescription: string;
  readonly responseCell: string;
}

export interface FixedAcknowledgementContract {
  readonly kind: "fixed-acknowledgement";
  readonly acknowledgement: "item" | "ledger" | "milestone";
  readonly responseDescription: string;
  readonly responseCell: string;
}

export interface PurposeBuiltSmallContract {
  readonly kind: "purpose-built-small";
  readonly responseDescription: string;
  readonly responseCell: string;
}

export interface RequestedFullContentContract {
  readonly kind: "requested-full-content";
  readonly responseDescription: string;
  readonly responseCell: string;
}

export type LedgerResponseContract =
  | MandatoryItemProjectionContract
  | FixedAcknowledgementContract
  | PurposeBuiltSmallContract
  | RequestedFullContentContract;

function mandatoryItemProjection(responseCell: string): MandatoryItemProjectionContract {
  return {
    kind: "mandatory-item-projection",
    projections: ["compact", "full"],
    responseDescription: `${responseCell} ${ITEM_PROJECTION_DESCRIPTION}.`,
    responseCell,
  };
}

function fixedAcknowledgement(
  acknowledgement: FixedAcknowledgementContract["acknowledgement"],
  responseDescription: string,
  responseCell: string,
): FixedAcknowledgementContract {
  return {
    kind: "fixed-acknowledgement",
    acknowledgement,
    responseDescription,
    responseCell,
  };
}

function purposeBuiltSmall(responseCell: string): PurposeBuiltSmallContract {
  return {
    kind: "purpose-built-small",
    responseDescription: responseCell,
    responseCell,
  };
}

function requestedFullContent(responseCell: string): RequestedFullContentContract {
  return {
    kind: "requested-full-content",
    responseDescription: responseCell,
    responseCell,
  };
}

export const LEDGER_RESPONSE_CONTRACTS = {
  enumerate_ledgers: purposeBuiltSmall(
    "`{ ledgers, counts, ledgerSummaries: [{ name, itemCount, statusCounts, completedCount, progressTotal }] }`",
  ),
  fetch_ledger: mandatoryItemProjection(
    "Grouped `{ ledger }`, or paginated `{ ledger, items, total, offset, limit, nextOffset }`; every item uses the requested projection.",
  ),
  fetch_ledger_archive: requestedFullContent(
    "`{ archive }` with the requested archived item or milestone group in full.",
  ),
  fetch_item: mandatoryItemProjection(
    "Ordinary ledgers return `{ item }`; the `milestones` ledger returns `{ item, resolved, references }`. `item` uses the requested projection.",
  ),
  update_item: fixedAcknowledgement(
    "item",
    ITEM_MUTATION_ACK_DESCRIPTION,
    "`{ item: ItemAcknowledgement }`.",
  ),
  create_item: fixedAcknowledgement(
    "item",
    ITEM_MUTATION_ACK_DESCRIPTION,
    "`{ item: ItemAcknowledgement }`.",
  ),
  create_ledger: fixedAcknowledgement(
    "ledger",
    LEDGER_MUTATION_ACK_DESCRIPTION,
    "`{ ledger: { id } }`.",
  ),
  search_items: mandatoryItemProjection("`{ items }` using the requested projection."),
  fts_search: mandatoryItemProjection(
    "`{ results: [{ ledgerId, item, score, matchedFields }] }`; each item uses the requested projection.",
  ),
  archive_milestone: purposeBuiltSmall("`{ pointer }` for the archived milestone."),
  list_milestone_items: mandatoryItemProjection(
    "`{ items: Record<ledgerId, Item[]> }`; every item uses the requested projection.",
  ),
  snapshot: purposeBuiltSmall(
    "`{ ledger: Record<ledgerId, Record<status, { count, items: [{ id, status, summary }] }>> }`.",
  ),
  derive_predicates: purposeBuiltSmall(
    "Predicate verdicts `{ value, items }` for `pInvestigate`, `pSeed`, `pPlan`, `pResearch`, `pImplement`, `openQuestionGate`, `belowFloor`, `planBusy`, and `goalDrift`.",
  ),
  reopen_item: fixedAcknowledgement(
    "item",
    ITEM_MUTATION_ACK_DESCRIPTION,
    "`{ item: ItemAcknowledgement }`.",
  ),
  unarchive_item: fixedAcknowledgement(
    "item",
    ITEM_MUTATION_ACK_DESCRIPTION,
    "`{ item: ItemAcknowledgement }`.",
  ),
  read_log: requestedFullContent("`{ path, content, truncated? }`."),
  get_config: requestedFullContent(
    "The payload selected by `section`; no unrelated section is returned.",
  ),
  get_usage_stats: purposeBuiltSmall(
    "`{ endpoints: [{ name, callCount, bytesIn, bytesOut }], totals: { callCount, bytesIn, bytesOut } }`",
  ),
  prepare_dispatch: purposeBuiltSmall(
    "`{ accepted, prepared, handle, executedStepOrder }` or a typed pre-launch rejection.",
  ),
  fetch_dispatch_input: requestedFullContent(
    "The prepare-bound typed input on its first capability-authorized retrieval.",
  ),
  store_result: purposeBuiltSmall("A handle-only stored-result acknowledgement or typed abort."),
  confirm_dispatch_completion: purposeBuiltSmall(
    "A handle-only consumed acknowledgement or typed abort.",
  ),
  abort_dispatch: purposeBuiltSmall("A typed aborted acknowledgement."),
  fetch_dispatch_result: requestedFullContent(
    "One typed fetch state; only the first consumed fetch can carry `output`.",
  ),
  fetch_prompt: requestedFullContent(
    "Full typed prompt entry under the default `projection: \"full\"`, including prompt text and schemas when available; `projection: \"schema\"` returns exactly `{ roleId, version?, inputSchema?, outputSchema? }` — `{ roleId }` alone for an orchestrator-command role (schema keys ABSENT, never null).",
  ),
  list_projects: purposeBuiltSmall("`{ projects: [{ key, displayName, createdAt? }] }`."),
  claim_plan: purposeBuiltSmall(
    "`{ ok: true, replayed, acknowledgement }` — the ONLY response that echoes " +
      "`ownerFenceToken`, and only back to the winning or exactly-retried " +
      "claimant — or `{ ok: false, conflict }` carrying public claim metadata only.",
  ),
  publish_plan_draft: purposeBuiltSmall(
    "`{ ok: true, replayed, acknowledgement: { …operation key, manifest, " +
      "replacedManifest, reviewDefects } }` or `{ ok: false, conflict }`; never " +
      "carries `ownerFenceToken`.",
  ),
  release_plan_claim: purposeBuiltSmall(
    "`{ ok: true, replayed, acknowledgement: { kind, …operation key, questions, " +
      "researches, waitingResearches, reviewDefects, goalPhase } }` or " +
      "`{ ok: false, conflict }`; never carries `ownerFenceToken`.",
  ),
  finalize_plan: purposeBuiltSmall(
    "`{ ok: true, replayed, acknowledgement: { …operation key, reviewId, draft, " +
      "decisionId, manifest, reviewDefects, goalPhase } }` or " +
      "`{ ok: false, conflict }`; never carries `ownerFenceToken`.",
  ),
} as const satisfies Record<LedgerToolName, LedgerResponseContract>;

export function appendLedgerResponseDescription(
  toolName: LedgerToolName,
  description: string,
): string {
  return `${description}\n\nAuthoritative response: ${LEDGER_RESPONSE_CONTRACTS[toolName].responseDescription}`;
}

const ITEM_REFERENCE_FIELD_NAMES = ["dependsOn", "blockedBy", "ledgerRefs"] as const;

const MILESTONE_REFERENCE_FIELD_NAMES = ["dependsOn", "blockedBy"] as const;

function markProduced<T extends object>(value: T): ProducedWireDto<T> {
  Object.defineProperty(value, PRODUCED_WIRE_DTO, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value as ProducedWireDto<T>;
}

export function isProducedWireDto(value: unknown): value is ProducedWireDto<object> {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, PRODUCED_WIRE_DTO) === true
  );
}

export function produceWireDto<T extends object>(value: T): ProducedWireDto<T> {
  const copy = Array.isArray(value) ? [...value] : { ...value };
  return markProduced(copy as T);
}

function projectIntrinsicItem(
  item: Item,
  fields: CompactItemFieldsDto,
): ProducedWireDto<CompactItemDto> {
  const projected: CompactItemDto = {
    id: item.id,
    milestoneId: item.milestoneId,
    status: item.status,
    fields,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.author !== undefined) projected.author = item.author;
  if (item.session !== undefined) projected.session = item.session;
  return markProduced(projected);
}

export function projectCompactItemDto(item: Item): ProducedWireDto<CompactItemDto> {
  const fields: CompactItemFieldsDto = {};
  for (const name of COMPACT_ITEM_FIELD_NAMES) {
    const value = item.fields[name];
    if (value !== undefined) fields[name] = value;
  }
  return projectIntrinsicItem(item, fields);
}

export function projectFullItemDto(item: Item): ProducedWireDto<FullItemDto> {
  return markProduced({
    ...item,
    fields: { ...item.fields },
  });
}

export function projectItemDto(
  item: Item,
  projection: ItemProjection,
): ProducedWireDto<CompactItemDto> | ProducedWireDto<FullItemDto> {
  switch (projection) {
    case "compact":
      return projectCompactItemDto(item);
    case "full":
      return projectFullItemDto(item);
  }
}

export function projectFetchedLedgerDto(
  ledger: FetchedLedger,
  projection: ItemProjection,
): ProducedWireDto<FetchedLedgerDto> {
  return markProduced({
    ...ledger,
    milestones: ledger.milestones.map((group) => ({
      ...group,
      items: group.items.map((item) => projectItemDto(item, projection)),
    })),
  });
}

export function projectPaginatedLedgerDto(
  response: {
    ledger: Omit<FetchedLedger, "milestones">;
    items: Item[];
    total: number;
    offset: number;
    limit: number | null;
    nextOffset: number | null;
  },
  projection: ItemProjection,
): ProducedWireDto<PaginatedLedgerDto> {
  return markProduced({
    ...response,
    items: response.items.map((item) => projectItemDto(item, projection)),
  });
}

export function projectFtsSearchResultsDto(
  hits: FtsSearchHit[],
  projection: ItemProjection,
): ProducedWireDto<FtsSearchResultDto[]> {
  return markProduced(
    hits.map((hit) => ({
      ...hit,
      item: projectItemDto(hit.item, projection),
    })),
  );
}

export function projectFetchedMilestoneDto(
  fetched: FetchedMilestoneItem,
  projection: ItemProjection,
): ProducedWireDto<FetchedMilestoneDto> {
  return markProduced({
    ...fetched,
    milestone: projectItemDto(fetched.milestone, projection),
  });
}

export function projectMilestoneItemGroupsDto(
  groups: Record<string, Item[]>,
  projection: ItemProjection,
): ProducedWireDto<MilestoneItemGroupsDto> {
  return markProduced(
    Object.fromEntries(
      Object.entries(groups).map(([ledgerId, items]) => [
        ledgerId,
        items.map((item) => projectItemDto(item, projection)),
      ]),
    ),
  );
}

type ReferenceFieldName = keyof ItemReferenceFieldsDto;

function projectReferenceFields(
  item: Item,
  names: readonly ReferenceFieldName[],
): ItemReferenceFieldsDto {
  const fields: ItemReferenceFieldsDto = {};
  for (const name of names) {
    const value = item.fields[name];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new TypeError(`Reference field ${name} must contain a string array`);
    }
    fields[name] = value;
  }
  return fields;
}

export function projectItemMutationAckDto(item: Item): ProducedWireDto<ItemMutationAckDto> {
  const projected: ItemMutationAckDto = {
    id: item.id,
    milestoneId: item.milestoneId,
    status: item.status,
    fields: projectReferenceFields(item, ITEM_REFERENCE_FIELD_NAMES),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.author !== undefined) projected.author = item.author;
  if (item.session !== undefined) projected.session = item.session;
  return markProduced(projected);
}

export function projectLedgerMutationAckDto(
  ledger: FetchedLedger,
): ProducedWireDto<LedgerMutationAckDto> {
  return markProduced({ id: ledger.id });
}

export function projectMilestoneMutationAckDto(
  milestone: Item,
): ProducedWireDto<MilestoneMutationAckDto> {
  const projected: MilestoneMutationAckDto = {
    id: milestone.id,
    status: milestone.status,
    fields: projectReferenceFields(milestone, MILESTONE_REFERENCE_FIELD_NAMES),
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt,
  };
  if (milestone.author !== undefined) projected.author = milestone.author;
  if (milestone.session !== undefined) projected.session = milestone.session;
  return markProduced(projected);
}

export function serializeWireDto(value: ProducedWireDto<object>): string {
  if (!isProducedWireDto(value)) {
    throw new TypeError("serializeWireDto requires a produced wire DTO");
  }
  return JSON.stringify(value);
}
