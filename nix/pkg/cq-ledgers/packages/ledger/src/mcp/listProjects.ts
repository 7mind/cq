/**
 * list_projects capability (T585 / Q284).
 *
 * The `list_projects` MCP tool answers "what project(s) does this server know
 * about" — the read-side of the multi-tenant Postgres `projects` registry
 * (T572/T577), and a synthesized single-entry answer for every OTHER backend
 * (xdg, in-memory, the legacy fs/git-object stores), which each hold exactly
 * one project. Unlike `read_log`/`get_config`/`fetch_prompt` (which throw a
 * documented not-implemented error when their capability is absent), EVERY
 * real server always answers `list_projects`: the public builder
 * (`createLedgerMcpServer`, ledger-mcp/main.ts) NEVER leaves the capability
 * undefined — it wires the store's own `listProjects()` when the store
 * advertises one (duck-typed, mirroring `readLogOf`/`listLogsOf`), else a
 * closure synthesizing the one-entry fallback from the resolved projectKey +
 * display name. So the frontends need no backend sniffing (Q284): the
 * capability being `undefined` here is only reachable by calling the raw
 * `createLedgerMcpTools` / `registerLedgerStdioTools` factories directly
 * without threading it — the not-implemented error below documents that edge.
 */

/** One project entry: the tenant registry row (postgres) or the single synthesized project (all other backends). */
export interface ProjectEntry {
  /** Stable tenant key — `projects.project_key` (postgres) or the resolved `projectKey` (single-project fallback). */
  key: string;
  /** Human-readable name — `projects.display_name` (postgres) or the server's resolved display name (fallback). */
  displayName: string;
  /** ISO 8601 timestamp, when known. Absent for the single-project fallback (no registration row to read it from). */
  createdAt?: string;
}

/** Result of `list_projects`. */
export interface ListProjectsResult {
  projects: ProjectEntry[];
}

/**
 * A list-projects capability: returns every project this server's store
 * knows about. Supplied by every real server (postgres's genuine multi-tenant
 * query, or the single-project fallback synthesizer) — never left unwired in
 * production.
 */
export type ListProjectsCapability = () => Promise<ListProjectsResult> | ListProjectsResult;

/**
 * Thrown when `list_projects` is invoked on a factory wired with NO
 * `listProjects` capability at all — reachable only by calling
 * `createLedgerMcpTools`/`registerLedgerStdioTools` directly without
 * threading one (the public `createLedgerMcpServer` builder always supplies
 * one, so no real server hits this).
 */
export class ListProjectsNotImplementedError extends Error {
  constructor() {
    super(
      "list_projects is not implemented for this server: no listProjects capability was supplied",
    );
    this.name = "ListProjectsNotImplementedError";
  }
}
