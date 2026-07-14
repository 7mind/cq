/**
 * LedgerPersistence — the NARROW byte-level I/O seam between the ledger store's
 * shared in-memory machinery and its concrete backing store.
 *
 * ## Why this seam exists (G43 / Q190)
 *
 * `FsLedgerStore` today fuses three concerns:
 *   1. SHARED machinery — the in-memory `Map<string, Ledger>`, parse/serialize
 *      (`parseLedger`/`serializeLedger`, `parseRegistry`/`serializeRegistry`,
 *      the archive (de)serializers), the FTS `LedgerSearchIndex`, the per-ledger
 *      `AsyncMutex`, the advisory `Lockfile`, and schema-divergence DETECTION
 *      (`schemasEqual` / `transitionsEqual`).
 *   2. BYTE-LEVEL I/O — the `fs.*` / `atomicWrite` calls that read and write the
 *      raw `string` source of the registry, each ledger `.md`, and each archive
 *      file, plus the schema-divergence BACKUP action.
 *   3. Locator/layout — `.cq/ledgers.yaml`, `.cq/<name>.md`,
 *      `.cq/archive/<name>/<id>.md`, `.cq/.backup/<ts>/`.
 *
 * Per the answered Q190 the byte-level I/O (concern 2) is the ONLY thing that
 * differs between the filesystem backend (`FsLedgerStore`) and the planned
 * git-object backend (`GitObjectLedgerBackend`): one reads/writes files under
 * `.cq/`, the other reads/writes blobs addressed by a git tree/ref. Everything
 * in concern 1 — the map, the parse/serialize, the FTS index, the mutex, the
 * lockfile, and `schemasEqual` — stays in a SHARED base class that both backends
 * extend (the base is extracted in the NEXT task **T350**; the git backend is
 * **T351**). This interface is the contract that base talks to.
 *
 * ## Scope of THIS task (T347) — INTERFACE DEFINITION ONLY
 *
 * This file ONLY declares the typed seam plus doc comments. It moves NO
 * implementation: `FsLedgerStore` is unchanged and does not yet implement this
 * interface. The method set below was derived by auditing EVERY `fs.*` /
 * `atomicWrite` call-site in `FsLedgerStore.ts`; each method's doc comment names
 * the call-site(s) it abstracts. The seam may stay unused until T350 wires it.
 *
 * ## Deliberately OUT of the seam
 *
 * These `fs.*` call-sites in `FsLedgerStore` are NOT persistence-seam concerns
 * and are intentionally absent from this interface:
 *   - `fs.mkdir(docsDir|locksDir|archiveDir)` in `init()` — directory bootstrap
 *     is an fs-layout detail; a git backend has no directories. (A concrete
 *     `LedgerPersistence` impl performs any directory bootstrap it needs lazily
 *     inside its own `write*` methods, as `atomicWrite` already does via its
 *     leading `fs.mkdir(dirname, { recursive: true })`.)
 *   - the advisory lockfile (`Lockfile.acquire`, `.cq/.locks/*`) — stays in the
 *     shared base (concern 1).
 *   - `readLog()` (`fs.realpath` / `fs.readFile` under `.cq/logs/`) — a separate
 *     FS-store-only capability (T147 / Q87), explicitly NOT part of the generic
 *     `LedgerStore` surface and NOT a ledger-source byte-I/O operation.
 *
 * ## Path/locator convention
 *
 * `readArchive` / `writeArchive` / `removeArchive` take an archive LOCATOR. In
 * the fs backend this is the absolute path the store already computes
 * (`path.resolve(docsDir, ptr.path)` for reads, `path.resolve(archiveDir, name,
 * "<id>.md")` for writes). The string is treated OPAQUELY by the shared base —
 * the base never parses or constructs it beyond passing back what a backend
 * handed it on an `ArchivePointer.path`; a git backend is free to encode a blob
 * locator in the same `string` slot. Containment/escape checks
 * (`assertWithinDocsRoot`) remain a backend responsibility.
 *
 * ## Multi-writer concurrency contract (T497 / Q246 / K102)
 *
 * Worktrees/clones of one repository share ONE store location (Q246: the XDG
 * state dir of T495, keyed by the repo-identity project key of T496), so
 * MULTIPLE MCP server processes write to the same store CONCURRENTLY. A
 * persistence backend that serves a shared location MUST provide the three
 * guarantees below ACROSS PROCESSES — the in-process `AsyncMutex` and the
 * advisory `Lockfile` in the shared base cover only cq's cooperating same-host
 * writers and are NOT sufficient on their own:
 *
 *  1. **Mutations are serialized or transactionally isolated — zero lost
 *     updates.** When two processes mutate concurrently, BOTH committed writes
 *     take effect: each read-modify-write cycle behind
 *     {@link writeLedgerSource} / {@link writeRegistrySource} /
 *     {@link writeArchive} is atomic with respect to every other process's
 *     cycle. A writer that cannot proceed immediately waits (bounded) or fails
 *     loudly — it never silently overwrites a peer's committed write with
 *     state derived from a stale read.
 *  2. **Readers never observe torn state.** A read ({@link readLedgerSource} /
 *     {@link readRegistrySource} / {@link readArchive}, whether at `init()` or
 *     during a coherence reload) observes either the pre-state or the
 *     post-state of any concurrent mutation — never a partial or interleaved
 *     byte sequence. A parse/read failure caused by a concurrent writer is a
 *     contract violation.
 *  3. **Out-of-band writes are detectable.** {@link currentSourceToken} is the
 *     coherence token that lets a process cheaply detect a peer's committed
 *     write without re-reading the source — see its doc for the token
 *     contract.
 *
 * The MECHANISM is whatever the backend's storage provides — decision K102
 * pins the out-of-tree primary store on bun:sqlite with WAL journal mode +
 * `busy_timeout` (WAL snapshot isolation gives 2; `busy_timeout`-bounded
 * writer serialization gives 1; the database's data version supplies 3). The
 * in-tree `FsLedgerStore` does NOT guarantee 1 across processes in general
 * (its advisory lockfile + reload-under-write-lock serialize cooperating
 * same-host cq writers only; nothing enforces it store-wide), so it is NOT a
 * conforming shared-location backend — the first conforming implementation
 * lands in T498.
 *
 * Conformance is verified by the store-factory-parameterized multi-process
 * stress harness in `test/multiWriterStressHarness.ts` (registered as pending
 * in `test/multi-writer-stress.test.ts` until T498 wires the conforming
 * store).
 */
