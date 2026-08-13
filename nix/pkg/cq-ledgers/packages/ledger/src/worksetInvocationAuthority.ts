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
const carrierAuthorities = new WeakMap<object, WorksetInvocationAuthority>();

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

/** Bind one runtime authority to a constructed surface without changing its schema. */
export function bindWorksetInvocationAuthority<T extends object>(
  carrier: T,
  authority: WorksetInvocationAuthority,
): T {
  requireRuntimeAuthority(authority);
  if (carrierAuthorities.has(carrier)) {
    throw new WorksetInvocationAuthorityError(
      "invalid-authority",
      "workset invocation authority is already bound to this runtime surface",
    );
  }
  carrierAuthorities.set(carrier, authority);
  return carrier;
}

function authorityForCarrier(carrier: object): WorksetInvocationAuthority {
  const authority = carrierAuthorities.get(carrier);
  if (authority === undefined) {
    throw new WorksetInvocationAuthorityError(
      "invalid-authority",
      "workset invocation surface has no bound runtime authority",
    );
  }
  return authority;
}

export function invokeWorksetGet<T>(carrier: object, operation: () => T): T {
  return authorityForCarrier(carrier).get(operation);
}

export async function invokeWorksetFetch<T>(
  carrier: object,
  operation: () => Promise<T> | T,
): Promise<T> {
  return await authorityForCarrier(carrier).fetch(operation);
}

export async function invokeWorksetSet<T>(
  carrier: object,
  operation: () => Promise<T> | T,
): Promise<T> {
  return await authorityForCarrier(carrier).set(operation);
}
