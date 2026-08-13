import type { WorksetRequest, WorksetResultFor } from "./worksetTool.js";

/** Browser-safe typed client surface for the correlated workset operation. */
export interface WorksetOperationClient {
  workset<R extends WorksetRequest>(request: R): Promise<WorksetResultFor<R>>;
}
