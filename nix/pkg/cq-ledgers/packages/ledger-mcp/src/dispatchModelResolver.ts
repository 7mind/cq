/**
 * G224 / K332 — the token a CQ-driven dispatch runs at. The parent may name a
 * specific token (a review or planning panel member), but only one the
 * configuration makes dispatchable; otherwise the role's tier token applies.
 * The token's harness is the dispatch's TARGET harness.
 */

import {
  formatReviewerToken,
  parseReviewerToken,
  resolveAgentModel,
  resolvePlanners,
  resolveReviewers,
  type CqConfig,
  type ReviewerToken,
} from "@cq/config";
import type { DispatchModelResolver } from "./dispatchDriver.js";

function dispatchableTokens(config: CqConfig): ReadonlySet<string> {
  return new Set(
    [
      ...resolveReviewers(config),
      ...resolvePlanners(config),
      ...(config.tiers?.entries.map((entry) => entry.token) ?? []),
    ].map((token: ReviewerToken) => formatReviewerToken(token)),
  );
}

/** `loadCurrentConfig` is read on every call, so an edited cq.toml applies to the next dispatch. */
export function createConfiguredDispatchModelResolver(
  loadCurrentConfig: () => CqConfig | null,
): DispatchModelResolver {
  return (roleId, requestedModel) => {
    const config = loadCurrentConfig();
    if (config === null) {
      throw new Error("start_dispatch: this project has no cq.toml, so no role model can be resolved");
    }
    if (requestedModel === undefined) {
      const token = resolveAgentModel(config, roleId);
      return { token, formatted: formatReviewerToken(token) };
    }
    const token = parseReviewerToken(requestedModel);
    const formatted = formatReviewerToken(token);
    if (!dispatchableTokens(config).has(formatted)) {
      throw new Error(
        `start_dispatch: model ${JSON.stringify(formatted)} is not dispatchable; name a configured panel or tier token`,
      );
    }
    return { token, formatted };
  };
}
