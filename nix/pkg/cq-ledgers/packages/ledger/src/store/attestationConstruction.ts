/**
 * The production dispatch-attestation CONSTRUCTION MATRIX (T686, goal G94).
 *
 * T720 built the three namespaced production {@link AttestationBackend} adapters
 * (`@cq/config`'s xdg/sqlite, filesystem and PostgreSQL backends) plus
 * `assertAttestationStoreBackend`, the LEDGER-BACKEND-level registration guard:
 * `git-object`/`remote` are excluded with a declared reason, and the in-memory
 * test double is excluded as not a backend at all. That guard lives in
 * `@cq/config`, which cannot depend on `@cq/ledger` (the dependency runs the
 * other way — `@cq/ledger` depends on `@cq/config`), so it cannot itself call
 * {@link resolveProjectKey} or open a real backend. This module is the layer
 * ABOVE it: the ONE place that binds a SERVER CONSTRUCTION (how the ledger-mcp
 * surface is actually built — direct, stdio, embedded TUI/web, single-project
 * HTTP, or the PostgreSQL hub) to a concrete, namespaced attestation store, or
 * refuses before any of that construction's ref-first tools would be
 * registered. A future task (T695) wires the actual `prepare_dispatch` /
 * `store_result` / `confirm_dispatch_completion` / `abort_dispatch` /
 * `fetch_dispatch_result` MCP tools; this module is the gate it calls FIRST,
 * exactly where `createLedgerStore` sits relative to the ledger tool surface.
 *
 * **The five real constructions plus one that must always refuse.**
 * `direct` (an in-process caller, e.g. cq-cli or a test harness invoking the
 * service without any MCP transport), `stdio` (the standalone `ledger-mcp`
 * binary's default transport), `embedded` (ledger-tui's in-memory MCP
 * transport and ledger-web's co-hosted `/mcp`+`/ws`, both routed through
 * {@link createEmbeddedStore}), and `http-single-project` (`ledger-mcp --http`
 * / `attachMcpHttp`) are all SINGLE-PROJECT: exactly one ledger root, one
 * resolved backend, one {@link resolveProjectKey}-derived key, for the whole
 * process lifetime. `postgres-hub` (`cq serve`, `hubServe.ts`) is the ONE
 * MULTI-project construction this matrix supports: many tenants share a
 * process, routed by Postgres's own trusted `projects.project_key` column,
 * never by a client-supplied namespace. `xdg-catalog-hub`
 * (`xdgCatalogServe.ts`'s local multi-project catalog, which opens many
 * per-project xdg runtimes in one process routed by URL path) is named here
 * ONLY to be excluded: the attestation adapters take ONE cross-process lock
 * per namespace per backend handle, keyed for a SINGLE tenant; nothing in this
 * package gives a local xdg/fs backend Postgres's trusted per-request tenant
 * routing, so a local multi-project hub construction must fail before any
 * ref-first tool is registered, exactly like `git-object`/`remote`/in-memory.
 *
 * **Namespacing never comes from a request (restated at the construction
 * boundary).** {@link resolveSingleProjectAttestationNamespace} derives its
 * `projectKey` from the SAME `resolveProjectKey` the ledger store factory
 * uses — server-side config (`repoRoot`, `[ledger].projectId`), never request
 * content. {@link attestationNamespaceForTrustedHubProject} accepts only an
 * already-resolved `trustedProjectKey` (the hub's own `projects.project_key`
 * routing decision, made BEFORE this function runs) — its signature has no
 * parameter through which a request body or header could inject an arbitrary
 * namespace. Neither function accepts a raw {@link AttestationNamespace}.
 */

import type { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ATTESTATION_STORE_BACKENDS,
  ATTESTATION_IN_MEMORY_BACKEND,
  AttestationBackendUnsupportedError,
  FsAttestationBackend,
  LEDGER_BACKENDS,
  PostgresAttestationBackend,
  SqliteAttestationBackend,
  assertAttestationStoreBackend,
  xdgAttestationDbPath,
  type AttestationBackend,
  type AttestationNamespace,
  type AttestationStoreBackend,
  type LedgerBackend,
} from "@cq/config";
import { LEDGER_STORAGE_DIRNAME } from "../constants.js";
import { resolveProjectKey, type ResolveProjectKeyOpts } from "../projectKey.js";

// ---------------------------------------------------------------------------
// The construction kinds
// ---------------------------------------------------------------------------

