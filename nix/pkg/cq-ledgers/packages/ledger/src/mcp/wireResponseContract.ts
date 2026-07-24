import type {
  FieldValue,
  FetchedLedger,
  Item,
  Ledger,
} from "../types.js";
import type { FtsSearchHit } from "../search/LedgerSearchIndex.js";
import type { FetchedMilestoneItem } from "../store/LedgerStore.js";
import type { LedgerToolName } from "./ledgerTools.js";

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

export type CompactItemFieldName =
  (typeof COMPACT_ITEM_FIELD_NAMES)[number];

export type CompactItemFieldsDto = Partial<
  Record<CompactItemFieldName, FieldValue>
>;

declare const compactItemDtoBrand: unique symbol;

export interface CompactItemDto {
  readonly [compactItemDtoBrand]: "CompactItemDto";
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
}

export type FtsSearchResultDto = Omit<FtsSearchHit, "item"> & {
  item: ItemDto;
};

export type FetchedMilestoneDto = Omit<
  FetchedMilestoneItem,
  "milestone"
> & {
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

declare const itemMutationAckDtoBrand: unique symbol;

export interface ItemMutationAckDto {
  readonly [itemMutationAckDtoBrand]: "ItemMutationAckDto";
  id: string;
  milestoneId: string;
  status: string;
  fields: ItemReferenceFieldsDto;
  createdAt: string;
  updatedAt: string;
  author?: string;
  session?: string;
}

declare const ledgerMutationAckDtoBrand: unique symbol;

export interface LedgerMutationAckDto {
  readonly [ledgerMutationAckDtoBrand]: "LedgerMutationAckDto";
  id: string;
}

declare const milestoneMutationAckDtoBrand: unique symbol;

export interface MilestoneMutationAckDto {
  readonly [milestoneMutationAckDtoBrand]: "MilestoneMutationAckDto";
  id: string;
  status: string;
  fields: MilestoneReferenceFieldsDto;
  createdAt: string;
  updatedAt: string;
}

export interface MandatoryItemProjectionContract {
  kind: "mandatory-item-projection";
  projections: readonly ["compact", "full"];
}

export interface FixedAcknowledgementContract {
  kind: "fixed-acknowledgement";
  acknowledgement: "item" | "ledger" | "milestone";
}

export interface PurposeBuiltSmallContract {
  kind: "purpose-built-small";
}

export interface RequestedFullContentContract {
  kind: "requested-full-content";
}

export type LedgerResponseContract =
  | MandatoryItemProjectionContract
  | FixedAcknowledgementContract
  | PurposeBuiltSmallContract
  | RequestedFullContentContract;

const MANDATORY_ITEM_PROJECTION = {
  kind: "mandatory-item-projection",
  projections: ["compact", "full"],
} as const satisfies MandatoryItemProjectionContract;

export const LEDGER_RESPONSE_CONTRACTS = {
  enumerate_ledgers: { kind: "purpose-built-small" },
  fetch_ledger: MANDATORY_ITEM_PROJECTION,
  fetch_ledger_archive: { kind: "requested-full-content" },
  fetch_item: MANDATORY_ITEM_PROJECTION,
  update_item: {
    kind: "fixed-acknowledgement",
    acknowledgement: "item",
  },
  create_item: {
    kind: "fixed-acknowledgement",
    acknowledgement: "item",
  },
  create_ledger: {
    kind: "fixed-acknowledgement",
    acknowledgement: "ledger",
  },
  search_items: MANDATORY_ITEM_PROJECTION,
  fts_search: MANDATORY_ITEM_PROJECTION,
  create_milestone: {
    kind: "fixed-acknowledgement",
    acknowledgement: "milestone",
  },
  update_milestone: {
    kind: "fixed-acknowledgement",
    acknowledgement: "milestone",
  },
  fetch_milestone: MANDATORY_ITEM_PROJECTION,
  archive_milestone: { kind: "purpose-built-small" },
  list_milestone_items: MANDATORY_ITEM_PROJECTION,
  snapshot: { kind: "purpose-built-small" },
  derive_predicates: { kind: "purpose-built-small" },
  reopen_item: {
    kind: "fixed-acknowledgement",
    acknowledgement: "item",
  },
  unarchive_item: {
    kind: "fixed-acknowledgement",
    acknowledgement: "item",
  },
  read_log: { kind: "requested-full-content" },
  get_reviewers: { kind: "purpose-built-small" },
  get_planners: { kind: "purpose-built-small" },
  get_config: { kind: "requested-full-content" },
  get_agent_models: { kind: "purpose-built-small" },
  fetch_prompt: { kind: "requested-full-content" },
  validate_input: { kind: "purpose-built-small" },
  validate_output: { kind: "purpose-built-small" },
  list_projects: { kind: "purpose-built-small" },
} as const satisfies Record<LedgerToolName, LedgerResponseContract>;

const COMPACT_ITEM_FIELD_SET: ReadonlySet<string> = new Set(
  COMPACT_ITEM_FIELD_NAMES,
);

const ITEM_REFERENCE_FIELD_NAMES = [
  "dependsOn",
  "blockedBy",
  "ledgerRefs",
] as const;

const MILESTONE_REFERENCE_FIELD_NAMES = [
  "dependsOn",
  "blockedBy",
] as const;

function projectIntrinsicItem(
  item: Item,
  fields: CompactItemFieldsDto,
): CompactItemDto {
  const projected = {
    id: item.id,
    milestoneId: item.milestoneId,
    status: item.status,
    fields,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  } as CompactItemDto;
  if (item.author !== undefined) projected.author = item.author;
  if (item.session !== undefined) projected.session = item.session;
  return projected;
}

export function projectCompactItemDto(item: Item): CompactItemDto {
  const fields: CompactItemFieldsDto = {};
  for (const [name, value] of Object.entries(item.fields)) {
    if (COMPACT_ITEM_FIELD_SET.has(name)) {
      fields[name as CompactItemFieldName] = value;
    }
  }
  return projectIntrinsicItem(item, fields);
}

export function projectFullItemDto(item: Item): FullItemDto {
  return item;
}

export function projectItemDto(
  item: Item,
  projection: ItemProjection,
): CompactItemDto | FullItemDto {
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
): FetchedLedgerDto {
  return {
    ...ledger,
    milestones: ledger.milestones.map((group) => ({
      ...group,
      items: group.items.map((item) => projectItemDto(item, projection)),
    })),
  };
}

export function projectPaginatedLedgerDto(
  response: {
    ledger: Omit<FetchedLedger, "milestones">;
    items: Item[];
    total: number;
  },
  projection: ItemProjection,
): PaginatedLedgerDto {
  return {
    ...response,
    items: response.items.map((item) => projectItemDto(item, projection)),
  };
}

export function projectFtsSearchResultsDto(
  hits: FtsSearchHit[],
  projection: ItemProjection,
): FtsSearchResultDto[] {
  return hits.map((hit) => ({
    ...hit,
    item: projectItemDto(hit.item, projection),
  }));
}

export function projectFetchedMilestoneDto(
  fetched: FetchedMilestoneItem,
  projection: ItemProjection,
): FetchedMilestoneDto {
  return {
    ...fetched,
    milestone: projectItemDto(fetched.milestone, projection),
  };
}

export function projectMilestoneItemGroupsDto(
  groups: Record<string, Item[]>,
  projection: ItemProjection,
): MilestoneItemGroupsDto {
  return Object.fromEntries(
    Object.entries(groups).map(([ledgerId, items]) => [
      ledgerId,
      items.map((item) => projectItemDto(item, projection)),
    ]),
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

export function projectItemMutationAckDto(
  item: Item,
): ItemMutationAckDto {
  const projected = {
    id: item.id,
    milestoneId: item.milestoneId,
    status: item.status,
    fields: projectReferenceFields(item, ITEM_REFERENCE_FIELD_NAMES),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  } as ItemMutationAckDto;
  if (item.author !== undefined) projected.author = item.author;
  if (item.session !== undefined) projected.session = item.session;
  return projected;
}

export function projectLedgerMutationAckDto(
  ledger: Ledger,
): LedgerMutationAckDto {
  return { id: ledger.id } as LedgerMutationAckDto;
}

export function projectMilestoneMutationAckDto(
  milestone: Item,
): MilestoneMutationAckDto {
  return {
    id: milestone.id,
    status: milestone.status,
    fields: projectReferenceFields(
      milestone,
      MILESTONE_REFERENCE_FIELD_NAMES,
    ),
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt,
  } as MilestoneMutationAckDto;
}

export function serializeWireDto(value: unknown): string {
  return JSON.stringify(value);
}