export interface LedgerPersistence {
  // ---------------------------------------------------------------------------
  // (a) Source reads — init() + coherence reload
  // ---------------------------------------------------------------------------

  /**
   * Read the raw source text of ledger `name` (the `.cq/<name>.md` body), or
   * `null` if it does not exist yet (so the caller bootstraps a fresh ledger).
   *
   * FsLedgerStore call-sites (all `fs.readFile(this.ledgerPath(name), "utf8")`
   * with ENOENT mapped to `null`):
   *   - `init()` — the per-registered-ledger load loop.
   *   - `invalidate()` — the unknown-ledger registry-reload branch.
   *   - `reloadLedgerFromDisk()` — the known-ledger coherence reload.
   */
  readLedgerSource(name: string): Promise<string | null>;

  /**
   * Read the raw source text of the central registry (`.cq/ledgers.yaml`), or
   * `null` if it does not exist yet (so the caller writes `EMPTY_REGISTRY`).
   *
   * FsLedgerStore call-sites (all `fs.readFile(this.registryPath, "utf8")` with
   * ENOENT mapped to `null`):
   *   - `init()` — the "Load registry" step.
   *   - `invalidate()` — the registry reload inside the unknown-ledger branch.
   */
  readRegistrySource(): Promise<string | null>;

  // ---------------------------------------------------------------------------
  // (b) Source writes — persist the in-memory ledger / registry
  // ---------------------------------------------------------------------------

