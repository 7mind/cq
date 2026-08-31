/**
 * RemoteLedgerClient — the ONE async authenticated remote MCP client shared by
 * the CLI, TUI, and web-facing launch code (T727).
 *
 * The client speaks to a `cq serve` hub (ledger-web/src/hubServe.ts,
 * T586–T588):
 *
 *  - URL derivation: the hub mounts each tenant's Streamable HTTP MCP endpoint
 *    at `/p/<projectKey>/mcp` on the hub origin (Q283 lock: URL-path
 *    addressing). {@link remoteMcpUrl} derives that endpoint from the
 *    configured non-secret `serverUrl` (cq.toml `[ledger].serverUrl`,
 *    `backend = "remote"`, T723) by keeping protocol + host and replacing the
 *    path wholesale — the same derivation ledger-tui's `projectMcpUrl`
 *    performs from a base MCP URL.
 *  - Authentication: every request carries `Authorization: Bearer <token>`
 *    (the hub's T588/Q273 gate) plus the bounded project display-name header
 *    {@link PROJECT_DISPLAY_NAME_HEADER}, which an authenticated initialize
 *    uses to label/register the tenant. The token resolves from
 *    `CQ_LEDGER_REMOTE_TOKEN` (the only ordinary bearer source — @cq/config
 *    remoteToken.ts); it never enters cq.toml and is never echoed into an
 *    error message here either.
 *  - Protocol: MCP initialize/version negotiation and the CURRENT ledger tool
 *    schemas are the external routine API. This client is a thin typed
 *    transport over that tool surface — it is NOT a LedgerStore and holds no
 *    store-over-HTTP cache (that adapter is deliberately out of scope).
 *
 * Fail-loud boundaries (each a dedicated error class, never a silent
 * fallback):
 *  - auth: HTTP 401/403 → {@link RemoteAuthError} (the token is never
 *    embedded in the message);
 *  - unavailable service: a connection-level failure or a non-auth non-2xx
 *    HTTP status → {@link RemoteUnavailableError};
 *  - protocol: MCP/JSON-RPC errors (unknown tool, unsupported protocol
 *    version) → {@link RemoteProtocolError};
 *  - malformed response: a tool result without a text content block, or text
 *    that is not valid JSON → {@link RemoteMalformedResponseError};
 *  - remote tool error: a result flagged `isError` → {@link RemoteToolError}
 *    carrying the server's message VERBATIM (remote error preservation).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ArchivePointer, FieldValue, Item, LedgerSchema } from "../../types.js";
import type { ArchiveContent } from "../LedgerStore.js";
import type { FinalizeBatchOperation } from "../../finalize.js";
import type { BackupDumpFile } from "../backupExporter.js";
import type {
  CompactItemDto,
  ComplementItemDto,
  FetchedLedgerDto,
  FetchedMilestoneDto,
  FtsSearchResultDto,
  FullItemDto,
  ItemDto,
  ItemMutationAckDto,
  ItemProjection,
  LedgerMutationAckDto,
  MilestoneItemGroupsDto,
  MilestoneMutationAckDto,
  PaginatedLedgerDto,
} from "../../mcp/wireResponseContract.js";
import type { ReadLogResult } from "../../mcp/readLog.js";
import type { ListProjectsResult, ProjectEntry } from "../../mcp/listProjects.js";
import type { DerivedPredicates } from "../predicates.js";
import type { LedgerSnapshot } from "../../snapshot.js";
import type { LedgerSummariesResult } from "../../summaries.js";
import type { UsageStatsSnapshot } from "../../usageStats.js";
import type {
  AcknowledgeOperatorActionResult,
  MaterializedOperatorAction,
  OperatorActionShellEvidence,
  RecordOperatorActionEvidenceResult,
  RevisedOperatorAction,
  SupersededOperatorAction,
} from "../../operatorActions.js";
import type {
  WorksetRequest,
  WorksetResultFor,
} from "../../mcp/worksetTool.js";
import type {
  PlanClaimInput,
  PlanClaimResult,
  PlanFinalizeInput,
  PlanFinalizeResult,
  PlanPublishDraftInput,
  PlanPublishDraftResult,
  PlanReleaseInput,
  PlanReleaseResult,
} from "../../planLifecycle.js";
import type {
  ExecuteExternalImplementationReviewAttemptInput,
  ExecuteExternalImplementationAuditAttemptInput,
  FinalizeImplementationReviewAttemptInput,
  FinalizeImplementationAuditAttemptInput,
  ImplementationEvidenceService,
  ImplementationEvidenceActivationStatusInput,
  ContinueImplementationEvidenceActivationInput,
  AdvanceImplementationEvidenceBootstrapInput,
  ApplyImplementationAuditManifestInput,
  ArmImplementationEvidenceActivationInput,
  PrepareImplementationAuditAttemptInput,
  PrepareImplementationAuditFallbackInput,
  PrepareImplementationAuditPanelInput,
  PrepareImplementationCompletionInput,
  PrepareImplementationReviewAttemptInput,
  PrepareImplementationReviewFallbackInput,
  PrepareImplementationReviewPanelInput,
  RecordImplementationCompletionInput,
} from "../../implementationEvidence.js";

/**
 * Authenticated MCP initialize metadata used to label the project registry
 * and session. This is the SINGLE definition — the `cq serve` hub
 * (ledger-web/src/hubServe.ts) re-exports it so client and server can never
 * drift on the header name.
 */