/**
 * Every server construction this matrix has a verdict for. `xdg-catalog-hub`
 * is included ONLY so its exclusion is asserted (see file header) — it names
 * no supported cell.
 */
export const LEDGER_SERVER_CONSTRUCTIONS = [
  "direct",
  "stdio",
  "embedded",
  "http-single-project",
  "postgres-hub",
  "xdg-catalog-hub",
] as const;

export type LedgerServerConstruction = (typeof LEDGER_SERVER_CONSTRUCTIONS)[number];

const LEDGER_SERVER_CONSTRUCTION_SET: ReadonlySet<string> = new Set(LEDGER_SERVER_CONSTRUCTIONS);

/** Set-based membership: no `Object.prototype` name resolves a construction. */
export function isLedgerServerConstruction(value: string): value is LedgerServerConstruction {
  return typeof value === "string" && LEDGER_SERVER_CONSTRUCTION_SET.has(value);
}

/**
 * The four constructions where one process serves exactly one project, keyed
 * once at construction time by {@link resolveProjectKey}.
 */
export const SINGLE_PROJECT_CONSTRUCTIONS = [
  "direct",
  "stdio",
  "embedded",
  "http-single-project",
] as const;

export type SingleProjectConstruction = (typeof SINGLE_PROJECT_CONSTRUCTIONS)[number];

const SINGLE_PROJECT_CONSTRUCTION_SET: ReadonlySet<string> = new Set(
  SINGLE_PROJECT_CONSTRUCTIONS,
);

export function isSingleProjectConstruction(
  value: string,
): value is SingleProjectConstruction {
  return typeof value === "string" && SINGLE_PROJECT_CONSTRUCTION_SET.has(value);
}

/** The one construction whose namespace is routed per-request from a trusted registry. */
export const ATTESTATION_HUB_CONSTRUCTION = "postgres-hub" as const;

/** The one construction that is ALWAYS excluded — see the file header. */
export const ATTESTATION_UNSUPPORTED_LOCAL_HUB_CONSTRUCTION = "xdg-catalog-hub" as const;

/**
 * Thrown when a `{construction, backend}` PAIR cannot register ref-first
 * tools — either because the construction itself has no supported cell at
 * all ({@link ATTESTATION_UNSUPPORTED_LOCAL_HUB_CONSTRUCTION}, or an
 * unrecognised construction name), or because {@link assertAttestationStoreBackend}
 * refuses the backend for it. Subclasses that guard so a caller can
 * distinguish "this construction never works" from "this backend doesn't
 * work here" without string-matching a message.
 */
export class AttestationConstructionUnsupportedError extends AttestationBackendUnsupportedError {
  readonly construction: string;

  constructor(construction: string, backend: string, detail: string) {
    super(backend, detail);
    this.name = "AttestationConstructionUnsupportedError";
    this.construction = construction;
  }
}

/**
 * The REGISTRATION GATE: is `{construction, backend}` a supported cell? Pure
 * and synchronous — no filesystem, network or git call — so an excluded cell
 * fails BEFORE any resolution work (git plumbing, a pool, a lockfile) ever
 * runs, not merely before a store is handed back.
 *
 * Returns the narrowed backend on success; throws
 * {@link AttestationConstructionUnsupportedError} otherwise. Delegates the
 * backend-level decision (git-object/remote/in-memory) to
 * {@link assertAttestationStoreBackend} so the two layers can never disagree
 * about what a bare backend name means.
 */
export function assertAttestationConstructionSupported(
  construction: string,
  backend: string,
): AttestationStoreBackend {
  if (!isLedgerServerConstruction(construction)) {
    throw new AttestationConstructionUnsupportedError(
      String(construction),
      backend,
      "unknown ledger server construction",
    );
  }
  if (construction === ATTESTATION_UNSUPPORTED_LOCAL_HUB_CONSTRUCTION) {
    throw new AttestationConstructionUnsupportedError(
      construction,
      backend,
      "the local xdg multi-project catalog hub routes many per-project xdg runtimes from one " +
        "process by URL path; the attestation adapters take one cross-process lock per " +
        "namespace for a SINGLE tenant, and only PostgreSQL's trusted projects.project_key " +
        "column gives a hub construction real per-request tenant routing",
    );
  }
  if (construction === ATTESTATION_HUB_CONSTRUCTION) {
    if (backend !== "postgres") {
      throw new AttestationConstructionUnsupportedError(
        construction,
        backend,
        'the postgres hub only ever routes to backend "postgres" tenants',
      );
    }
    return "postgres";
  }
  // Delegate the bare-backend decision (git-object/remote/in-memory/unknown)
  // to the one function that owns it. Its `AttestationBackendUnsupportedError`
  // propagates AS-IS — this construction-level gate only ever mints its OWN
  // subclass for the two decisions that are specific to a construction
  // (the always-excluded hub, and a hub construction naming the wrong
  // backend), never by rewrapping the delegate's.
  return assertAttestationStoreBackend(backend);
}

