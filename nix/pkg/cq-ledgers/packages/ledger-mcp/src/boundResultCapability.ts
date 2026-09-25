/**
 * G224: a child-owned `cq mcp` started by a process dispatch adapter carries
 * its dispatch's result capability in the environment, never in the child's
 * prompt. It is taken once and removed, so no process this server spawns
 * (gate commands, Git) inherits it.
 */

import type { GitCommitToolInput, GitResolveContinueToolInput, StoreResultToolInput } from "@cq/ledger";

export const CQ_DISPATCH_RESULT_CAPABILITY_ENV = "CQ_DISPATCH_RESULT_CAPABILITY";
export const CQ_DISPATCH_GIT_CONFLICT_CAPABILITY_ENV = "CQ_DISPATCH_GIT_CONFLICT_CAPABILITY";
export const CQ_DISPATCH_GIT_CHANGE_CAPABILITY_ENV = "CQ_DISPATCH_GIT_CHANGE_CAPABILITY";

const RESULT_CAPABILITY_TOKEN = /^cq_result_[A-Za-z0-9_-]{43,}$/u;
const GIT_CONFLICT_CAPABILITY_TOKEN = /^cq_conflict_[A-Za-z0-9_-]{43,}$/u;
const GIT_CHANGE_CAPABILITY_TOKEN = /^cq_git_[A-Za-z0-9_-]{43,}$/u;

function takeToken(
  environment: Record<string, string | undefined>,
  name: string,
  pattern: RegExp,
): string | undefined {
  const token = environment[name];
  delete environment[name];
  if (token === undefined) return undefined;
  if (!pattern.test(token)) throw new Error(`ledger-mcp: ${name} does not carry the capability its name declares`);
  return token;
}

export function takeBoundResultCapability(
  environment: Record<string, string | undefined>,
): StoreResultToolInput["resultCapability"] | undefined {
  const token = takeToken(environment, CQ_DISPATCH_RESULT_CAPABILITY_ENV, RESULT_CAPABILITY_TOKEN);
  return token === undefined ? undefined : Object.freeze({ scope: "store-result" as const, token });
}

export function takeBoundGitConflictCapability(
  environment: Record<string, string | undefined>,
): GitResolveContinueToolInput["gitConflictCapability"] | undefined {
  const token = takeToken(environment, CQ_DISPATCH_GIT_CONFLICT_CAPABILITY_ENV, GIT_CONFLICT_CAPABILITY_TOKEN);
  return token === undefined ? undefined : Object.freeze({ scope: "git-conflict" as const, token });
}

/**
 * D561: a cohort worker commits through the trusted broker on EVERY surface, so
 * its Git change capability reaches the child the same way the conflict
 * capability already does — through the child server's environment, never the
 * child's prompt.
 */
export function takeBoundGitChangeCapability(
  environment: Record<string, string | undefined>,
): GitCommitToolInput["gitChangeCapability"] | undefined {
  const token = takeToken(environment, CQ_DISPATCH_GIT_CHANGE_CAPABILITY_ENV, GIT_CHANGE_CAPABILITY_TOKEN);
  return token === undefined ? undefined : Object.freeze({ scope: "git-change" as const, token });
}
