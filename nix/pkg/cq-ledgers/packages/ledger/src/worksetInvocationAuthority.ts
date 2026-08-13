/** Runtime-only authority for workset observation and management invocations. */

export type WorksetInvocationAuthorityErrorCode =
  | "invalid-authority"
  | "management-authority-required";

export class WorksetInvocationAuthorityError extends Error {
  constructor(
    public readonly code: WorksetInvocationAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorksetInvocationAuthorityError";
  }
}

export interface WorksetInvocationAuthority {
  get<T>(operation: () => T): T;
  fetch<T>(operation: () => Promise<T> | T): Promise<T>;
  set<T>(operation: () => Promise<T> | T): Promise<T>;
}

export type WorksetManagementAuthority = WorksetInvocationAuthority;

type WorksetInvocationScope = "observe" | "management";

const authorityScopes = new WeakMap<object, WorksetInvocationScope>();

function scopeOf(value: unknown): WorksetInvocationScope | null {
  if (typeof value !== "object" || value === null) return null;
  return authorityScopes.get(value) ?? null;
}

function requireRuntimeAuthority(value: unknown): WorksetInvocationScope {
  const scope = scopeOf(value);
  if (scope === null) {
    throw new WorksetInvocationAuthorityError(
      "invalid-authority",
      "workset invocation requires a runtime-issued authority",
    );
  }
  return scope;
}

function createWorksetInvocationAuthority(
  scope: WorksetInvocationScope,
): WorksetInvocationAuthority {
  const authority: WorksetInvocationAuthority = {
    get<T>(this: WorksetInvocationAuthority, operation: () => T): T {
      requireRuntimeAuthority(this);
      return operation();
    },
    async fetch<T>(
      this: WorksetInvocationAuthority,
      operation: () => Promise<T> | T,
    ): Promise<T> {
      requireRuntimeAuthority(this);
      return await operation();
    },
    async set<T>(
      this: WorksetInvocationAuthority,
      operation: () => Promise<T> | T,
    ): Promise<T> {
      if (requireRuntimeAuthority(this) !== "management") {
        throw new WorksetInvocationAuthorityError(
          "management-authority-required",
          "workset set requires trusted management authority",
        );
      }
      return await operation();
    },
  };
  authorityScopes.set(authority, scope);
  return Object.freeze(authority);
}

/** Construct the authority used by ordinary embedded, child, and direct contexts. */
export function createObserveOnlyWorksetInvocationAuthority(): WorksetInvocationAuthority {
  return createWorksetInvocationAuthority("observe");
}

/** Construct management authority at an explicit trusted-host boundary. */
export function createTrustedWorksetManagementAuthority(): WorksetManagementAuthority {
  return createWorksetInvocationAuthority("management");
}

export function isTrustedWorksetManagementAuthority(
  value: unknown,
): value is WorksetManagementAuthority {
  return scopeOf(value) === "management";
}