export const PROJECT_DISPLAY_NAME_HEADER = "x-cq-project-display-name";

/** Bound untrusted request metadata before persisting it or echoing it in MCP metadata. */
export const PROJECT_DISPLAY_NAME_MAX_BYTES = 256;

/** Base class of every error this client raises on a service boundary. */
export class RemoteLedgerClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteLedgerClientError";
  }
}

/** The service rejected the bearer credential (HTTP 401/403). Never carries the token. */
export class RemoteAuthError extends RemoteLedgerClientError {
  constructor(endpoint: string, status: number) {
    super(
      `remote ledger service at ${endpoint} rejected the bearer token ` +
        `(HTTP ${String(status)})`,
    );
    this.name = "RemoteAuthError";
  }
}

/** The service could not be reached or answered a non-auth non-2xx HTTP status. */
export class RemoteUnavailableError extends RemoteLedgerClientError {
  constructor(endpoint: string, detail: string) {
    super(`remote ledger service at ${endpoint} is unavailable: ${detail}`);
    this.name = "RemoteUnavailableError";
  }
}

/** An MCP/JSON-RPC protocol failure (unknown tool, unsupported protocol version). */
export class RemoteProtocolError extends RemoteLedgerClientError {
  constructor(endpoint: string, tool: string | null, detail: string) {
    super(
      `remote ledger protocol error at ${endpoint}` +
        (tool !== null ? ` calling ${tool}` : "") +
        `: ${detail}`,
    );
    this.name = "RemoteProtocolError";
  }
}

/** A tool result that is not the expected single text content block holding JSON. */
export class RemoteMalformedResponseError extends RemoteLedgerClientError {
  constructor(tool: string, detail: string) {
    super(`malformed response from remote ledger tool ${tool}: ${detail}`);
    this.name = "RemoteMalformedResponseError";
  }
}

/** A tool result flagged `isError`; `message` is the server's message VERBATIM. */
export class RemoteToolError extends RemoteLedgerClientError {
  constructor(
    public readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteToolError";
  }
}

/** The display name exceeded {@link PROJECT_DISPLAY_NAME_MAX_BYTES} (client-side bound). */
export class RemoteDisplayNameError extends RemoteLedgerClientError {
  constructor(byteLength: number) {
    super(
      `${PROJECT_DISPLAY_NAME_HEADER} value exceeds ` +
        `${String(PROJECT_DISPLAY_NAME_MAX_BYTES)} bytes (got ${String(byteLength)})`,
    );
    this.name = "RemoteDisplayNameError";
  }
}

/** A non-HTTP(S) `serverUrl` cannot address a `cq serve` hub. */
export class RemoteLedgerClientConfigError extends RemoteLedgerClientError {
  constructor(serverUrl: string) {
    super(
      `remote ledger serverUrl ${JSON.stringify(serverUrl)} is not an absolute ` +
        "http(s) endpoint",
    );
    this.name = "RemoteLedgerClientConfigError";
  }
}

export class RemoteManagementScopeError extends RemoteLedgerClientError {
  constructor(operation = "workset set") {
    super(`${operation} requires a management-bound remote session`);
    this.name = "RemoteManagementScopeError";
  }
}

/**
 * Derive a `cq serve` hub's per-project MCP endpoint from the configured
 * `serverUrl`: same origin, path replaced wholesale with
 * `/p/<encodeURIComponent(projectKey)>/mcp` (Q283 lock).
 *
 * Throws `TypeError` from `new URL` when `serverUrl` is not an absolute URL,
 * and {@link RemoteLedgerClientConfigError} when it is not HTTP(S).
 */
export function remoteMcpUrl(serverUrl: string, projectKey: string): string {
  const u = new URL(serverUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new RemoteLedgerClientConfigError(serverUrl);
  }
  return `${u.protocol}//${u.host}/p/${encodeURIComponent(projectKey)}/mcp`;
}

export function remoteAdminMcpUrl(serverUrl: string, projectKey: string): string {
  return remoteMcpUrl(serverUrl, projectKey).replace(/\/mcp$/, "/admin/mcp");
}

