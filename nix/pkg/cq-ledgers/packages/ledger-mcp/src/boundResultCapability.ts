/**
 * G224: a child-owned `cq mcp` started by a process dispatch adapter carries
 * its dispatch's result capability in the environment, never in the child's
 * prompt. It is taken once and removed, so no process this server spawns
 * (gate commands, Git) inherits it.
 */

import type { StoreResultToolInput } from "@cq/ledger";

export const CQ_DISPATCH_RESULT_CAPABILITY_ENV = "CQ_DISPATCH_RESULT_CAPABILITY";

const RESULT_CAPABILITY_TOKEN = /^cq_result_[A-Za-z0-9_-]{43,}$/u;

export function takeBoundResultCapability(
  environment: Record<string, string | undefined>,
): StoreResultToolInput["resultCapability"] | undefined {
  const token = environment[CQ_DISPATCH_RESULT_CAPABILITY_ENV];
  delete environment[CQ_DISPATCH_RESULT_CAPABILITY_ENV];
  if (token === undefined) return undefined;
  if (!RESULT_CAPABILITY_TOKEN.test(token)) {
    throw new Error(`ledger-mcp: ${CQ_DISPATCH_RESULT_CAPABILITY_ENV} is not a result capability token`);
  }
  return Object.freeze({ scope: "store-result" as const, token });
}