  /**
   * Atomically persist the serialized source `text` of ledger `name`
   * (overwriting any prior version; a reader never observes a partial write).
   *
   * FsLedgerStore call-site:
   *   - `writeLedgerFile()` — `atomicWrite(this.ledgerPath(ledger.id),
   *     serializeLedger(ledger))`, the single funnel every mutation
   *     (`createItem`, `updateItem`, `createMilestone`, `archiveMilestone`,
   *     `unarchiveItem`, `reopenItem`, `createLedger`, and the `init()` /
   *     `backupAndReinit()` rewrites) routes ledger writes through.
   */
  writeLedgerSource(name: string, text: string): Promise<void>;

  /**
   * Atomically persist the serialized source `text` of the central registry
   * (`.cq/ledgers.yaml`).
   *
   * FsLedgerStore call-sites:
   *   - `writeRegistry()` — `atomicWrite(this.registryPath,
   *     serializeRegistry(this.registry))` (called by `init()`, `createLedger()`,
   *     and `backupAndReinit()`).
   *   - `init()` — the first-run bootstrap `fs.writeFile(this.registryPath,
   *     serializeRegistry(EMPTY_REGISTRY), "utf8")` when the registry is absent.
   */
  writeRegistrySource(text: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // (c) Archive I/O — immutable milestone-group / milestone-item archive files
  // ---------------------------------------------------------------------------

  /**
   * Read the raw source text of the archive at `locator` (a milestone-GROUP
   * archive for a non-milestones ledger, or a single milestone-ITEM archive for
   * the milestones ledger — the caller knows which from the owning ledger and
   * parses accordingly). The archive is expected to exist (unlike
   * {@link readLedgerSource}, a missing archive is an error, not `null`), except
   * where the caller wraps the read in its own fail-soft try/catch.
   *
   * FsLedgerStore call-sites (`fs.readFile(absPath, "utf8")`):
   *   - `fetchArchive()` — read `path.resolve(docsDir, ptr.path)` to materialise
   *     an `ArchiveContent` (also reached transitively by `collectArchivedItems`
   *     during FTS archived-index build).
   *   - `unarchiveItem()` — read the pointer's archive file before extraction.
   *   - `backfillLegacyArchivePointers()` — fail-soft read of the milestones
   *     single-ITEM archive to recover legacy pointer title/status.
   */
  readArchive(locator: string): Promise<string>;

  /**
   * Atomically persist the serialized source `text` of the archive at `locator`
   * (creating it on first archive, or rewriting it when `unarchiveItem` extracts
   * one item from a multi-item group and the remainder is re-serialized).
   *
   * FsLedgerStore call-sites (`atomicWrite(absPath, serialize…)`):
   *   - `performArchive()` — write the milestone-GROUP archive
   *     (`serializeArchive(milestone)`) for each participating ledger, and the
   *     milestones single-ITEM archive (`serializeMilestoneItemArchive(item)`).
   *   - `unarchiveItem()` — rewrite the group archive WITHOUT the extracted item
   *     when the group still has remaining items.
   */
  writeArchive(locator: string, text: string): Promise<void>;

  /**
   * Remove the archive at `locator` (idempotent — absence is not an error).
   *
   * FsLedgerStore call-sites (`fs.rm(absPath, { force: true })`):
   *   - `unarchiveItem()` (milestones branch) — drop the single-ITEM archive
   *     after its lone item is re-attached.
   *   - `unarchiveItem()` (group branch) — drop the GROUP archive once its last
   *     remaining item is extracted.
   */
  removeArchive(locator: string): Promise<void>;

  /**
   * Enumerate the archive locators currently held for ledger `name`
   * (the entries under the fs backend's `.cq/archive/<name>/` directory).
   *
   * NOTE — no direct call-site in today's `FsLedgerStore`: the fs store
   * enumerates archives from the IN-MEMORY `Ledger.archivePointers` list
   * (populated at parse time), not by listing `.cq/archive/<name>/`, so it
   * performs no `fs.readdir` here. This method is part of the seam for backend
   * PARITY (Q190): the git-object backend (T351) cannot rely on parsed-in
   * pointers alone and must enumerate the archive blobs under its tree to
   * reconcile pointer state. The shared base (T350) will route any
   * archive-directory enumeration it needs through this method rather than a
   * direct `fs.readdir`; the fs impl backs it with `fs.readdir` over
   * `.cq/archive/<name>/`.
   */
  readArchiveDir(name: string): Promise<string[]>;

  // ---------------------------------------------------------------------------
  // (d) Schema-divergence BACKUP action
  // ---------------------------------------------------------------------------

  /**
   * Back up the CURRENT canonical on-disk/in-store state before a divergence
   * reinit wipes it, and return an operator-facing LOCATOR for the snapshot (an
   * absolute backup-dir path for the fs backend; a tag/ref for the git backend)
   * so a CLI / startup warning can name exactly what was preserved.
   *
   * This is ONLY the byte-level BACKUP half of the divergence flow — the
   * schema-divergence DETECTION (`schemasEqual`) and the decision to reinit stay
   * in the shared base (concern 1). The reinit's subsequent fresh writes go
   * through {@link writeRegistrySource} / {@link writeLedgerSource}.
   *
   * FsLedgerStore call-site — the byte-I/O prologue of `backupAndReinit()`:
   *   - `fs.mkdir(path.join(docsDir, ".backup", <sanitized-ISO>), …)` — create
   *     the timestamped backup dir.
   *   - `fs.copyFile(src, dest)` — copy `.cq/ledgers.yaml` + each canonical and
   *     non-canonical ledger file into it (ENOENT tolerated).
   *   - `fs.unlink(this.ledgerPath(name))` — remove now-orphaned non-canonical
   *     ledger files from disk.
   * `backupAndReinit()` returns this dir; `reset()` surfaces it as
   * `ResetSummary.backupDir`, and `init()` names it in the stderr WARNING.
   */
  backupCanonicalState(): Promise<string>;

  // ---------------------------------------------------------------------------
  // (e) Coherence token — source-change detection
  // ---------------------------------------------------------------------------

  /**
   * Return an opaque token that changes whenever the underlying source for
   * ledger `name` changes (an mtime for the fs backend, a ref/commit SHA for the
   * git backend), so the shared base can cheaply detect an out-of-band
   * coherence change without re-reading and re-parsing the whole source.
   *
   * NOTE — no direct call-site in today's `FsLedgerStore`: cross-process
   * coherence (D-COHERENCE) is currently driven by an explicit WS
   * `ledger.changed` notification routed into `invalidate()`, NOT by polling an
   * mtime/SHA, so the fs store performs no `fs.stat`/mtime read today. This
   * method is part of the seam because the git-object backend (T351) detects a
   * peer write by observing its ref move, and the shared base (T350) will use
   * the token to gate a reload. The fs impl backs it with the source file's
   * mtime (e.g. `fs.stat(this.ledgerPath(name)).mtimeMs`).
   *
   * Coherence-token contract (T497 — point 3 of the multi-writer concurrency
   * contract above): after another process COMMITS a write to `name`, a
   * subsequent `currentSourceToken(name)` MUST (eventually, but before that
   * write could otherwise be lost to a stale-read overwrite) return a token
   * unequal to every token observed before that write; while no write occurs
   * the token MUST be stable, so a poller gets no spurious reloads. Tokens are
   * OPAQUE: callers compare them for equality only — no ordering, format, or
   * monotonicity is implied, and tokens from different backends/locations are
   * never comparable.
   */
  currentSourceToken(name: string): Promise<string>;
}