/** Connection parameters for {@link RemoteLedgerClient.connect}. */
export interface RemoteLedgerClientOpts {
  /** The hub origin (cq.toml `[ledger].serverUrl`), e.g. `http://127.0.0.1:5190/`. */
  readonly serverUrl: string;
  /** The tenant projectKey to connect to. */
  readonly projectKey: string;
  /** The bearer token (resolved from `CQ_LEDGER_REMOTE_TOKEN` by the caller). */
  readonly token: string;
  /**
   * The project display name sent on {@link PROJECT_DISPLAY_NAME_HEADER}
   * (trimmed; absent/blank sends no header, so the hub falls back to the
   * projectKey). Must fit {@link PROJECT_DISPLAY_NAME_MAX_BYTES} when encoded
   * UTF-8 — checked client-side before any request is issued.
   */
  readonly displayName?: string;
  /** MCP `clientInfo` override (tests); defaults to the shared client identity. */
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

/** Connection parameters for the distinct management-session constructor. */
export interface RemoteLedgerManagementClientOpts {
  readonly serverUrl: string;
  readonly projectKey: string;
  /** The management credential; ordinary `token` is intentionally not accepted. */
  readonly managementToken: string;
  readonly displayName?: string;
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

interface RemoteLedgerConnectionOpts {
  readonly serverUrl: string;
  readonly projectKey: string;
  readonly credential: string;
  readonly displayName?: string;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  readonly scope: "ordinary" | "management" | "admin";
  readonly endpoint?: string;
}

/** `create_item` input (mirrors the tool schema). */
export interface RemoteItemInit {
  readonly status: string;
  readonly fields: Record<string, FieldValue>;
  readonly id?: string;
  readonly author?: string;
  readonly session?: string;
}

/** `update_item` patch (mirrors the tool schema). */
export interface RemoteItemPatch {
  readonly status?: string;
  readonly fields?: Record<string, FieldValue>;
  readonly author?: string;
  readonly session?: string;
}

/** Root-milestone creation input for the generic item tool. */
export interface RemoteMilestoneInit {
  readonly title: string;
  readonly description?: string;
  readonly blockedBy?: string[];
  readonly dependsOn?: string[];
  readonly id?: string;
  readonly author?: string;
  readonly session?: string;
}

/** Root-milestone update patch for the generic item tool. */
export interface RemoteMilestonePatch {
  readonly status?: string;
  readonly title?: string;
  readonly description?: string;
  readonly blockedBy?: string[];
  readonly dependsOn?: string[];
  readonly author?: string;
  readonly session?: string;
}

/** `fts_search` optional params (mirrors the tool schema). */
export interface RemoteFtsSearchOpts {
  readonly ledger?: string;
  readonly limit?: number;
  readonly fuzzy?: boolean;
  readonly prefix?: boolean;
  readonly status?: string;
  readonly includeArchived?: boolean;
}

interface CallToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

const VERSION_NEGOTIATION_RE = /protocol version is not supported/;

/**
 * Classify a thrown SDK/transport error into the fail-loud boundary taxonomy;
 * returns the original error when no known boundary matches (a client-side
 * defect must surface as itself, not be relabelled).
 */
function toRemoteError(err: unknown, endpoint: string, tool: string | null): unknown {
  if (err instanceof RemoteLedgerClientError) return err;
  if (err instanceof McpError) {
    return new RemoteProtocolError(endpoint, tool, err.message);
  }
  if (err instanceof StreamableHTTPError) {
    if (err.code === 401 || err.code === 403) {
      return new RemoteAuthError(endpoint, err.code);
    }
    return new RemoteUnavailableError(endpoint, `HTTP status ${String(err.code)}`);
  }
  if (err instanceof Error) {
    if (VERSION_NEGOTIATION_RE.test(err.message)) {
      return new RemoteProtocolError(endpoint, tool, err.message);
    }
    // Bun surfaces a refused connection as an Error with a string `code`
    // (e.g. "ConnectionRefused"); Node/undici surfaces TypeError("fetch failed").
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" || err instanceof TypeError) {
      return new RemoteUnavailableError(endpoint, err.message);
    }
  }
  return err;
}

/** Normalize the optional display name, enforcing the shared byte bound client-side. */
function normalizeDisplayName(displayName: string | undefined): string | undefined {
  if (displayName === undefined) return undefined;
  const trimmed = displayName.trim();
  if (trimmed === "") return undefined;
  const byteLength = new TextEncoder().encode(trimmed).byteLength;
  if (byteLength > PROJECT_DISPLAY_NAME_MAX_BYTES) {
    throw new RemoteDisplayNameError(byteLength);
  }
  return trimmed;
}

/**
 * The shared authenticated remote MCP client. Construct ONLY via
 * {@link RemoteLedgerClient.connect} (the async connection resolver): it
 * derives the per-project endpoint, runs MCP initialize/version negotiation,
 * and captures the negotiated protocol version + project display name.
 */
export class RemoteLedgerClient {
  private constructor(
    private readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
    private readonly endpoint: string,
    private readonly _displayName: string,
    private readonly _protocolVersion: string,
    private readonly _scope: "ordinary" | "management" | "admin",
  ) {}

  /**
   * Connect to a `cq serve` hub's per-project MCP endpoint. The bearer token
   * and (bounded) display-name header ride the transport's `requestInit`, so
   * EVERY transport request (initialize included) is authenticated.
   */
  static async connect(opts: RemoteLedgerClientOpts): Promise<RemoteLedgerClient> {
    return await RemoteLedgerClient.connectWithCredential({
      serverUrl: opts.serverUrl,
      projectKey: opts.projectKey,
      credential: opts.token,
      ...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
      ...(opts.clientInfo === undefined ? {} : { clientInfo: opts.clientInfo }),
      scope: "ordinary",
    });
  }

  static async connectAdmin(opts: {
    readonly serverUrl: string;
    readonly projectKey: string;
    readonly adminToken: string;
    readonly clientInfo?: { readonly name: string; readonly version: string };
  }): Promise<RemoteLedgerClient> {
    return await RemoteLedgerClient.connectWithCredential({
      serverUrl: opts.serverUrl,
      projectKey: opts.projectKey,
      credential: opts.adminToken,
      ...(opts.clientInfo === undefined ? {} : { clientInfo: opts.clientInfo }),
      scope: "admin",
      endpoint: remoteAdminMcpUrl(opts.serverUrl, opts.projectKey),
    });
  }

  /** Connect a management-bound session using only the distinct management credential. */
  static async connectManagement(
    opts: RemoteLedgerManagementClientOpts,
  ): Promise<RemoteLedgerClient> {
    return await RemoteLedgerClient.connectWithCredential({
      serverUrl: opts.serverUrl,
      projectKey: opts.projectKey,
      credential: opts.managementToken,
      ...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
      ...(opts.clientInfo === undefined ? {} : { clientInfo: opts.clientInfo }),
      scope: "management",
    });
  }

