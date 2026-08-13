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
