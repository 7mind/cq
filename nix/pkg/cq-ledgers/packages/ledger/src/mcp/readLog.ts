/**
 * read_log capability (T147 / Q87).
 *
 * The `read_log` MCP tool performs a bounded, root-confined read of a file under
 * `<root>/.cq/logs/`. Per R137 #6 the confinement root is the EXPLICIT
 * FsLedgerStore root, NOT the generic `LedgerStore` interface (no root accessor;
 * its in-memory impl has no filesystem). So the capability is a standalone
 * function type the FS-store layer supplies (closing over its `<root>/.cq/logs`)
 * and threads explicitly into the tool factories. Wired over an in-memory store
 * (no filesystem), no capability is supplied and `read_log` throws
 * `ReadLogNotImplementedError`.
 */

/** Result of a bounded read of a .cq/logs file. */
export interface ReadLogResult {
  /** The repo-relative path requested (echoed back, normalised). */
  path: string;
  /** The file content (possibly truncated to {@link MAX_READ_LOG_BYTES}). */
  content: string;
  /** Present and `true` only when the file exceeded the byte cap. */
  truncated?: boolean;
}

/**
 * A bounded read-log capability: resolves `relPath` against `<root>/.cq/logs`,
 * rejects any path escaping that directory, and caps the returned size.
 * Supplied by the FS-store layer; absent for in-memory-backed factories.
 */
export type ReadLogCapability = (relPath: string) => Promise<ReadLogResult>;

/**
 * Maximum number of bytes `read_log` returns. Per decision K42 (Q124 'render
 * everything'), this cap is relaxed from 256 KiB to 4 MiB to allow most real
 * session logs to return complete. Files exceeding this bound are truncated and
 * flagged `truncated: true` as a defensive fallback, so the W3 sessionLogs
 * popup viewer (T152) cannot overflow the tool output.
 */
export const MAX_READ_LOG_BYTES = 4 * 1024 * 1024;

/**
 * Thrown when `read_log` is invoked on a factory wired over a store with no
 * filesystem (the in-memory dummy used in dual-tests). Documented behaviour:
 * the OTHER ops remain unaffected and read_log's path-confinement test runs
 * only against the FS-backed configuration.
 */
export class ReadLogNotImplementedError extends Error {
  constructor() {
    super(
      "read_log is not implemented for this store: no filesystem-backed " +
        "<root>/.cq/logs is available (in-memory store)",
    );
    this.name = "ReadLogNotImplementedError";
  }
}