// ---------------------------------------------------------------------------
// The two-dimensional coverage self-check
// ---------------------------------------------------------------------------

export interface AttestationConstructionVerdict {
  readonly construction: LedgerServerConstruction;
  readonly backend: string;
  readonly supported: boolean;
  /** Present only when `supported` is false. */
  readonly reason?: string;
}

/**
 * Every `{construction, backend}` cell this matrix knows about, decided at
 * MODULE LOAD by actually invoking {@link assertAttestationConstructionSupported}
 * — not a hand-maintained table that could drift from the guard it describes.
 * A construction or a ledger backend added without updating either constant
 * shows up here automatically; nothing needs to remember to update a second
 * list. Frozen; consult it, don't mutate it.
 */
export function buildAttestationConstructionCoverage(): readonly AttestationConstructionVerdict[] {
  const backends: readonly string[] = [...LEDGER_BACKENDS, ATTESTATION_IN_MEMORY_BACKEND, "postgres"];
  const verdicts: AttestationConstructionVerdict[] = [];
  for (const construction of LEDGER_SERVER_CONSTRUCTIONS) {
    for (const backend of backends) {
      try {
        assertAttestationConstructionSupported(construction, backend);
        verdicts.push({ construction, backend, supported: true });
      } catch (error) {
        // Both this module's own AttestationConstructionUnsupportedError AND
        // the delegated bare-backend AttestationBackendUnsupportedError are
        // legitimate "this cell is excluded" verdicts; anything else is a
        // genuine defect in the gate, so it is NOT swallowed here.
        if (!(error instanceof AttestationBackendUnsupportedError)) throw error;
        verdicts.push({
          construction,
          backend,
          supported: false,
          reason: error.message,
        });
      }
    }
  }
  return Object.freeze(verdicts);
}

export const ATTESTATION_CONSTRUCTION_COVERAGE: readonly AttestationConstructionVerdict[] =
  buildAttestationConstructionCoverage();

/**
 * Exactly the supported cells named in T686's acceptance: xdg/fs support the
 * four single-project constructions; postgres additionally supports the hub.
 * A test asserting against THIS constant (rather than re-deriving it) fails
 * the moment {@link assertAttestationConstructionSupported}'s decisions drift
 * from the declared contract, in either direction.
 */