  private static async connectWithCredential(
    opts: RemoteLedgerConnectionOpts,
  ): Promise<RemoteLedgerClient> {
    const endpoint = opts.endpoint ?? remoteMcpUrl(opts.serverUrl, opts.projectKey);
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.credential}`,
    };
    const displayName = normalizeDisplayName(opts.displayName);
    if (displayName !== undefined) {
      headers[PROJECT_DISPLAY_NAME_HEADER] = displayName;
    }
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers },
    });
    const client = new Client(
      opts.clientInfo ?? { name: "cq-remote-ledger-client", version: "0.0.1" },
      { capabilities: {} },
    );
    try {
      // The SDK's StreamableHTTPClientTransport declares `sessionId?: string`,
      // which trips exactOptionalPropertyTypes against the Transport
      // interface; the shapes are behaviourally identical, so bridge the
      // declaration gap through unknown (same bridge as ledger-tui/web).
      await client.connect(transport as unknown as Transport);
    } catch (err) {
      throw toRemoteError(err, endpoint, null);
    }
    return new RemoteLedgerClient(
      client,
      transport,
      endpoint,
      RemoteLedgerClient.resolveDisplayName(client),
      transport.protocolVersion ?? "",
      opts.scope,
    );
  }

  /**
   * Read the project display name from the SDK client after a successful
   * connect. Primary carrier: `serverInfo.title`; fallback: the leading
   * `'Project: <name>'` instructions line (the redundant carrier for SDK
   * runtimes that drop `title`). Mirrors the resolution ledger-tui/web use.
   */
  private static resolveDisplayName(client: Client): string {
    try {
      const title = client.getServerVersion()?.title;
      if (title !== undefined && title !== "") return title;
      const instructions = client.getInstructions() ?? "";
      const first = instructions.split("\n")[0] ?? "";
      const m = /^Project:\s+(.+)$/.exec(first.trim());
      if (m !== null && m[1] !== undefined && m[1] !== "") return m[1];
    } catch {
      // stub/test client that doesn't implement SDK query methods
    }
    return "";
  }

  /** The project display name the server surfaced at connect time. */
  displayName(): string {
    return this._displayName;
  }

  /** The MCP protocol version negotiated at connect time. */
  protocolVersion(): string {
    return this._protocolVersion;
  }

  /** Runtime-observable connection scope; contains no credential material. */
  connectionScope(): "ordinary" | "management" | "admin" {
    return this._scope;
  }

  /** The derived `/p/<projectKey>/mcp` endpoint this client is connected to. */
  get url(): string {
    return this.endpoint;
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    let result: CallToolResultLike;
    try {
      result = (await this.client.callTool({
        name,
        arguments: args,
      })) as CallToolResultLike;
    } catch (err) {
      throw toRemoteError(err, this.endpoint, name);
    }
    const first = result.content?.[0];
    if (result.isError === true) {
      const text = first?.type === "text" ? (first.text ?? "") : "";
      throw new RemoteToolError(name, text || "tool reported an error");
    }
    if (first === undefined || first.type !== "text" || typeof first.text !== "string") {
      throw new RemoteMalformedResponseError(name, "expected a text content block");
    }
    try {
      return JSON.parse(first.text) as T;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RemoteMalformedResponseError(name, `invalid JSON: ${detail}`);
    }
  }

  private requireManagement(operation: string): void {
    if (this._scope !== "management") throw new RemoteManagementScopeError(operation);
  }

  /**
   * Low-level escape hatch: call ANY tool by name and return its parsed JSON
   * payload with no envelope unwrapping. The routine methods below are the
   * supported surface; this exists for forward-compatible probes (and the
   * contract's unknown-tool case), still under the same boundary taxonomy.
   */
  async callToolRaw(name: string, args: Record<string, unknown>): Promise<unknown> {
    return await this.call<unknown>(name, args);
  }

  async workset<R extends WorksetRequest>(request: R): Promise<WorksetResultFor<R>> {
    if (request.op === "set" && this._scope !== "management") {
      throw new RemoteManagementScopeError();
    }
    return await this.call<WorksetResultFor<R>>("workset", { ...request });
  }

  async prepareImplementationReviewPanel(
    input: PrepareImplementationReviewPanelInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["prepareReviewPanel"]>>> {
    this.requireManagement("prepare_implementation_review_panel");
    return await this.call("prepare_implementation_review_panel", {
      task_ref: input.taskRef,
      result_commit: input.resultCommit,
      worker_dispatch: input.workerDispatch,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async prepareImplementationReviewAttempt(
    input: PrepareImplementationReviewAttemptInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["prepareReviewAttempt"]>>> {
    this.requireManagement("prepare_implementation_review_attempt");
    return await this.call("prepare_implementation_review_attempt", {
      panel_ref: input.panelRef,
      attempt_ref: input.attemptRef,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async executeExternalImplementationReviewAttempt(
    input: ExecuteExternalImplementationReviewAttemptInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["executeExternalReviewAttempt"]>>> {
    this.requireManagement("execute_external_implementation_review_attempt");
    return await this.call("execute_external_implementation_review_attempt", {
      attempt_ref: input.attemptRef,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async finalizeImplementationReviewAttempt(
    input: FinalizeImplementationReviewAttemptInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["finalizeReviewAttempt"]>>> {
    this.requireManagement("finalize_implementation_review_attempt");
    return await this.call("finalize_implementation_review_attempt", {
      attempt_ref: input.attemptRef,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async prepareImplementationReviewFallback(
    input: PrepareImplementationReviewFallbackInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["prepareReviewFallback"]>>> {
    this.requireManagement("prepare_implementation_review_fallback");
    return await this.call("prepare_implementation_review_fallback", {
      panel_ref: input.panelRef,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async prepareImplementationAuditPanel(
    input: PrepareImplementationAuditPanelInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["prepareAuditPanel"]>>> {
    this.requireManagement("prepare_implementation_audit_panel");
    return await this.call("prepare_implementation_audit_panel", {
      manifest_id: input.manifestId,
      manifest_digest: input.manifestDigest,
      record_key: input.recordKey,
      expected_repository_head: input.expectedRepositoryHead,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async prepareImplementationAuditAttempt(
    input: PrepareImplementationAuditAttemptInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["prepareAuditAttempt"]>>> {
    this.requireManagement("prepare_implementation_audit_attempt");
    return await this.call("prepare_implementation_audit_attempt", {
      panel_ref: input.panelRef,
      attempt_ref: input.attemptRef,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async executeExternalImplementationAuditAttempt(
    input: ExecuteExternalImplementationAuditAttemptInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["executeExternalAuditAttempt"]>>> {
    this.requireManagement("execute_external_implementation_audit_attempt");
    return await this.call("execute_external_implementation_audit_attempt", {
      attempt_ref: input.attemptRef,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async finalizeImplementationAuditAttempt(
    input: FinalizeImplementationAuditAttemptInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["finalizeAuditAttempt"]>>> {
    this.requireManagement("finalize_implementation_audit_attempt");
    return await this.call("finalize_implementation_audit_attempt", {
      attempt_ref: input.attemptRef,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async prepareImplementationAuditFallback(
    input: PrepareImplementationAuditFallbackInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["prepareAuditFallback"]>>> {
    this.requireManagement("prepare_implementation_audit_fallback");
    return await this.call("prepare_implementation_audit_fallback", {
      panel_ref: input.panelRef,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async armImplementationEvidenceActivation(
    input: ArmImplementationEvidenceActivationInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["armEvidenceActivation"]>>> {
    this.requireManagement("arm_implementation_evidence_activation");
    return await this.call("arm_implementation_evidence_activation", {
      goal_ref: input.goalRef,
      manifest_id: input.manifestId,
      expected_repository_head: input.expectedRepositoryHead,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async advanceImplementationEvidenceBootstrap(
    input: AdvanceImplementationEvidenceBootstrapInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["advanceEvidenceBootstrap"]>>> {
    this.requireManagement("advance_implementation_evidence_bootstrap");
    return await this.call("advance_implementation_evidence_bootstrap", {
      goal_ref: input.goalRef,
      finalized_manifest_digest: input.finalizedManifestDigest,
      expected_repository_head: input.expectedRepositoryHead,
      expected_phase: input.expectedPhase,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async applyImplementationAuditManifest(
    input: ApplyImplementationAuditManifestInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["applyAuditManifest"]>>> {
    this.requireManagement("apply_implementation_audit_manifest");
    return await this.call("apply_implementation_audit_manifest", {
      manifest_id: input.manifestId,
      manifest_digest: input.manifestDigest,
      expected_repository_head: input.expectedRepositoryHead,
      audit_attempt_refs: input.auditAttemptRefs,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async getImplementationEvidenceActivationStatus(
    input: ImplementationEvidenceActivationStatusInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["evidenceActivationStatus"]>>> {
    this.requireManagement("get_implementation_evidence_activation_status");
    return await this.call("get_implementation_evidence_activation_status", {
      goal_ref: input.goalRef,
      manifest_id: input.manifestId,
      expected_repository_head: input.expectedRepositoryHead,
    });
  }

  async continueImplementationEvidenceActivation(
    input: ContinueImplementationEvidenceActivationInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["continueEvidenceActivation"]>>> {
    this.requireManagement("continue_implementation_evidence_activation");
    return await this.call("continue_implementation_evidence_activation", {
      goal_ref: input.goalRef,
      manifest_id: input.manifestId,
      prior_requirement_ref: input.priorRequirementRef,
      completed_task_ref: input.completedTaskRef,
      completion_ref: input.completionRef,
      expected_from_head: input.expectedFromHead,
      expected_repository_head: input.expectedRepositoryHead,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async getImplementationEvidenceServiceStatus(): Promise<
    Awaited<ReturnType<ImplementationEvidenceService["evidenceServiceStatus"]>>
  > {
    this.requireManagement("get_implementation_evidence_service_status");
    return await this.call("get_implementation_evidence_service_status", {});
  }

  async prepareImplementationCompletion(
    input: PrepareImplementationCompletionInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["prepareCompletion"]>>> {
    this.requireManagement("prepare_implementation_completion");
    return await this.call("prepare_implementation_completion", {
      task_ref: input.taskRef,
      expected_repository_head: input.expectedRepositoryHead,
      result_commit: input.resultCommit,
      worker_dispatch: input.workerDispatch,
      review_attempt_refs: input.reviewAttemptRefs,
      completion: input.completion,
      log_paths: input.logPaths,
      merge_operation_id: input.mergeOperationId,
      ...(input.supersedesCompletionRef === undefined
        ? {}
        : { supersedes_completion_ref: input.supersedesCompletionRef }),
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async recordImplementationCompletion(
    input: RecordImplementationCompletionInput,
  ): Promise<Awaited<ReturnType<ImplementationEvidenceService["recordCompletion"]>>> {
    this.requireManagement("record_implementation_completion");
    return await this.call("record_implementation_completion", {
      task_ref: input.taskRef,
      expected_repository_head: input.expectedRepositoryHead,
      operation_id: input.operationId,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  }

  async claimPlan(input: PlanClaimInput): Promise<PlanClaimResult> {
    return await this.call<PlanClaimResult>("claim_plan", { ...input });
  }

  async publishPlanDraft(input: PlanPublishDraftInput): Promise<PlanPublishDraftResult> {
    return await this.call<PlanPublishDraftResult>("publish_plan_draft", { ...input });
  }

  async releasePlanClaim(input: PlanReleaseInput): Promise<PlanReleaseResult> {
    return await this.call<PlanReleaseResult>("release_plan_claim", { ...input });
  }

  async finalizePlan(input: PlanFinalizeInput): Promise<PlanFinalizeResult> {
    return await this.call<PlanFinalizeResult>("finalize_plan", { ...input });
  }

  // ---- Routine read families ---------------------------------------------

  async enumerateLedgers(): Promise<LedgerSummariesResult> {
    return await this.call<LedgerSummariesResult>("enumerate_ledgers", {});
  }

  async fetchLedger(
    ledgerId: string,
    projection: ItemProjection,
  ): Promise<FetchedLedgerDto> {
    return (
      await this.call<{ ledger: FetchedLedgerDto }>("fetch_ledger", {
        ledger_id: ledgerId,
        projection,
      })
    ).ledger;
  }

  async fetchLedgerPage(
    ledgerId: string,
    projection: ItemProjection,
    page: { offset?: number; limit?: number },
  ): Promise<PaginatedLedgerDto> {
    const args: Record<string, unknown> = { ledger_id: ledgerId, projection };
    if (page.offset !== undefined) args["offset"] = page.offset;
    if (page.limit !== undefined) args["limit"] = page.limit;
    return await this.call<PaginatedLedgerDto>("fetch_ledger", args);
  }

  async fetchLedgerArchive(
    ledgerId: string,
    archiveId: string,
  ): Promise<ArchiveContent> {
    return (
      await this.call<{ archive: ArchiveContent }>("fetch_ledger_archive", {
        ledger_id: ledgerId,
        archive_id: archiveId,
      })
    ).archive;
  }

  async fetchItem(
    ledgerId: string,
    itemId: string,
    projection: "compact",
  ): Promise<CompactItemDto>;
  async fetchItem(
    ledgerId: string,
    itemId: string,
    projection: "full",
  ): Promise<FullItemDto>;
  async fetchItem(
    ledgerId: string,
    itemId: string,
    projection: "complement",
  ): Promise<ComplementItemDto>;
  async fetchItem(
    ledgerId: string,
    itemId: string,
    projection: ItemProjection,
  ): Promise<ItemDto>;
  async fetchItem(
    ledgerId: string,
    itemId: string,
    projection: ItemProjection,
  ): Promise<ItemDto> {
    return (
      await this.call<{ item: ItemDto }>("fetch_item", {
        ledger_id: ledgerId,
        item_id: itemId,
        projection,
      })
    ).item;
  }

  async searchItems(
    ledgerId: string,
    query: string,
    projection: ItemProjection,
  ): Promise<ItemDto[]> {
    return (
      await this.call<{ items: ItemDto[] }>("search_items", {
        ledger_id: ledgerId,
        query,
        projection,
      })
    ).items;
  }

  async ftsSearch(
    query: string,
    projection: ItemProjection,
    opts?: RemoteFtsSearchOpts,
  ): Promise<FtsSearchResultDto[]> {
    const args: Record<string, unknown> = { query, projection };
    if (opts?.ledger !== undefined) args["ledger"] = opts.ledger;
    if (opts?.limit !== undefined) args["limit"] = opts.limit;
    if (opts?.fuzzy !== undefined) args["fuzzy"] = opts.fuzzy;
    if (opts?.prefix !== undefined) args["prefix"] = opts.prefix;
    if (opts?.status !== undefined) args["status"] = opts.status;
    if (opts?.includeArchived !== undefined) {
      args["include_archived"] = opts.includeArchived;
    }
    return (
      await this.call<{ results: FtsSearchResultDto[] }>("fts_search", args)
    ).results;
  }

  async snapshot(): Promise<LedgerSnapshot> {
    return (await this.call<{ ledger: LedgerSnapshot }>("snapshot", {})).ledger;
  }

  async derivePredicates(): Promise<DerivedPredicates> {
    return await this.call<DerivedPredicates>("derive_predicates", {});
  }

  async getUsageStats(): Promise<UsageStatsSnapshot> {
    return await this.call<UsageStatsSnapshot>("get_usage_stats", {});
  }

  async fetchMilestone(
    milestoneId: string,
    projection: ItemProjection,
  ): Promise<FetchedMilestoneDto> {
    const fetched = await this.call<{
      item: FetchedMilestoneDto["milestone"];
      resolved: FetchedMilestoneDto["resolved"];
      references: FetchedMilestoneDto["references"];
    }>("fetch_item", {
      ledger_id: "milestones",
      item_id: milestoneId,
      projection,
    });
    return {
      milestone: fetched.item,
      resolved: fetched.resolved,
      references: fetched.references,
    };
  }

  async listMilestoneItems(
    milestoneId: string,
    projection: ItemProjection,
  ): Promise<MilestoneItemGroupsDto> {
    return (
      await this.call<{ items: MilestoneItemGroupsDto }>(
        "list_milestone_items",
        { milestone_id: milestoneId, projection },
      )
    ).items;
  }

  async listProjects(): Promise<ProjectEntry[]> {
    return (await this.call<ListProjectsResult>("list_projects", {})).projects;
  }

  async readLog(path: string): Promise<ReadLogResult> {
    return await this.call<ReadLogResult>("read_log", { path });
  }

  // ---- Routine write families --------------------------------------------

  async createItem(
    ledgerId: string,
    milestoneId: string,
    init: RemoteItemInit,
  ): Promise<ItemMutationAckDto> {
    const args: Record<string, unknown> = {
      ledger_id: ledgerId,
      milestone_id: milestoneId,
      status: init.status,
      fields: init.fields,
    };
    if (init.id !== undefined) args["id"] = init.id;
    if (init.author !== undefined) args["author"] = init.author;
    if (init.session !== undefined) args["session"] = init.session;
    return (
      await this.call<{ item: ItemMutationAckDto }>("create_item", args)
    ).item;
  }

  async updateItem(
    ledgerId: string,
    itemId: string,
    patch: RemoteItemPatch,
  ): Promise<ItemMutationAckDto> {
    const args: Record<string, unknown> = {
      ledger_id: ledgerId,
      item_id: itemId,
    };
    if (patch.status !== undefined) args["status"] = patch.status;
    if (patch.fields !== undefined) args["fields"] = patch.fields;
    if (patch.author !== undefined) args["author"] = patch.author;
    if (patch.session !== undefined) args["session"] = patch.session;
    return (
      await this.call<{ item: ItemMutationAckDto }>("update_item", args)
    ).item;
  }

  async createMilestone(init: RemoteMilestoneInit): Promise<MilestoneMutationAckDto> {
    const fields: Record<string, FieldValue> = { title: init.title };
    if (init.description !== undefined) fields["description"] = init.description;
    if (init.blockedBy !== undefined) fields["blockedBy"] = init.blockedBy;
    if (init.dependsOn !== undefined) fields["dependsOn"] = init.dependsOn;
    const args: Record<string, unknown> = {
      ledger_id: "milestones",
      status: "open",
      fields,
    };
    if (init.id !== undefined) args["id"] = init.id;
    if (init.author !== undefined) args["author"] = init.author;
    if (init.session !== undefined) args["session"] = init.session;
    return (await this.call<{ item: ItemMutationAckDto }>("create_item", args)).item;
  }

  async updateMilestone(
    milestoneId: string,
    patch: RemoteMilestonePatch,
  ): Promise<MilestoneMutationAckDto> {
    const fields: Record<string, FieldValue> = {};
    const args: Record<string, unknown> = {
      ledger_id: "milestones",
      item_id: milestoneId,
    };
    if (patch.status !== undefined) args["status"] = patch.status;
    if (patch.title !== undefined) fields["title"] = patch.title;
    if (patch.description !== undefined) fields["description"] = patch.description;
    if (patch.blockedBy !== undefined) fields["blockedBy"] = patch.blockedBy;
    if (patch.dependsOn !== undefined) fields["dependsOn"] = patch.dependsOn;
    if (Object.keys(fields).length > 0) args["fields"] = fields;
    if (patch.author !== undefined) args["author"] = patch.author;
    if (patch.session !== undefined) args["session"] = patch.session;
    return (await this.call<{ item: ItemMutationAckDto }>("update_item", args)).item;
  }

  async createLedger(
    name: string,
    schema: LedgerSchema,
  ): Promise<LedgerMutationAckDto> {
    return (
      await this.call<{ ledger: LedgerMutationAckDto }>("create_ledger", {
        name,
        schema,
      })
    ).ledger;
  }

  async archiveMilestone(
    milestoneId: string,
    summary: string,
  ): Promise<ArchivePointer> {
    return (
      await this.call<{ pointer: ArchivePointer }>("archive_milestone", {
        milestone_id: milestoneId,
        summary,
      })
    ).pointer;
  }

  async executeFinalize(
    operations: readonly FinalizeBatchOperation[],
  ): Promise<{ applied: number }> {
    return await this.call<{ applied: number }>("execute_finalize", {
      operations: operations.map((operation) => ({
        id: operation.id,
        target_id: operation.targetId,
        action: operation.action,
        ...(operation.targetStatus === undefined
          ? {}
          : { target_status: operation.targetStatus }),
        ...(operation.summary === undefined ? {} : { summary: operation.summary }),
      })),
    });
  }

  async reopenItem(
    ledgerId: string,
    itemId: string,
    toStatus: string,
  ): Promise<ItemMutationAckDto> {
    return (
      await this.call<{ item: ItemMutationAckDto }>("reopen_item", {
        ledger_id: ledgerId,
        item_id: itemId,
        to_status: toStatus,
      })
    ).item;
  }

  async unarchiveItem(
    ledgerId: string,
    milestoneId: string,
    itemId: string,
  ): Promise<ItemMutationAckDto> {
    return (
      await this.call<{ item: ItemMutationAckDto }>("unarchive_item", {
        ledger_id: ledgerId,
        milestone_id: milestoneId,
        item_id: itemId,
      })
    ).item;
  }

  async materializeOperatorAction(input: {
    taskId: string;
    expectedOutputIdentity: string;
    expectedEvidence: string[];
    author: string;
    session?: string;
  }): Promise<MaterializedOperatorAction> {
    const args: Record<string, unknown> = {
      task_id: input.taskId,
      expected_output_identity: input.expectedOutputIdentity,
      expected_evidence: input.expectedEvidence,
      author: input.author,
    };
    if (input.session !== undefined) args["session"] = input.session;
    return await this.call<MaterializedOperatorAction>("materialize_operator_action", args);
  }

  async acknowledgeOperatorAction(input: {
    actionId: string;
    expectedRevision: number;
    outputIdentity: string;
    acknowledgedAt: string;
    session?: string;
  }): Promise<AcknowledgeOperatorActionResult> {
    const args: Record<string, unknown> = {
      action_id: input.actionId,
      expected_revision: input.expectedRevision,
      output_identity: input.outputIdentity,
      acknowledged_at: input.acknowledgedAt,
    };
    if (input.session !== undefined) args["session"] = input.session;
    return await this.call<AcknowledgeOperatorActionResult>("acknowledge_operator_action", args);
  }

  async recordOperatorActionEvidence(input: {
    actionId: string;
    expectedRevision: number;
    evidence: OperatorActionShellEvidence;
    author: string;
    session?: string;
  }): Promise<RecordOperatorActionEvidenceResult> {
    const args: Record<string, unknown> = {
      action_id: input.actionId,
      expected_revision: input.expectedRevision,
      command: input.evidence.command,
      stdout: input.evidence.stdout,
      stderr: input.evidence.stderr,
      exit_code: input.evidence.exitCode,
      output_identity: input.evidence.outputIdentity,
      observed_at: input.evidence.observedAt,
      author: input.author,
    };
    if (input.session !== undefined) args["session"] = input.session;
    return await this.call<RecordOperatorActionEvidenceResult>(
      "record_operator_action_evidence",
      args,
    );
  }

  async reviseOperatorAction(input: {
    actionId: string;
    expectedRevision: number;
    expectedOutputIdentity: string;
    expectedEvidence: string[];
    revisedAt: string;
    author: string;
    session?: string;
  }): Promise<RevisedOperatorAction> {
    const args: Record<string, unknown> = {
      action_id: input.actionId,
      expected_revision: input.expectedRevision,
      expected_output_identity: input.expectedOutputIdentity,
      expected_evidence: input.expectedEvidence,
      revised_at: input.revisedAt,
      author: input.author,
    };
    if (input.session !== undefined) args["session"] = input.session;
    return await this.call<RevisedOperatorAction>("revise_operator_action", args);
  }

  async supersedeOperatorAction(input: {
    actionId: string;
    expectedRevision: number;
    reason: string;
    supersededAt: string;
    author: string;
    session?: string;
  }): Promise<SupersededOperatorAction> {
    const args: Record<string, unknown> = {
      action_id: input.actionId,
      expected_revision: input.expectedRevision,
      disposition: "supersede",
      superseded_reason: input.reason,
      superseded_at: input.supersededAt,
      author: input.author,
    };
    if (input.session !== undefined) args["session"] = input.session;
    return await this.call<SupersededOperatorAction>("revise_operator_action", args);
  }

  async completeOperatorAction(input: {
    actionId: string;
    expectedRevision: number;
    completion: string;
    author: string;
    session?: string;
  }): Promise<Item> {
    const args: Record<string, unknown> = {
      action_id: input.actionId,
      expected_revision: input.expectedRevision,
      completion: input.completion,
      author: input.author,
    };
    if (input.session !== undefined) args["session"] = input.session;
    return (
      await this.call<{ task: Item }>("complete_operator_action", args)
    ).task;
  }

  async putLog(relPath: string, content: string): Promise<{ path: string; stored: true }> {
    return await this.call<{ path: string; stored: true }>("put_log", {
      path: relPath,
      content,
    });
  }

  async exportDump(operationId: string): Promise<BackupDumpFile[]> {
    return (await this.call<{ dump: BackupDumpFile[] }>("export_dump", {
      operation_id: operationId,
    })).dump;
  }

  async importDump(
    operationId: string,
    intent: "migrate-empty" | "restore-replace-confirmed",
    dump: readonly BackupDumpFile[],
  ): Promise<{ imported: true; intent: string }> {
    return await this.call<{ imported: true; intent: string }>("import_dump", {
      operation_id: operationId,
      intent,
      dump,
    });
  }

  async resetProject(operationId: string): Promise<{ reset: true }> {
    return await this.call<{ reset: true }>("reset_project", {
      operation_id: operationId,
    });
  }

  async eraseProject(operationId: string): Promise<{ erased: true }> {
    return await this.call<{ erased: true }>("erase_project", {
      operation_id: operationId,
    });
  }

  async getOperationStatus(operationId: string): Promise<unknown> {
    return await this.call("get_operation_status", { operation_id: operationId });
  }

  /** Close the MCP session and release the transport. */
  async close(): Promise<void> {
    await this.client.close();
  }
}
