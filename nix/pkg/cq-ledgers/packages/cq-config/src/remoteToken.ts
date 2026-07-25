import type { RemoteLedgerToken } from "./types.js";

/** The sole cq environment variable carrying the ordinary remote bearer token. */
export const CQ_LEDGER_REMOTE_TOKEN_ENV = "CQ_LEDGER_REMOTE_TOKEN";

/** Raised when remote operation has no usable environment bearer token. */
export class RemoteLedgerTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteLedgerTokenError";
  }
}

/**
 * Resolve the remote ledger bearer token from an injected environment.
 *
 * The config model deliberately has no token field: this environment boundary
 * is the only ordinary bearer-secret source.
 */
export function resolveRemoteLedgerToken(
  env: Readonly<Record<string, string | undefined>>,
): RemoteLedgerToken {
  const token = env[CQ_LEDGER_REMOTE_TOKEN_ENV];
  if (token === undefined || token.trim() === "") {
    throw new RemoteLedgerTokenError(
      "CQ_LEDGER_REMOTE_TOKEN must be set to a non-empty bearer token for the remote ledger backend",
    );
  }
  return token as RemoteLedgerToken;
}

/** Resolve the remote ledger bearer token from the current process boundary. */
export function resolveRemoteLedgerTokenFromProcess(): RemoteLedgerToken {
  return resolveRemoteLedgerToken(process.env);
}