export function supportedConstructionCells(): ReadonlySet<string> {
  const set = new Set<string>();
  for (const verdict of ATTESTATION_CONSTRUCTION_COVERAGE) {
    if (verdict.supported) set.add(`${verdict.construction}:${verdict.backend}`);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Namespace derivation — the two, and only two, blessed paths to a namespace
// ---------------------------------------------------------------------------

export interface SingleProjectNamespaceInput {
  readonly construction: SingleProjectConstruction;
  readonly backend: string;
  readonly repoRoot: string;
  /** The resolved `[ledger].projectId` from cq.toml, or `null` when absent. */
  readonly projectId: string | null;
  /** Injected for tests; defaults per {@link resolveProjectKey}. */
  readonly git?: ResolveProjectKeyOpts["git"];
}

/**
 * Resolve the {@link AttestationNamespace} for one of the four single-project
 * constructions. The registration gate runs FIRST — an excluded backend never
 * reaches {@link resolveProjectKey}, so a git-object/remote root never has its
 * git plumbing invoked just to build a namespace nothing will use.
 *
 * The derived `projectKey` is BIT-IDENTICAL to `resolveProjectKey`'s own
 * result for the same `{repoRoot, projectId}` — this function does not
 * re-derive it by any other means, so the out-of-tree ledger store and the
 * attestation store for the SAME construction always land on the SAME
 * `projectKey` (one project, one identity, everywhere it is used).
 */
export async function resolveSingleProjectAttestationNamespace(
  input: SingleProjectNamespaceInput,
): Promise<AttestationNamespace> {
  const backend = assertAttestationConstructionSupported(input.construction, input.backend);
  const projectKey = await resolveProjectKey({
    repoRoot: input.repoRoot,
    projectId: input.projectId,
    ...(input.git !== undefined ? { git: input.git } : {}),
  });
  return Object.freeze({ backend, projectKey });
}

/**
 * Resolve the {@link AttestationNamespace} for the PostgreSQL hub. Takes only
 * an already-trusted project key — the hub's OWN `projects.project_key`
 * routing decision — never a raw request. There is no parameter here through
 * which request content could supply or widen a namespace.
 */
export function attestationNamespaceForTrustedHubProject(
  trustedProjectKey: string,
): AttestationNamespace {
  const backend = assertAttestationConstructionSupported(
    ATTESTATION_HUB_CONSTRUCTION,
    "postgres",
  );
  if (typeof trustedProjectKey !== "string" || trustedProjectKey.trim() === "") {
    throw new AttestationConstructionUnsupportedError(
      ATTESTATION_HUB_CONSTRUCTION,
      "postgres",
      "a trusted project key is required to route a hub namespace",
    );
  }
  return Object.freeze({ backend, projectKey: trustedProjectKey });
}

// ---------------------------------------------------------------------------
// The factory: namespace + construction-specific wiring -> a live backend
// ---------------------------------------------------------------------------

/** Where the filesystem attestation store lives for the `fs` ledger backend. */
export function fsAttestationProductionRoot(ledgerRoot: string): string {
  return `${ledgerRoot}/${LEDGER_STORAGE_DIRNAME}/attestations`;
}

export interface XdgAttestationConstructionInput {
  readonly backend: "xdg";
  readonly namespace: AttestationNamespace;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface FsAttestationConstructionInput {
  readonly backend: "fs";
  readonly namespace: AttestationNamespace;
  /** The ledger's own root — the attestation store is rooted alongside it. */
  readonly ledgerRoot: string;
}

export interface PostgresAttestationConstructionInput {
  readonly backend: "postgres";
  readonly namespace: AttestationNamespace;
  readonly pool: SQL;
  /** Close `pool` when the returned backend closes. Default `false`. */
  readonly ownsPool?: boolean;
}

export type AttestationConstructionStoreInput =
  | XdgAttestationConstructionInput
  | FsAttestationConstructionInput
  | PostgresAttestationConstructionInput;

/**
 * Build the concrete {@link AttestationBackend} for an ALREADY-RESOLVED
 * namespace (from one of the two functions above). Does NOT re-validate the
 * namespace's backend itself — each concrete adapter's own constructor already
 * does (`SqliteAttestationBackend`/`FsAttestationBackend`/
 * `PostgresAttestationBackend` each call their own `assert*Namespace`), so a
 * namespace for an excluded backend still refuses here, at the adapter
 * boundary, rather than being silently accepted. A prior revision duplicated
 * that check at this level too; it was REMOVED after mutation-testing showed
 * it dead — deleting it changed no observable behaviour, because the adapters
 * were already the ones deciding it.
 */
export async function createAttestationStoreForConstruction(
  input: AttestationConstructionStoreInput,
): Promise<AttestationBackend> {
  switch (input.backend) {
    case "xdg": {
      const dbPath = xdgAttestationDbPath(input.namespace.projectKey, input.env);
      // Mirrors createLedgerStore's ensureStateDir: bun:sqlite's `Database(path,
      // {create:true})` creates the FILE but never its parent directories, and
      // xdgAttestationDbPath's layout (`.../projects/<projectKey>/state/`) is
      // nested well below the XDG state base.
      mkdirSync(dirname(dbPath), { recursive: true });
      return new SqliteAttestationBackend({ namespace: input.namespace, dbPath });
    }
    case "fs": {
      const root = fsAttestationProductionRoot(input.ledgerRoot);
      return new FsAttestationBackend({ namespace: input.namespace, root });
    }
    case "postgres": {
      return PostgresAttestationBackend.open({
        namespace: input.namespace,
        pool: input.pool,
        ...(input.ownsPool !== undefined ? { ownsPool: input.ownsPool } : {}),
      });
    }
  }
}

// Re-exported so a caller of this module never needs a second import from
// `@cq/config` just to name the backend set this matrix's cells range over.
export { ATTESTATION_STORE_BACKENDS, ATTESTATION_IN_MEMORY_BACKEND };
export type { AttestationStoreBackend, LedgerBackend };
