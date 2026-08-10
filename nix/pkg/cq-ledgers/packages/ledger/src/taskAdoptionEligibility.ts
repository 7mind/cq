import type { Item } from "./types.js";
import { LedgerError } from "./types.js";
import {
  resolveDependencyResultCommits,
  type DependencyTaskSnapshot,
  type UnresolvableDependencyResultCommits,
} from "./dependencyResultCommits.js";

const TASK_REF_PREFIX = "tasks:";
const TASK_ADOPTION_FENCE_BRAND: unique symbol = Symbol("task-adoption-eligibility-fence");

export interface TaskAdoptionEligibilityFence {
  readonly [TASK_ADOPTION_FENCE_BRAND]: true;
}

export type TaskAdoptionIneligibility =
  | {
      readonly reason: "task-not-found";
      readonly taskId: string;
    }
  | {
      readonly reason: "task-not-active";
      readonly taskId: string;
      readonly taskStatus: string;
    }
  | {
      readonly reason: "task-not-wip";
      readonly taskId: string;
      readonly taskStatus: string;
    }
  | {
      readonly reason: "dependency-unresolvable";
      readonly taskId: string;
      readonly detail: UnresolvableDependencyResultCommits;
    };

export type TaskAdoptionEligibilityResult =
  | {
      readonly status: "eligible";
      readonly fence: TaskAdoptionEligibilityFence;
    }
  | {
      readonly status: "ineligible";
      readonly ineligibility: TaskAdoptionIneligibility;
    };

export type TaskAdoptionPublicationResult =
  | { readonly status: "published" }
  | { readonly status: "stale" }
  | { readonly status: "already-published" }
  | { readonly status: "invalid-fence" };

interface TaskAdoptionSnapshotRow {
  readonly taskId: string;
  readonly status: string;
  readonly dependsOn: readonly string[];
  readonly resultCommit: string | null;
  readonly archived: boolean;
}

interface TaskAdoptionEligibilitySnapshot {
  readonly taskId: string;
  readonly tasks: readonly TaskAdoptionSnapshotRow[];
}

export type TaskAdoptionEligibilityObservation =
  | {
      readonly status: "eligible";
      readonly snapshot: TaskAdoptionEligibilitySnapshot;
    }
  | {
      readonly status: "ineligible";
      readonly ineligibility: TaskAdoptionIneligibility;
    };

interface StoredFence {
  readonly taskId: string;
  readonly snapshotJson: string;
  published: boolean;
}

function dependencyTaskSnapshot(item: Item, archived: boolean): DependencyTaskSnapshot {
  const dependsOn = item.fields["dependsOn"];
  const resultCommit = item.fields["resultCommit"];
  return {
    taskId: item.id,
    status: item.status,
    dependsOn: Array.isArray(dependsOn) ? [...dependsOn] : [],
    resultCommit: typeof resultCommit === "string" ? resultCommit : null,
    archived,
  };
}

function taskIdFromRef(taskRef: string): string {
  if (!taskRef.startsWith(TASK_REF_PREFIX)) {
    throw new LedgerError(`task adoption dependency resolver returned invalid ref ${taskRef}`);
  }
  return taskRef.slice(TASK_REF_PREFIX.length);
}

export function observeTaskAdoptionEligibility(
  taskId: string,
  activeItems: readonly Item[],
  archivedItems: readonly Item[],
): TaskAdoptionEligibilityObservation {
  const snapshots = new Map<string, DependencyTaskSnapshot>();
  for (const [items, archived] of [
    [activeItems, false],
    [archivedItems, true],
  ] as const) {
    for (const item of items) {
      if (snapshots.has(item.id)) {
        throw new LedgerError(`task ${item.id} exists in both active and archived storage`);
      }
      snapshots.set(item.id, dependencyTaskSnapshot(item, archived));
    }
  }

  const root = snapshots.get(taskId);
  if (root === undefined) {
    return {
      status: "ineligible",
      ineligibility: { reason: "task-not-found", taskId },
    };
  }
  if (root.archived) {
    return {
      status: "ineligible",
      ineligibility: { reason: "task-not-active", taskId, taskStatus: root.status },
    };
  }
  if (root.status !== "wip") {
    return {
      status: "ineligible",
      ineligibility: { reason: "task-not-wip", taskId, taskStatus: root.status },
    };
  }

  const resolution = resolveDependencyResultCommits({
    rootTaskRef: taskId,
    taskSnapshots: [...snapshots.values()],
  });
  if (resolution.status === "unresolvable") {
    return {
      status: "ineligible",
      ineligibility: { reason: "dependency-unresolvable", taskId, detail: resolution },
    };
  }

  const closureIds = [
    taskId,
    ...resolution.dependencyResultCommits.map(({ dependencyRef }) =>
      taskIdFromRef(dependencyRef),
    ),
  ];
  const tasks = [...new Set(closureIds)].map((id): TaskAdoptionSnapshotRow => {
    const snapshot = snapshots.get(id);
    if (snapshot === undefined) {
      throw new LedgerError(`validated task adoption dependency ${id} disappeared`);
    }
    return {
      taskId: snapshot.taskId,
      status: snapshot.status,
      dependsOn: [...snapshot.dependsOn].sort(),
      resultCommit: snapshot.resultCommit,
      archived: snapshot.archived,
    };
  });
  tasks.sort((left, right) => left.taskId.localeCompare(right.taskId));
  return { status: "eligible", snapshot: { taskId, tasks } };
}

export class TaskAdoptionFenceRegistry {
  private readonly fences = new WeakMap<TaskAdoptionEligibilityFence, StoredFence>();

  capture(
    taskId: string,
    observation: TaskAdoptionEligibilityObservation,
  ): TaskAdoptionEligibilityResult {
    if (observation.status === "ineligible") return observation;
    const fence = Object.freeze({
      [TASK_ADOPTION_FENCE_BRAND]: true as const,
    });
    this.fences.set(fence, {
      taskId,
      snapshotJson: JSON.stringify(observation.snapshot),
      published: false,
    });
    return { status: "eligible", fence };
  }

  taskId(fence: TaskAdoptionEligibilityFence): string | null {
    return this.fences.get(fence)?.taskId ?? null;
  }

  compareAndPublish(
    fence: TaskAdoptionEligibilityFence,
    observation: TaskAdoptionEligibilityObservation,
    publish: () => undefined,
  ): TaskAdoptionPublicationResult {
    const stored = this.fences.get(fence);
    if (stored === undefined) return { status: "invalid-fence" };
    if (stored.published) return { status: "already-published" };
    if (
      observation.status === "ineligible" ||
      JSON.stringify(observation.snapshot) !== stored.snapshotJson
    ) {
      return { status: "stale" };
    }
    const callbackResult: unknown = publish();
    if (callbackResult !== undefined) {
      throw new LedgerError("task adoption publication callback must complete synchronously");
    }
    stored.published = true;
    return { status: "published" };
  }
}
