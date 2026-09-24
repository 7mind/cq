/** G224: run a routed dispatch in-process, settling through the bare attestation service. */
import {
  attestationServiceSettlement,
  runPreparedDispatch,
  type RunPreparedDispatchRequest,
} from "../../src/dispatchTransportRouter.js";
import type { AttestationNamespace, DispatchServiceDeps } from "../../src/dispatchAttestation.js";

export function runPreparedDispatchOverService(
  request: RunPreparedDispatchRequest & { readonly namespace: AttestationNamespace },
  registry: Parameters<typeof runPreparedDispatch>[1],
  deps: DispatchServiceDeps,
): ReturnType<typeof runPreparedDispatch> {
  const { namespace, ...routed } = request;
  return runPreparedDispatch(routed, registry, attestationServiceSettlement(namespace, deps));
}
