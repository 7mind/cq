import type { PlanOperationReplayRecord, PlanPrivateClaimRecord } from "../planLifecycle.js";
import type { GenericMutationDataSource } from "./genericMutationDataSource.js";
import type { InMemoryPlanOperationRecord } from "./inMemoryPlanLifecycle.js";
import type { ArchivePointer } from "../types.js";

export type LifecycleClaimRequestKey = Pick<PlanPrivateClaimRecord, "goalId" | "claimRequestId">;
export type LifecycleClaimKey = Pick<PlanPrivateClaimRecord, "goalId" | "claimId" | "generation">;
export type LifecycleOperationKey = Pick<
  PlanOperationReplayRecord,
  "goalId" | "claimId" | "generation" | "operation" | "operationId"
>;

export interface LifecycleGroup {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export interface LifecyclePrivateRecordChanges {
  readonly claims: readonly PlanPrivateClaimRecord[];
  readonly operations: readonly InMemoryPlanOperationRecord[];
}

export interface ImplementationCompletionBindingRecord {
  readonly taskId: string;
  readonly reviewRef: string;
}

export interface LifecycleRowRepository {
  readonly publicRows: GenericMutationDataSource;
  fetchArchivePointer(ledgerId: string, pointerId: string): ArchivePointer | undefined;
  fetchGroup(ledgerId: string, groupId: string): LifecycleGroup | undefined;
  taskRefsByMilestones(milestoneIds: readonly string[]): readonly string[];
  fetchClaimByRequest(key: LifecycleClaimRequestKey): PlanPrivateClaimRecord | undefined;
  fetchClaimByIdentity(key: LifecycleClaimKey): PlanPrivateClaimRecord | undefined;
  fetchActiveClaim(goalId: string): PlanPrivateClaimRecord | undefined;
  fetchOperation(key: LifecycleOperationKey): InMemoryPlanOperationRecord | undefined;
  fetchImplementationCompletionBinding(taskId: string): ImplementationCompletionBindingRecord | undefined;
  persistPrivateRecords(changes: LifecyclePrivateRecordChanges): void;
  persistImplementationCompletionBindings(changes: readonly ImplementationCompletionBindingRecord[]): void;
}
