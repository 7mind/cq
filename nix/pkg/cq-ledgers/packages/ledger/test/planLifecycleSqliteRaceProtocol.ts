import type { PlanClaimInput, PlanClaimResult } from "../src/index.js";
import type { PlanLifecycleSerializationContender } from "../src/store/planLifecycleSerialization.js";

export type SqliteRaceOperation =
  | {
      readonly kind: "task-start" | "task-block";
      readonly taskId: string;
      readonly provenance: { author: string; session?: string };
    }
  | {
      readonly kind: "follow-up-claim";
      readonly input: PlanClaimInput;
    };

export type SqliteRaceOperationResult = void | PlanClaimResult;

export interface SqliteRaceWorkerRequest {
  readonly dbPath: string;
  readonly operation: SqliteRaceOperation;
  readonly expected: PlanLifecycleSerializationContender | null;
  readonly holdBuffer: SharedArrayBuffer | null;
}

export type SqliteRaceWorkerResponse =
  | {
      readonly type: "held";
      readonly contender: PlanLifecycleSerializationContender;
    }
  | {
      readonly type: "result";
      readonly result: SqliteRaceOperationResult;
    }
  | {
      readonly type: "error";
      readonly message: string;
    };
