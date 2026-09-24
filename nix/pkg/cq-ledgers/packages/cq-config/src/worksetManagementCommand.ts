/** Environment-only credentials that must never cross into dispatched children. */
export const WORKSET_CREDENTIAL_ENV_NAMES = [
  "CQ_SERVE_TOKEN",
  "CQ_SERVE_MANAGEMENT_TOKEN",
  "CQ_LEDGER_REMOTE_TOKEN",
] as const;

export type WorksetCredentialEnvName = (typeof WORKSET_CREDENTIAL_ENV_NAMES)[number];

/** Copy an environment while removing ordinary and management ledger credentials. */
export function withoutWorksetCredentials(
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = { ...environment };
  for (const name of WORKSET_CREDENTIAL_ENV_NAMES) delete childEnvironment[name];
  return childEnvironment;
}

/**
 * Identity of ONE dispatch invocation (D506). These are set per invocation by
 * the role boundary; they are not ambient configuration, so inheriting them
 * into a nested invocation silently re-targets it at the parent's correlation
 * — which is how a nested child selected the registered-observation path and
 * suppressed the diagnostic it was launched to emit.
 *
 * Declared here, beside the credential list, because this is the package that
 * SETS them; `@cq/ledger` consumes it (that dependency direction is the only
 * one available).
 */
export const DISPATCH_INVOCATION_ENV_NAMES = [
  "CQ_CODEX_ROLE_CORRELATION_ID",
  "CQ_CODEX_ROLE_EXPECTED_RUN_ID",
  "CQ_CODEX_PRETURN_OBSERVATION_PATH",
] as const;

export type DispatchInvocationEnvName = (typeof DISPATCH_INVOCATION_ENV_NAMES)[number];

/**
 * Copy an environment while removing the parent's per-invocation dispatch
 * identity, leaving every other runtime/test setting untouched. A caller that
 * means to bind a nested invocation sets its OWN identity after this.
 */
export function withoutDispatchInvocationIdentity(
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = { ...environment };
  for (const name of DISPATCH_INVOCATION_ENV_NAMES) delete childEnvironment[name];
  return childEnvironment;
}

export interface WorksetManagementCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

/** Construct a trusted-host command without placing any credential in argv or child env. */
export function createWorksetManagementCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): WorksetManagementCommand {
  return Object.freeze({
    command: input.command,
    args: Object.freeze([...input.args]),
    env: Object.freeze(withoutWorksetCredentials(input.environment)),
  });
}
