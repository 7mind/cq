import { z } from "zod";
import type { FieldValue, FetchedLedger, Item } from "../types.js";
import type { FtsSearchHit } from "../search/LedgerSearchIndex.js";
import type { FetchedMilestoneItem } from "../store/LedgerStore.js";
import type { LedgerToolName } from "./ledgerTools.js";

const PRODUCED_WIRE_DTO = Symbol("cq.producedWireDto");

export type ProducedWireDto<T extends object> = T & {
  readonly [PRODUCED_WIRE_DTO]: true;
};

export const ITEM_PROJECTION_SCHEMA = z.enum(["compact", "full", "complement"]);
export type ItemProjection = z.infer<typeof ITEM_PROJECTION_SCHEMA>;

export const COMPACT_ITEM_FIELD_NAMES = [
  "headline",
  "title",
  "question",
  "answer",
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
  "required compact|full|complement; compact.fields ⊎ complement.fields = full.fields";

export const ITEM_MUTATION_ACK_DESCRIPTION =
  "Fixed {item:{id,milestoneId,status,fields:{dependsOn?,blockedBy?,ledgerRefs?},createdAt, updatedAt,author?,session?}}; no narrative.";

export const MILESTONE_MUTATION_ACK_DESCRIPTION =
  "Fixed {milestone:{id,status,fields:{dependsOn?,blockedBy?},createdAt, updatedAt,author?,session?}}; no title/description.";

export const LEDGER_MUTATION_ACK_DESCRIPTION =
  "Fixed {ledger:{id}}; no schema/items.";

export const GET_REVIEWERS_SECTION_RESPONSE_DESCRIPTION =
  "{ configured, reviewers: [{ harness, model, provider, alias, effort }] }";

export const GET_PLANNERS_SECTION_RESPONSE_DESCRIPTION =
  "{ configured, planners: [{ harness, model, provider, alias, effort }] }";

export type CompactItemFieldName = (typeof COMPACT_ITEM_FIELD_NAMES)[number];

const COMPACT_ITEM_FIELD_NAME_SET: ReadonlySet<string> = new Set(COMPACT_ITEM_FIELD_NAMES);

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

/** Join identity + non-compact field keys only (T1422 / G139). */
export interface ComplementItemDto {
  id: string;
  fields: Record<string, FieldValue>;
}

export type FullItemDto = Item;

export type ItemDto = CompactItemDto | FullItemDto | ComplementItemDto;

export type FetchedLedgerDto = Omit<FetchedLedger, "milestones"> & {
  milestones: Array<
    Omit<FetchedLedger["milestones"][number], "items"> & {
      items: ItemDto[];
    }
  >;
};

/** A paginated page never carries the unbounded archive pointer list (D551). */
export type PaginatedLedgerMetaDto = Omit<FetchedLedger, "milestones" | "archivePointers"> & {
  archivePointerCount: number;
};

export interface PaginatedLedgerDto {
  ledger: PaginatedLedgerMetaDto;
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
  readonly projections: readonly ["compact", "full", "complement"];
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
    projections: ["compact", "full", "complement"],
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
    "Grouped `{ ledger }` or paginated `{ ledger, items, total, offset, limit, nextOffset }`; a paginated `ledger` replaces `archivePointers` with `archivePointerCount`; items use requested projection.",
  ),
  fetch_ledger_archive: requestedFullContent(
    "`{ archive }` with the requested archived item or milestone group in full.",
  ),
  fetch_item: mandatoryItemProjection(
    "`{ item }`; `milestones`: `{ item, resolved, references }`. Items use requested projection.",
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
    "`{ results: [{ ledgerId, item, score, matchedFields }] }`; items use requested projection.",
  ),
  archive_milestone: purposeBuiltSmall("`{ pointer }`."),
  archive_terminal_items: purposeBuiltSmall("`{ sweep }`."),
  execute_finalize: purposeBuiltSmall("`{ applied }`."),
  list_milestone_items: mandatoryItemProjection(
    "`{ items: Record<ledgerId, Item[]> }`; items use requested projection.",
  ),
  snapshot: purposeBuiltSmall(
    "`{ ledger: Record<ledgerId, Record<status, { count, items: [{ id, status, summary }] }>> }`.",
  ),
  workset: purposeBuiltSmall(
    'Get/fetch: `{op,graph}`. Set: `{op:"set",acknowledgement:{roots,epoch}}`.',
  ),
  derive_predicates: purposeBuiltSmall("`{ <predicate>: { value, items } }`."),
  materialize_operator_action: purposeBuiltSmall(
    '`{ state: "created"|"existing", action, handoff }` with revision 1.',
  ),
  acknowledge_operator_action: purposeBuiltSmall("`{ state, action, reason? }`."),
  record_operator_action_evidence: purposeBuiltSmall("`{ state, action, reason? }`."),
  revise_operator_action: purposeBuiltSmall("`{ action, task?, handoff? }`."),
  complete_operator_action: purposeBuiltSmall("`{ task }` after the exact verified revision."),
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
    "Selected `section` payload only.",
  ),
  get_usage_stats: purposeBuiltSmall(
    "`{ endpoints: [{ name, callCount, bytesIn, bytesOut }], totals: { callCount, bytesIn, bytesOut } }`",
  ),
  prepare_dispatch: purposeBuiltSmall(
    "`{accepted,prepared,handle,executedStepOrder}` or pre-launch rejection.",
  ),
  fetch_dispatch_input: requestedFullContent(
    "Prepare-bound typed input; capability-authorized first retrieval only.",
  ),
  store_result: purposeBuiltSmall("A handle-only stored-result acknowledgement or typed abort."),
  confirm_dispatch_completion: purposeBuiltSmall(
    "A handle-only consumed acknowledgement or typed abort.",
  ),
  abort_dispatch: purposeBuiltSmall("A typed aborted acknowledgement."),
  fetch_dispatch_result: requestedFullContent(
    "One typed fetch state; only the first consumed fetch can carry `output`.",
  ),
  start_dispatch: purposeBuiltSmall("`{accepted,handle,route}` or pre-launch rejection."),
  fetch_prompt: requestedFullContent(
    "Default full: typed entry with prompt and available schemas. Schema: exactly {roleId,version?,inputSchema?,outputSchema?}; orchestrator-command {roleId} only, schema keys absent, never null.",
  ),
  list_projects: purposeBuiltSmall("`{ projects: [{ key, displayName, createdAt? }] }`."),
  mint_plan_claim_authority: purposeBuiltSmall(
    "Exactly {claimRequestId,ownerFenceToken}: public ID, secret fence.",
  ),
  claim_plan: purposeBuiltSmall(
    "`{ok:true,replayed,acknowledgement}`: minted ownerFenceToken only to winner/exact retry; `{ok:false,conflict}`: public claim metadata only.",
  ),
  publish_plan_draft: purposeBuiltSmall(
    "`{ok:true,replayed,acknowledgement:{…operation key,manifest,replacedManifest,reviewDefects}}` or `{ok:false,conflict}`; never ownerFenceToken.",
  ),
  release_plan_claim: purposeBuiltSmall(
    "`{ok:true,replayed,acknowledgement:{kind,…operation key,questions,researches,waitingResearches,tasks,waitingTasks,reviewDefects,goalPhase}}` or `{ok:false,conflict}`; never ownerFenceToken.",
  ),
  finalize_plan: purposeBuiltSmall(
    "`{ok:true,replayed,acknowledgement:{…operation key,reviewId,draft,decisionId,manifest,reviewDefects,goalPhase}}` or `{ok:false,conflict}`; never ownerFenceToken.",
  ),
  worktree_manage: purposeBuiltSmall(
    "`prepared|resume-required|refused`, `conflict-observed`, staged-rebase recovery, or " +
      "`released|refused`; typed acknowledgements only.",
  ),
  git_commit: purposeBuiltSmall(
    "Replayable `{kind,version,attestationId,generation,taskId|cohort,operationId,requestDigest,oldHead,newHead,tree,objectOids,paths,committedAt}` receipt.",
  ),
  git_resolve_continue: purposeBuiltSmall(
    "Replayable durable conflict-continuation receipt: attributed objects plus terminal rebased tip or exact next parent-bound conflict state.",
  ),
  prepare_implementation_review_panel: purposeBuiltSmall(
    "`{ status, panelRef, taskRef, resultCommit, rosterDigest, attemptRefs }`.",
  ),
  prepare_implementation_review_attempt: purposeBuiltSmall(
    "`{ status, attemptRef, launch, dispatch? }`; `dispatch` only for native launch.",
  ),
  execute_external_implementation_review_attempt: purposeBuiltSmall(
    "`{ status, attemptRef, executionRef }`.",
  ),
  finalize_implementation_review_attempt: purposeBuiltSmall(
    "`{status,attemptRef,terminalState,outcome}`.",
  ),
  prepare_implementation_review_fallback: purposeBuiltSmall(
    "`{ status, attemptRef, dispatch }`: sole authenticated native fallback.",
  ),
  prepare_implementation_audit_panel: purposeBuiltSmall(
    "`{ status, panelRef, manifestId, recordKey, taskRef, rosterDigest, attemptRefs }`.",
  ),
  prepare_implementation_audit_attempt: purposeBuiltSmall(
    "`{ status, attemptRef, launch, dispatch? }`; `dispatch` only for native launch.",
  ),
  execute_external_implementation_audit_attempt: purposeBuiltSmall(
    "`{ status, attemptRef, executionRef }`.",
  ),
  finalize_implementation_audit_attempt: purposeBuiltSmall(
    "`{ status, attemptRef, terminalState }`.",
  ),
  prepare_implementation_audit_fallback: purposeBuiltSmall(
    "`{ status, attemptRef, dispatch }`: sole authenticated native fallback.",
  ),
  advance_implementation_evidence_bootstrap: purposeBuiltSmall(
    "Typed bootstrap acknowledgement.",
  ),
  arm_implementation_evidence_activation: purposeBuiltSmall(
    "Typed activation-arm acknowledgement.",
  ),
  apply_implementation_audit_manifest: purposeBuiltSmall(
    "Typed audit-application acknowledgement.",
  ),
  get_implementation_evidence_activation_status: purposeBuiltSmall(
    "Bounded absent|pending|stale|active activation-status acknowledgement.",
  ),
  continue_implementation_evidence_activation: purposeBuiltSmall(
    "Continued|existing activation-continuation acknowledgement.",
  ),
  get_implementation_evidence_service_status: purposeBuiltSmall("Typed service-status object."),
  prepare_implementation_completion: purposeBuiltSmall(
    "`{ status, completionRef, taskRef, resultCommit, repositoryHead, evidenceFingerprint }`.",
  ),
  record_implementation_completion: purposeBuiltSmall(
    "Completion acknowledgement: merge-required, reprepare-required, recorded, or existing.",
  ),
  record_implementation_adoption: purposeBuiltSmall("Operator-adoption acknowledgement."),
  record_cohort_review: purposeBuiltSmall("Authenticated all-member review reference."),
  complete_cohort: purposeBuiltSmall("Resumable cohort handoff or executor/deployment requirement."),
  cohort_advance: purposeBuiltSmall("Observed decisions/definitions or full-cohort managed-worktree result."),
  cohort_investigation_advance: purposeBuiltSmall("Retained state, exact native launches, per-member adjudication requests, authenticated probe receipts and correction eligibility/candidates; no execution authority."),
  get_cohort_completion_status: purposeBuiltSmall("Retained handoff and executor availability."),
  get_cohort_status: purposeBuiltSmall("Cohort metadata, durable measured counts; no live lease authority."),
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

export function projectComplementItemDto(item: Item): ProducedWireDto<ComplementItemDto> {
  const fields: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(item.fields)) {
    if (!COMPACT_ITEM_FIELD_NAME_SET.has(key) && value !== undefined) {
      fields[key] = value;
    }
  }
  return markProduced({ id: item.id, fields });
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
):
  | ProducedWireDto<CompactItemDto>
  | ProducedWireDto<FullItemDto>
  | ProducedWireDto<ComplementItemDto> {
  switch (projection) {
    case "compact":
      return projectCompactItemDto(item);
    case "full":
      return projectFullItemDto(item);
    case "complement":
      return projectComplementItemDto(item);
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
    ledger: PaginatedLedgerMetaDto;
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
