import { z } from "zod";
import type { LedgerStore } from "../store/LedgerStore.js";
import {
  bindWorksetInvocationAuthority,
  invokeWorksetFetch,
  invokeWorksetGet,
  invokeWorksetSet,
  isTrustedWorksetManagementAuthority,
  type WorksetInvocationAuthority,
} from "../worksetInvocationAuthority.js";
import {
  buildActiveStateFromLedgerStore,
  requireWorksetRootReplacement,
  requireWorksetStore,
} from "../worksetAccess.js";
import { closeWorkset, projectWorkset, type WorksetProjectedGraph } from "../worksetGraph.js";
import type { WorksetRootsEpoch } from "../worksetEffectAdmission.js";
import { ITEM_PROJECTION_SCHEMA } from "./wireResponseContract.js";

export const WORKSET_PROJECTION_SCHEMA = z.enum(["id", ...ITEM_PROJECTION_SCHEMA.options]);
export type WorksetProjectionRequest = z.infer<typeof WORKSET_PROJECTION_SCHEMA>;

export type WorksetRequest =
  | { readonly op: "get"; readonly projection: WorksetProjectionRequest }
  | {
      readonly op: "fetch";
      readonly roots: readonly string[];
      readonly projection: WorksetProjectionRequest;
    }
  | { readonly op: "set"; readonly roots: readonly string[] };

export type WorksetObserveRequest = Exclude<WorksetRequest, { readonly op: "set" }>;

export type WorksetResult =
  | { readonly op: "get"; readonly graph: WorksetProjectedGraph }
  | { readonly op: "fetch"; readonly graph: WorksetProjectedGraph }
  | { readonly op: "set"; readonly acknowledgement: WorksetRootsEpoch };

export type WorksetResultFor<R extends WorksetRequest> = Extract<
  WorksetResult,
  { readonly op: R["op"] }
>;

const OBSERVE_OPERATIONS = ["get", "fetch"] as const;
const MANAGEMENT_OPERATIONS = ["get", "fetch", "set"] as const;

export function worksetInputShape(
  authority: WorksetInvocationAuthority,
): Record<string, z.ZodType> {
  const management = isTrustedWorksetManagementAuthority(authority);
  return {
    op: management ? z.enum(MANAGEMENT_OPERATIONS) : z.enum(OBSERVE_OPERATIONS),
    roots: z.array(z.string()).optional(),
    projection: WORKSET_PROJECTION_SCHEMA.optional(),
  };
}

function parseRequest(args: Record<string, unknown>, management: boolean): WorksetRequest {
  const op = args["op"];
  if (op === "get") {
    if (args["roots"] !== undefined) throw new Error("workset get does not accept roots");
    return { op, projection: WORKSET_PROJECTION_SCHEMA.parse(args["projection"]) };
  }
  if (op === "fetch") {
    return {
      op,
      roots: z.array(z.string()).parse(args["roots"]),
      projection: WORKSET_PROJECTION_SCHEMA.parse(args["projection"]),
    };
  }
  if (op === "set" && management) {
    if (args["projection"] !== undefined) throw new Error("workset set does not accept projection");
    return { op, roots: z.array(z.string()).parse(args["roots"]) };
  }
  throw new Error(`workset operation is not authorized: ${String(op)}`);
}

export function createWorksetOperation(
  store: LedgerStore,
  authority: WorksetInvocationAuthority,
): (args: Record<string, unknown>) => Promise<WorksetResult> {
  const carrier = bindWorksetInvocationAuthority({}, authority);
  const management = isTrustedWorksetManagementAuthority(authority);
  return async (args) => {
    const request = parseRequest(args, management);
    switch (request.op) {
      case "get":
        return await invokeWorksetGet(carrier, async () => {
          const snapshot = await requireWorksetStore(store).snapshot();
          const graph = closeWorkset(snapshot.roots, buildActiveStateFromLedgerStore(store));
          return { op: "get", graph: projectWorkset(graph, request.projection) };
        });
      case "fetch":
        return await invokeWorksetFetch(carrier, async () => {
          const graph = closeWorkset(request.roots, buildActiveStateFromLedgerStore(store), {
            validateLiveRoots: true,
          });
          return { op: "fetch", graph: projectWorkset(graph, request.projection) };
        });
      case "set":
        return await invokeWorksetSet(carrier, async () => ({
          op: "set",
          acknowledgement: await requireWorksetRootReplacement(store)(request.roots),
        }));
    }
  };
}
