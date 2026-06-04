/**
 * FsLedgerStore — filesystem-backed implementation of `LedgerStore`.
 *
 * Layout under `root` (typically the server's --cwd):
 *   ./docs/ledgers.yaml                              # central registry
 *   ./docs/<ledger>.md                               # active ledger
 *   ./docs/archive/<ledger>/<milestone-id>.md        # archived group (or item, for milestones ledger)
 *   ./docs/.locks/<ledger>.lock                      # advisory lockfile
 *   ./docs/.locks/__milestones__.lock                # global milestones lock
 *
 * On init():
 *   - Read ./docs/ledgers.yaml (create with EMPTY_REGISTRY if missing).
 *   - Bootstrap every canonical ledger if absent (add entries to
 *     ledgers.yaml with their canonical schema; write empty files;
 *     the milestones file gets the `## active` group, §8d).
 *   - For each registered ledger, read ./docs/<ledger>.md and parse it
 *     against the schema in the registry. Create an empty file if missing.
 *   - Populate in-memory state.
 *
 * Lock discipline (msunify cycle):
 *   - Per-ledger AsyncMutex + lockfile for within-ledger ops.
 *   - Global `__milestones__` AsyncMutex + lockfile for operations that
 *     mutate the milestones ledger OR create/archive items referencing it.
 *   - Multi-lock acquisition order: `__milestones__` first; then per-ledger
 *     locks in alphabetic order. This contract MUST hold for every
 *     multi-lock path to avoid cyclic deadlock.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  ArchivePointer,
  FetchedLedger,
  Item,
  Ledger,
  LedgerSchema,
  Milestone,
} from "../types.js";
import {
  BootstrapViolationError,
  DuplicateIdError,
  LedgerError,
  LedgerNotFoundError,
} from "../types.js";
import {
  parseLedger,
  parseArchive,
  parseMilestoneItemArchive,
} from "../parser/parse.js";
import {
  serializeLedger,
  serializeArchive as serializeArchiveImpl,
  serializeMilestoneItemArchive,
} from "../parser/serialize.js";
import {
  EMPTY_REGISTRY,
  parseRegistry,
  serializeRegistry,
} from "../registry.js";
import type { LedgerRegistry } from "../types.js";
import {
  applyCreateItem,
  applyCreateMilestoneItem,
  applyDetachMilestoneGroup,
  applyDetachMilestoneItem,
  applyEnsureAmbientMilestone,
  applyReattachItem,
  applyReopenItem,
  applyUpdateItem,
  applyUpdateMilestoneItem,
  assertGoalPhasePreconditions,
  assertMilestoneActive,
  assertPrefixUnique,
  findItem,
  resolveMilestoneView,
  searchItems,
  validateSchema,
} from "./core.js";
import {
  materialiseFetchedLedger,
} from "./InMemoryLedgerStore.js";
import type {
  ArchiveContent,
  CreateItemInit,
  CreateMilestoneItemInit,
  FetchedMilestoneItem,
  FtsSearchHit,
  FtsSearchOpts,
  LedgerStore,
  OnMutation,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "./LedgerStore.js";
import type { LedgerSnapshot } from "../snapshot.js";
import { buildSnapshot } from "../snapshot.js";
import { MAX_READ_LOG_BYTES, type ReadLogResult } from "../mcp/readLog.js";
import { LedgerSearchIndex } from "../search/LedgerSearchIndex.js";
import { AsyncMutex } from "./mutex.js";
import { Lockfile, type LockfileOpts } from "./lockfile.js";
import {
  CANONICAL_LEDGERS,
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  QUESTIONS_LEDGER,
} from "../constants.js";

/**
 * Result of {@link FsLedgerStore.reset}: the absolute path the prior on-disk
 * state was snapshotted to, plus a per-ledger count of the items that existed
 * BEFORE the wipe — what a CLI prints to confirm what it just backed up.
 */
export interface ResetSummary {
  /** Absolute path of the `docs/.backup/<ts>/` snapshot dir. */
  backupDir: string;
  /** Active item count per active ledger, captured BEFORE the reinit. */
  ledgers: Array<{ name: string; itemCount: number }>;
}

export interface FsLedgerStoreOpts {
  /** Filesystem root (server --cwd). Ledgers live under `<root>/docs/`. */
  root: string;
  /**
   * Returns an ISO 8601 UTC timestamp. Defaults to
   * `() => new Date().toISOString()`.
   */
  now?: () => string;
  /** Lockfile injection points for tests (isPidAlive, selfPid, …). */
  lockfile?: LockfileOpts;
  /**
   * Fired AFTER every successful write — after the lockfile is
   * released and after the in-memory map is updated. Used to broadcast
   * cross-process cache-invalidation notifications via the internal
   * WS channel (D-COHERENCE). MUST NOT block; if the hook throws, the
   * store logs to stderr and continues so write effects survive.
   *
   * Fired for: createLedger, createMilestone, createItem, updateItem,
   * updateMilestoneItem, archiveMilestone (once per participating
   * ledger, including the milestones ledger). NOT fired for reads.
   */
  onMutation?: OnMutation;
  /**
   * Policy for an on-disk canonical ledger whose schema has diverged from
   * its canonical bootstrap schema (detected at init()).
   *
   * - `'backup-reinit'` (default): back up the divergent on-disk state and
   *   reinitialise the canonical files from scratch, then continue startup.
   * - `'abort'`: refuse to start — throw `BootstrapViolationError` — so the
   *   divergence is loud and operator-handled.
   */
  onSchemaDivergence?: "backup-reinit" | "abort";
}

/** Global lock key for the milestones-cross-ledger mutex/lockfile. */
const MILESTONES_LOCK_KEY = "__milestones__";
const REGISTRY_LOCK_KEY = "__registry__";

export class FsLedgerStore implements LedgerStore {
  private readonly root: string;
  private readonly docsDir: string;
  private readonly logsDir: string;
  private readonly locksDir: string;
  private readonly archiveDir: string;
  private readonly registryPath: string;
  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly ledgers = new Map<string, Ledger>();
  private readonly now: () => string;
  private readonly lockfile: Lockfile;
  private readonly onMutation: OnMutation | null;
  private readonly onSchemaDivergence: "backup-reinit" | "abort";
  private readonly searchIndex = new LedgerSearchIndex();
  private registry: LedgerRegistry = { ...EMPTY_REGISTRY, ledgers: [] };
  private initialised = false;

  constructor(opts: FsLedgerStoreOpts) {
    this.root = opts.root;
    this.docsDir = path.join(this.root, "docs");
    this.logsDir = path.join(this.docsDir, "logs");
    this.locksDir = path.join(this.docsDir, ".locks");
    this.archiveDir = path.join(this.docsDir, "archive");
    this.registryPath = path.join(this.docsDir, "ledgers.yaml");
    this.now = opts.now ?? (() => new Date().toISOString());
    this.lockfile = new Lockfile(opts.lockfile ?? {});
    this.onMutation = opts.onMutation ?? null;
    this.onSchemaDivergence = opts.onSchemaDivergence ?? "backup-reinit";
  }

  /**
   * Invoke the user-supplied `onMutation` hook with the given
   * (ledgerId, op) pair. Synchronous; never throws — if the user hook
   * throws, the error is written to stderr so the write path completes
   * uninterrupted. Called AFTER lockfile release.
   */
  private fireMutation(
    ledgerId: string,
    op: "create" | "update" | "archive",
  ): void {
    // Keep the derived FTS ACTIVE docs coherent with the local write FIRST
    // (synchronous, cheap, guarded), then fire the user hook. The ARCHIVED
    // docs (which only change on an `archive` op, and require file I/O) are
    // refreshed by `archiveMilestone` itself, awaited so the index is coherent
    // by the time that async mutation resolves — see its tail.
    this.rebuildLedgerIndexActive(ledgerId);
    if (this.onMutation === null) return;
    try {
      this.onMutation(ledgerId, op);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `FsLedgerStore: onMutation hook threw for ${ledgerId} (${op}): ${msg}\n`,
      );
    }
  }

  /**
   * Rebuild the ACTIVE docs of `ledgerId` from the current in-memory ledger.
   * Synchronous, cheap (a field-bucketing map), and GUARDED: an index error
   * must never propagate into the write path (mirrors the onMutation-swallow
   * contract). No-op if the ledger is not loaded.
   */
  private rebuildLedgerIndexActive(ledgerId: string): void {
    try {
      const ledger = this.ledgers.get(ledgerId);
      if (ledger === undefined) return;
      this.searchIndex.rebuildLedgerActive(ledgerId, activeItemsOf(ledger));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `FsLedgerStore: FTS active-rebuild threw for ${ledgerId}: ${msg}\n`,
      );
    }
  }

  /**
   * Rebuild the ARCHIVED docs of `ledgerId` by reading each archive pointer's
   * (immutable) file. Async + GUARDED: archive I/O failure must not unwind a
   * write. No-op if the ledger is not loaded.
   */
  private async refreshLedgerIndexArchived(ledgerId: string): Promise<void> {
    try {
      const ledger = this.ledgers.get(ledgerId);
      if (ledger === undefined) return;
      const archived = await this.collectArchivedItems(ledgerId);
      this.searchIndex.setLedgerArchived(ledgerId, archived);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `FsLedgerStore: FTS archived-refresh threw for ${ledgerId}: ${msg}\n`,
      );
    }
  }

  /**
   * Populate `title` and `status` on any ArchivePointer whose persisted entry
   * was written before T91 (and therefore lacks those fields — they default to
   * ""). Fail-soft: ENOENT or a parse error leaves the pointer unchanged and
   * never propagates (init must not fail on a legacy/absent archive file).
   * Called once during init(), before this.initialised is set to true.
   *
   * Source selection:
   * - milestones ledger: reads `ptr.path` (the single-ITEM archive at
   *   docs/archive/milestones/<id>.md) and parses with parseMilestoneItemArchive.
   * - non-milestones ledger: `ptr.path` resolves to a milestone-GROUP archive
   *   (docs/archive/<ledger>/<id>.md) that carries items but NO milestone title.
   *   For these we read the milestones-ledger single-ITEM archive at
   *   docs/archive/milestones/<ptr.id>.md instead (D16 / T110).
   */
  private async backfillLegacyArchivePointers(ledger: Ledger): Promise<void> {
    const isMilestones = ledger.id === MILESTONES_LEDGER;
    for (const ptr of ledger.archivePointers) {
      if (ptr.title !== "" && ptr.status !== "") continue; // already populated
      // Determine the source path:
      // - milestones ledger: the pointer's own path (single-ITEM archive).
      // - non-milestones ledger: the milestones-ledger single-ITEM archive
      //   keyed by ptr.id, which is where the milestone title lives.
      let absPath: string;
      if (isMilestones) {
        absPath = path.resolve(this.docsDir, ptr.path);
      } else {
        absPath = path.join(this.archiveDir, MILESTONES_LEDGER, `${ptr.id}.md`);
      }
      // Defense-in-depth: skip paths that escape the docs root.
      if (absPath === this.docsDir || !absPath.startsWith(this.docsDir + path.sep)) continue;
      let text: string;
      try {
        text = await fs.readFile(absPath, "utf8");
      } catch {
        // Missing archive file — leave title/status empty.
        continue;
      }
      try {
        const item = parseMilestoneItemArchive(text);
        if (ptr.title === "") {
          const t = item.fields["title"];
          if (typeof t === "string" && t.length > 0) ptr.title = t;
        }
        if (ptr.status === "") {
          if (item.status.length > 0) ptr.status = item.status;
        }
      } catch {
        // Malformed archive — leave title/status empty, do not throw.
      }
    }
  }

  /**
   * Read every archived item of `ledgerId` from its archive pointers. For a
   * non-milestones ledger each pointer is a milestone-GROUP archive (its items
   * are the archived items); for the milestones ledger each pointer is a
   * single milestone-ITEM archive. Files are immutable, so this is called only
   * at init and on archive/invalidate events.
   */
  private async collectArchivedItems(ledgerId: string): Promise<Item[]> {
    const ledger = this.ledgers.get(ledgerId);
    if (ledger === undefined) return [];
    const out: Item[] = [];
    for (const ptr of ledger.archivePointers) {
      const content = await this.fetchArchive(ledgerId, ptr.id);
      if (content.kind === "group") out.push(...content.milestone.items);
      else out.push(content.item);
    }
    return out;
  }

  /**
   * Build the FULL index entry (active + archived) for `ledgerId`. Used at
   * init and on the remote-coherence (`invalidate`) path, where the op kind is
   * unknown so archives are refreshed too (idempotent over immutable files).
   */
  private async indexLedgerFull(ledgerId: string): Promise<void> {
    this.rebuildLedgerIndexActive(ledgerId);
    await this.refreshLedgerIndexArchived(ledgerId);
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    await fs.mkdir(this.docsDir, { recursive: true });
    await fs.mkdir(this.locksDir, { recursive: true });
    await fs.mkdir(this.archiveDir, { recursive: true });

    // Load registry.
    let registryText: string | null = null;
    try {
      registryText = await fs.readFile(this.registryPath, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
    }
    if (registryText === null) {
      await fs.writeFile(this.registryPath, serializeRegistry(EMPTY_REGISTRY), "utf8");
      this.registry = { version: 1, ledgers: [] };
    } else {
      this.registry = parseRegistry(registryText);
    }

    // Bootstrap every canonical ledger (milestones + the canon-cycle five +
    // goals) if absent. Collect any on-disk schema that diverged from canon.
    let registryDirty = false;
    const divergent: string[] = [];
    for (const canonical of CANONICAL_LEDGERS) {
      const entry = this.registry.ledgers.find((e) => e.name === canonical.name);
      if (entry === undefined) {
        this.registry.ledgers.push({ name: canonical.name, schema: canonical.schema });
        registryDirty = true;
      } else if (!schemasEqual(entry.schema, canonical.schema)) {
        // A prior cycle / hand-edit wrote an out-of-band schema.
        divergent.push(canonical.name);
      }
    }
    if (divergent.length > 0) {
      if (this.onSchemaDivergence === "abort") {
        // Opt-out: refuse to start so the divergence is loud + operator-handled.
        throw new BootstrapViolationError(
          `existing ${divergent.join(", ")} ledger(s) have a different schema than their canonical bootstrap schema`,
        );
      }
      // Default: back up the divergent on-disk state, then reinitialise the
      // canonical files + registry from scratch. backupAndReinit updates
      // this.registry IN PLACE to fresh canonical, so the load loop below
      // iterates the FRESH canonical registry (and reads the fresh files).
      await this.backupAndReinit();
    } else if (registryDirty) {
      await this.writeRegistry();
    }

    // Load each ledger (including milestones).
    for (const entry of this.registry.ledgers) {
      const isMilestones = entry.name === MILESTONES_LEDGER;
      const filePath = this.ledgerPath(entry.name);
      let text: string | null = null;
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw e;
      }
      let ledger: Ledger;
      let needsWrite = false;
      if (text === null) {
        ledger = freshLedger(entry.name, entry.schema);
        if (isMilestones) seedBootstrapGroup(ledger);
        needsWrite = true;
      } else {
        ledger = parseLedger(text, {
          schema: entry.schema,
          isMilestonesLedger: isMilestones,
        });
        if (isMilestones && ledger.milestones.length === 0) {
          // Empty milestones file (no active group). Seed it and rewrite.
          seedBootstrapGroup(ledger);
          needsWrite = true;
        }
      }
      if (isMilestones) {
        // Bootstrap the immortal M-AMBIENT milestone (§8b) if missing.
        const before = ledger.milestones.find(
          (m) => m.id === MILESTONES_ACTIVE_GROUP_ID,
        )?.items.length;
        applyEnsureAmbientMilestone(ledger, this.now());
        const after = ledger.milestones.find(
          (m) => m.id === MILESTONES_ACTIVE_GROUP_ID,
        )?.items.length;
        if (before !== after) needsWrite = true;
      }
      if (needsWrite) await this.writeLedgerFile(ledger);
      this.ledgers.set(entry.name, ledger);
      // Backfill title+status on legacy ArchivePointers (pre-T91) that were
      // persisted without those fields (D12/D16). The read path (fetch/
      // materialiseFetchedLedger) is synchronous+FS-free and cannot do async
      // I/O; init() is the only async locus that can recover the data.
      // Fail-soft: a missing or malformed archive file leaves the pointer
      // with empty title/status and never throws.
      // NOTE: milestones ledger must be processed FIRST (it appears first in
      // CANONICAL_LEDGERS) so its in-memory archivePointers are populated
      // before the non-milestones ledgers' backfill runs. Non-milestones
      // pointers source their title from docs/archive/milestones/<id>.md
      // (the same single-ITEM file); they do NOT depend on the in-memory
      // milestones state, but the file is the same source used by milestones.
      await this.backfillLegacyArchivePointers(ledger);
    }
    this.initialised = true;
    // Build the FTS index for every loaded ledger (active + archived).
    for (const name of this.ledgers.keys()) {
      await this.indexLedgerFull(name);
    }
  }

  async dispose(): Promise<void> {
    const drains = Array.from(this.mutexes.values()).map((m) =>
      m.run(async () => undefined),
    );
    await Promise.all(drains);
    this.ledgers.clear();
    this.mutexes.clear();
    this.initialised = false;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  enumerate(): string[] {
    this.assertInit();
    return Array.from(this.ledgers.keys()).sort();
  }

  fetch(ledgerId: string): FetchedLedger {
    return materialiseFetchedLedger(
      this.getLedger(ledgerId),
      this.getLedger(MILESTONES_LEDGER),
    );
  }

  fetchItem(ledgerId: string, itemId: string): Item {
    return cloneItem(findItem(this.getLedger(ledgerId), itemId).item);
  }

  fetchMilestone(milestoneId: string): FetchedMilestoneItem {
    this.assertInit();
    const milestonesLedger = this.getLedger(MILESTONES_LEDGER);
    const resolved = resolveMilestoneView(milestonesLedger, milestoneId);
    if (resolved === null) {
      throw new LedgerError(`milestone ${milestoneId} not found`);
    }
    const item = findItem(milestonesLedger, milestoneId).item;
    const references = this.countReferences(milestoneId);
    return { milestone: cloneItem(item), resolved, references };
  }

  listMilestoneItems(milestoneId: string): Record<string, Item[]> {
    this.assertInit();
    const out: Record<string, Item[]> = {};
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      if (group.items.length === 0) continue;
      out[name] = group.items.map(cloneItem);
    }
    return out;
  }

  snapshot(): LedgerSnapshot {
    this.assertInit();
    return buildSnapshot(this.enumerate().map((name) => this.fetch(name)));
  }

  search(ledgerId: string, query: string): Item[] {
    return searchItems(this.getLedger(ledgerId), query).map(cloneItem);
  }

  async ftsSearch(query: string, opts: FtsSearchOpts = {}): Promise<FtsSearchHit[]> {
    this.assertInit();
    return this.searchIndex
      .searchQuery(query, opts)
      .map((h) => ({ ...h, item: cloneItem(h.item) }));
  }

  async fetchArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    const ledger = this.getLedger(ledgerId);
    const ptr = ledger.archivePointers.find((p) => p.id === archiveId);
    if (ptr === undefined) {
      throw new LedgerError(
        `archive ${archiveId} not found in ledger ${ledgerId}`,
      );
    }
    const absPath = path.resolve(this.docsDir, ptr.path);
    this.assertWithinDocsRoot(absPath);
    const text = await fs.readFile(absPath, "utf8");
    if (ledgerId === MILESTONES_LEDGER) {
      const item = parseMilestoneItemArchive(text);
      return { kind: "item", item };
    }
    return { kind: "group", milestone: parseArchive(text) };
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  async updateMilestone(
    milestoneId: string,
    patch: UpdateMilestoneItemPatch,
  ): Promise<Item> {
    const item = await this.withMilestonesLock(async () => {
      const ledger = this.getLedger(MILESTONES_LEDGER);
      const it = applyUpdateMilestoneItem(ledger, milestoneId, patch, this.now());
      await this.writeLedgerFile(ledger);
      return cloneItem(it);
    });
    // Hook fires AFTER lockfile release per D-COHERENCE contract.
    this.fireMutation(MILESTONES_LEDGER, "update");
    return item;
  }

  async updateItem(
    ledgerId: string,
    itemId: string,
    patch: UpdateItemPatch,
  ): Promise<Item> {
    const it = await this.withLock(ledgerId, async () => {
      const ledger = this.getLedger(ledgerId);
      // F2: cross-ledger goal-phase preconditions, enforced via the
      // precondition hook so they run AFTER the F1 transition guard. Read-only
      // of the in-memory questions/decisions ledgers under the goals lock
      // (synchronous; no other lock needed). The rule logic lives in
      // core.ts::assertGoalPhasePreconditions — not duplicated here.
      const precondition =
        ledgerId === GOALS_LEDGER
          ? (from: string, to: string): void =>
              assertGoalPhasePreconditions(
                itemId,
                from,
                to,
                this.ledgers.get(QUESTIONS_LEDGER),
                this.ledgers.get(DECISIONS_LEDGER),
              )
          : undefined;
      const x = applyUpdateItem(ledger, itemId, patch, this.now(), precondition);
      await this.writeLedgerFile(ledger);
      return cloneItem(x);
    });
    this.fireMutation(ledgerId, "update");
    return it;
  }

  async createItem(
    ledgerId: string,
    milestoneId: string,
    init: CreateItemInit,
  ): Promise<Item> {
    if (ledgerId === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(
        `use createMilestone to add an item to the ${MILESTONES_LEDGER} ledger`,
      );
    }
    const item = await this.withMilestonesLock(async () => {
      assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), milestoneId);
      return this.withLock(ledgerId, async () => {
        const ledger = this.getLedger(ledgerId);
        const x = applyCreateItem(ledger, milestoneId, init, this.now());
        await this.writeLedgerFile(ledger);
        return cloneItem(x);
      });
    });
    this.fireMutation(ledgerId, "create");
    return item;
  }

  async createMilestone(init: CreateMilestoneItemInit): Promise<Item> {
    const item = await this.withMilestonesLock(async () => {
      const ledger = this.getLedger(MILESTONES_LEDGER);
      const x = applyCreateMilestoneItem(ledger, init, this.now());
      await this.writeLedgerFile(ledger);
      return cloneItem(x);
    });
    this.fireMutation(MILESTONES_LEDGER, "create");
    return item;
  }

  async createLedger(name: string, schema: LedgerSchema): Promise<FetchedLedger> {
    this.assertInit();
    if (name === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(
        `ledger name "${MILESTONES_LEDGER}" is reserved`,
      );
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new LedgerError(
        `invalid ledger name "${name}": only A-Za-z0-9_- are allowed`,
      );
    }
    validateSchema(schema);
    if (this.ledgers.has(name)) {
      throw new DuplicateIdError("ledger", name);
    }
    assertPrefixUnique(name, schema, this.registry.ledgers);
    const result = await this.withRegistryLock(async () => {
      if (this.ledgers.has(name)) {
        throw new DuplicateIdError("ledger", name);
      }
      // Re-check under lock: a concurrent createLedger may have taken the prefix.
      assertPrefixUnique(name, schema, this.registry.ledgers);
      const ledger = freshLedger(name, schema);
      this.ledgers.set(name, ledger);
      this.registry.ledgers.push({ name, schema });
      await this.writeLedgerFile(ledger);
      await this.writeRegistry();
      return materialiseFetchedLedger(ledger, this.getLedger(MILESTONES_LEDGER));
    });
    this.fireMutation(name, "create");
    return result;
  }

  async reopenItem(
    ledgerId: string,
    itemId: string,
    toStatus: string,
  ): Promise<Item> {
    const it = await this.withLock(ledgerId, async () => {
      const ledger = this.getLedger(ledgerId);
      const x = applyReopenItem(ledger, itemId, toStatus, this.now());
      await this.writeLedgerFile(ledger);
      return cloneItem(x);
    });
    this.fireMutation(ledgerId, "update");
    return it;
  }

  async unarchiveItem(
    ledgerId: string,
    milestoneId: string,
    itemId: string,
  ): Promise<Item> {
    const isMilestones = ledgerId === MILESTONES_LEDGER;
    const reattached = await this.withLock(ledgerId, async () => {
      const ledger = this.getLedger(ledgerId);
      const ptr = ledger.archivePointers.find((p) => p.id === milestoneId);
      if (ptr === undefined) {
        throw new LedgerError(
          isMilestones
            ? `no archived item ${milestoneId} in ledger ${ledgerId}`
            : `no archived group for milestone ${milestoneId} in ledger ${ledgerId}`,
        );
      }
      const absPath = path.resolve(this.docsDir, ptr.path);
      this.assertWithinDocsRoot(absPath);
      const text = await fs.readFile(absPath, "utf8");

      if (isMilestones) {
        // Per-ITEM archive file: the single archived milestone-item.
        const archivedItem = parseMilestoneItemArchive(text);
        if (archivedItem.id !== itemId) {
          throw new LedgerError(
            `archived item file ${milestoneId} in ledger ${ledgerId} does not contain item ${itemId}`,
          );
        }
        const out = applyReattachItem(
          ledger,
          archivedItem.milestoneId,
          archivedItem,
          this.now(),
        );
        // Per-item archive always becomes empty on extraction: remove the
        // file + its pointer entirely.
        await fs.rm(absPath, { force: true });
        this.removeArchivePointer(ledger, milestoneId);
        await this.writeLedgerFile(ledger);
        return cloneItem(out);
      }

      // Non-milestones ledger: a milestone-GROUP archive file. Extract ONLY
      // the requested item, re-attach it, and rewrite the group WITHOUT it
      // (removing the file + pointer when the group becomes empty).
      const group = parseArchive(text);
      const idx = group.items.findIndex((it) => it.id === itemId);
      if (idx < 0) {
        throw new LedgerError(
          `archived group ${milestoneId} in ledger ${ledgerId} has no item ${itemId}`,
        );
      }
      const [extracted] = group.items.splice(idx, 1);
      if (extracted === undefined) {
        throw new LedgerError(
          `archived group ${milestoneId} in ledger ${ledgerId} has no item ${itemId}`,
        );
      }
      const out = applyReattachItem(ledger, milestoneId, extracted, this.now());
      if (group.items.length === 0) {
        // Last item removed — drop the group archive file + its pointer.
        await fs.rm(absPath, { force: true });
        this.removeArchivePointer(ledger, milestoneId);
      } else {
        // Rewrite the group archive WITHOUT the extracted item; the pointer
        // (id/path/summary/title/status) is unchanged.
        await atomicWrite(absPath, serializeArchiveImpl(group));
      }
      await this.writeLedgerFile(ledger);
      return cloneItem(out);
    });
    // The active docs gained an item and the archived docs shrank/vanished;
    // refresh both. fireMutation rebuilds active; refresh archived explicitly.
    this.fireMutation(ledgerId, "update");
    await this.refreshLedgerIndexArchived(ledgerId);
    return reattached;
  }

  async archiveMilestone(
    milestoneId: string,
    summary: string,
  ): Promise<ArchivePointer> {
    // Snapshot the set of ledgers that will be archived so we can fire
    // per-participant hooks AFTER all writes complete + locks release.
    // We compute it INSIDE the lock to avoid a TOCTOU race with a
    // concurrent createItem on a participating ledger.
    let participatingLedgers: string[] = [];
    const ptr = await this.withMilestonesLock(async () => {
      // Acquire every per-ledger lock in alphabetic order BEFORE inspecting
      // any ledger, so we don't race a concurrent updateItem.
      const otherLedgerIds = Array.from(this.ledgers.keys())
        .filter((n) => n !== MILESTONES_LEDGER)
        .sort();
      return this.withLocksInOrder(otherLedgerIds, async () => {
        // Determine the participants under lock so the hook list reflects
        // what was actually mutated.
        participatingLedgers = otherLedgerIds.filter((id) => {
          const l = this.ledgers.get(id);
          return l !== undefined && l.milestones.some((m) => m.id === milestoneId);
        });
        return this.performArchive(milestoneId, summary);
      });
    });
    // Fire per-participant hooks AFTER lockfile release. The milestones
    // ledger is always archived (the milestone-item itself), so it
    // always gets one hook.
    for (const id of participatingLedgers) this.fireMutation(id, "archive");
    this.fireMutation(MILESTONES_LEDGER, "archive");
    // Archived FTS docs change only on archive. Refresh them for every
    // participating ledger (and the milestones ledger, whose milestone-ITEM
    // was archived) and AWAIT so the index is coherent when this mutation
    // resolves. Guarded inside refreshLedgerIndexArchived; archive files are
    // immutable so this read is bounded and one-shot.
    for (const id of participatingLedgers) await this.refreshLedgerIndexArchived(id);
    await this.refreshLedgerIndexArchived(MILESTONES_LEDGER);
    return ptr;
  }

  /**
   * Back up the divergent on-disk ledger state and reinitialise canonical
   * files from scratch.
   *
   * (a) Compute a timestamped backup dir under docs/.backup/<sanitized-ISO>/
   *     using this.now() (colons in the ISO string replaced with '-' so the
   *     path is valid on all platforms). mkdir recursively.
   * (b) Copy each affected canonical ledger file (this.ledgerPath(name) for
   *     every CANONICAL_LEDGERS entry) AND docs/ledgers.yaml into that backup
   *     dir, preserving basenames. ENOENT is silently tolerated on any source
   *     file (a registry or ledger file may legitimately be absent). Also
   *     copies any non-canonical ledger files present in the registry, then
   *     removes them from disk so no orphan docs/<name>.md files survive the
   *     reinit.
   * (c) Write a fresh canonical registry + ledger files from CANONICAL_LEDGERS
   *     via the existing writeRegistry / writeLedgerFile primitives; seeds the
   *     milestones bootstrap group and M-AMBIENT exactly as the empty-dir init()
   *     path does.
   * (d) Emits a loud WARNING to process.stderr naming the absolute backup path.
   *
   * T95 wires this into init()'s divergence branch; kept private + tested
   * directly here so the helper is exercised and lint stays clean.
   *
   * Returns the absolute backup dir so callers (the public reset()) can
   * surface it without recomputing the timestamp.
   */
  private async backupAndReinit(): Promise<string> {
    // (a) Sanitize the ISO timestamp for use as a directory name.
    const ts = this.now().replace(/:/g, "-");
    const backupDir = path.join(this.docsDir, ".backup", ts);
    await fs.mkdir(backupDir, { recursive: true });

    // Identify non-canonical ledgers present in the registry so their files
    // can be backed up and removed (preventing orphan docs/<name>.md files).
    const canonicalNames = new Set(CANONICAL_LEDGERS.map((c) => c.name));
    const nonCanonicalNames = this.registry.ledgers
      .map((e) => e.name)
      .filter((n) => !canonicalNames.has(n));

    // (b) Copy ledger files + registry into the backup dir; tolerate ENOENT.
    const filesToBackup: string[] = [
      this.registryPath,
      ...CANONICAL_LEDGERS.map((c) => this.ledgerPath(c.name)),
      ...nonCanonicalNames.map((n) => this.ledgerPath(n)),
    ];
    for (const src of filesToBackup) {
      const dest = path.join(backupDir, path.basename(src));
      try {
        await fs.copyFile(src, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }

    // Remove non-canonical ledger files from disk so they don't survive as
    // orphans after the reinit. ENOENT is tolerated (file may not exist yet).
    for (const name of nonCanonicalNames) {
      try {
        await fs.unlink(this.ledgerPath(name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }

    // (d) Warn BEFORE rewriting so the path is logged even if a write fails.
    process.stderr.write(
      `WARNING: FsLedgerStore divergence detected — prior state backed up to ${backupDir}\n`,
    );

    // (c) Rewrite fresh canonical registry.
    this.registry = { version: 1, ledgers: [] };
    for (const canonical of CANONICAL_LEDGERS) {
      this.registry.ledgers.push({ name: canonical.name, schema: canonical.schema });
    }
    await this.writeRegistry();

    // (c) Rewrite fresh canonical ledger files with the milestones bootstrap
    // group + M-AMBIENT ambient milestone seeded.
    for (const canonical of CANONICAL_LEDGERS) {
      const isMilestones = canonical.name === MILESTONES_LEDGER;
      const ledger = freshLedger(canonical.name, canonical.schema);
      if (isMilestones) {
        seedBootstrapGroup(ledger);
        applyEnsureAmbientMilestone(ledger, this.now());
      }
      await this.writeLedgerFile(ledger);
    }
    return backupDir;
  }

  /**
   * Public, operator-facing wipe-and-reinit. Intended for a CLI to call on a
   * freshly-constructed, already-init()'d store (not one actively serving
   * clients): it snapshots the current on-disk ledgers to a timestamped
   * `docs/.backup/<ts>/` dir and rewrites the canonical empty set, exactly as
   * the init()-divergence path does (reuses backupAndReinit verbatim).
   *
   * reset() handles non-canonical ledgers (created via createLedger()) fully:
   * their files are backed up and deleted from disk by backupAndReinit(), and
   * their FTS docs are removed here before the ledger map is cleared, so no
   * orphan docs/<name>.md files and no stale FTS hits survive the reset.
   *
   * reset() adds only the pre-wipe per-ledger item count and the returned
   * summary; it then reloads the fresh canonical state into memory + the FTS
   * index (via init()) so subsequent reads observe the empty ledgers.
   */
  async reset(): Promise<ResetSummary> {
    this.assertInit();
    // Count active items per ledger BEFORE the wipe.
    const ledgers = Array.from(this.ledgers.entries())
      .map(([name, ledger]) => ({ name, itemCount: activeItemsOf(ledger).length }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Drop FTS docs for non-canonical ledgers now, before backupAndReinit()
    // clears the registry. init() only indexes CANONICAL_LEDGERS, so without
    // this call those ledger's FTS docs would survive as stale hits.
    const canonicalNames = new Set(CANONICAL_LEDGERS.map((c) => c.name));
    for (const name of this.ledgers.keys()) {
      if (!canonicalNames.has(name)) {
        this.searchIndex.removeLedger(name);
      }
    }

    const backupDir = await this.backupAndReinit();

    // backupAndReinit rewrote files + this.registry but left the in-memory
    // ledger map and FTS index pointing at the pre-wipe canonical state. Drop
    // the ledger map and re-run init() to load the fresh canonical empty set.
    // init() re-indexes every loaded ledger (rebuildLedgerActive +
    // setLedgerArchived are replace-semantics), so no stale canonical FTS docs
    // survive. init() early-returns unless `initialised` is false, so reset it
    // first; the on-disk registry is now canonical, so init() will not
    // re-detect divergence.
    this.ledgers.clear();
    this.initialised = false;
    await this.init();

    return { backupDir, ledgers };
  }

  /**
   * Drop the in-memory cache for `ledgerId` and re-read it from disk
   * under the per-ledger lock. Used by the cross-process coherence
   * channel (D-COHERENCE) on inbound `ledger.changed` notifications.
   *
   * If the named ledger is not registered locally, attempt to reload
   * the registry: another process may have just created it. The
   * registry reload happens under the registry lock so it cannot
   * interleave with a local `createLedger`. After reload, if the
   * ledger is present in the registry, load its file under the per-
   * ledger lock.
   */
  async invalidate(ledgerId: string): Promise<void> {
    this.assertInit();
    if (this.ledgers.has(ledgerId)) {
      await this.withLock(ledgerId, async () => {
        await this.reloadLedgerFromDisk(ledgerId);
      });
      // The in-memory ledger was replaced by a peer's committed state; rebuild
      // its FTS docs so a remote write is searchable here (proves coherence on
      // the remote path, not just local mutation). Archives are immutable but
      // the remote op may have been an `archive`, so refresh both.
      await this.indexLedgerFull(ledgerId);
      return;
    }
    // Unknown ledger — reload registry and, if it's now there, load it.
    await this.withRegistryLock(async () => {
      let registryText: string | null = null;
      try {
        registryText = await fs.readFile(this.registryPath, "utf8");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw e;
      }
      if (registryText === null) return; // no registry yet — nothing to learn
      const fresh = parseRegistry(registryText);
      // Adopt the fresh registry wholesale; any ledgers we already have
      // are unaffected because their on-disk schema is the authority.
      this.registry = fresh;
      const entry = fresh.ledgers.find((e) => e.name === ledgerId);
      if (entry === undefined) return; // still doesn't exist; nothing to do
      // Load the new ledger from disk; the per-ledger lock isn't needed
      // until the entry exists in `this.ledgers`, but acquiring it
      // first means a parallel local creator can't race past us.
      const isMilestones = entry.name === MILESTONES_LEDGER;
      const filePath = this.ledgerPath(entry.name);
      let text: string | null = null;
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw e;
      }
      if (text === null) {
        // File missing — the other process registered but hasn't written
        // the file yet. Don't fabricate; bail out and let a later
        // invalidate retry once the file lands.
        return;
      }
      const ledger = parseLedger(text, {
        schema: entry.schema,
        isMilestonesLedger: isMilestones,
      });
      this.ledgers.set(entry.name, ledger);
      // F1: a brand-new ledger learned via the registry-reload path must be
      // indexed too, or a cross-process `createLedger` leaves it unsearchable
      // on the peer.
      await this.indexLedgerFull(entry.name);
    });
  }

  /**
   * Re-read `<ledgerId>.md` under the assumption that the per-ledger
   * lock is already held. Used by `invalidate` for known ledgers.
   * Silent no-op if the file disappeared (the other process may have
   * deleted it as part of a future feature).
   */
  private async reloadLedgerFromDisk(ledgerId: string): Promise<void> {
    const entry = this.registry.ledgers.find((e) => e.name === ledgerId);
    if (entry === undefined) return;
    const isMilestones = entry.name === MILESTONES_LEDGER;
    const filePath = this.ledgerPath(entry.name);
    let text: string | null = null;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
    }
    if (text === null) return;
    const ledger = parseLedger(text, {
      schema: entry.schema,
      isMilestonesLedger: isMilestones,
    });
    this.ledgers.set(entry.name, ledger);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Drop the ArchivePointer keyed by `archiveId` from `ledger` (if present). */
  private removeArchivePointer(ledger: Ledger, archiveId: string): void {
    const i = ledger.archivePointers.findIndex((p) => p.id === archiveId);
    if (i >= 0) ledger.archivePointers.splice(i, 1);
  }

  private countReferences(milestoneId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      if (group.items.length > 0) out[name] = group.items.length;
    }
    return out;
  }

  private async performArchive(
    milestoneId: string,
    summary: string,
  ): Promise<ArchivePointer> {
    if (milestoneId === MILESTONES_ACTIVE_GROUP_ID) {
      throw new BootstrapViolationError(
        `the bootstrap group ${MILESTONES_ACTIVE_GROUP_ID} cannot be archived`,
      );
    }
    if (milestoneId === MILESTONES_AMBIENT_ID) {
      throw new BootstrapViolationError(
        `${MILESTONES_AMBIENT_ID} is immortal and cannot be archived`,
      );
    }
    // Phase 1 — verify no non-terminal items in ANY ledger. We dry-run
    // applyDetachMilestoneGroup to leverage its `NonTerminalItemsError`
    // emission, but undo the detach if it succeeds (we want to gate
    // BEFORE any in-memory or on-disk mutation).
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      const terminal = new Set(ledger.schema.terminalStatuses);
      const offending = group.items.filter((it) => !terminal.has(it.status)).map((it) => it.id);
      if (offending.length > 0) {
        // Surface via applyDetachMilestoneGroup so error types match.
        applyDetachMilestoneGroup(
          ledger,
          milestoneId,
          summary,
          `./archive/${name}/${milestoneId}.md`,
          "",
          "",
        );
      }
    }
    // Phase 1b — verify the milestone-item itself is terminal.
    const milestonesLedger = this.getLedger(MILESTONES_LEDGER);
    const group = milestonesLedger.milestones.find(
      (m) => m.id === MILESTONES_ACTIVE_GROUP_ID,
    );
    if (group === undefined) {
      throw new BootstrapViolationError(
        `milestones ledger is missing its bootstrap group`,
      );
    }
    const milestoneItem = group.items.find((it) => it.id === milestoneId);
    if (milestoneItem === undefined) {
      // Surface via applyDetachMilestoneItem so the error type is
      // `MilestoneItemNotFoundError("absent")`. applyDetachMilestoneItem
      // throws before any mutation when the item is absent.
      applyDetachMilestoneItem(
        milestonesLedger,
        milestoneId,
        summary,
        `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`,
        "",
        "",
      );
    } else {
      // Item exists; refuse if non-terminal. (applyDetachMilestoneItem
      // would throw NonTerminalItemsError here, but it mutates only
      // AFTER the terminal check, so a synchronous throw is safe — we
      // surface it the same way for type-consistency.)
      const terminal = new Set(milestonesLedger.schema.terminalStatuses);
      if (!terminal.has(milestoneItem.status)) {
        applyDetachMilestoneItem(
          milestonesLedger,
          milestoneId,
          summary,
          `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`,
          "",
          "",
        );
      }
    }
    // Extract title and status from the milestoneItem (guaranteed non-null and
    // terminal after Phase 1b; used to populate the ArchivePointer fields).
    const msTitle = typeof milestoneItem?.fields["title"] === "string" ? milestoneItem.fields["title"] : "";
    const msStatus = milestoneItem?.status ?? "";
    // Phase 2 — for each non-milestones ledger with a matching group:
    // detach in-memory, write the archive file, write the ledger file.
    // Failures here leave the system in a partially-archived state but
    // every write is atomic-rename and the global lock prevents
    // interleaving.
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const hasGroup = ledger.milestones.some((m) => m.id === milestoneId);
      if (!hasGroup) continue;
      const relPath = `./archive/${name}/${milestoneId}.md`;
      const { milestone } = applyDetachMilestoneGroup(
        ledger,
        milestoneId,
        summary,
        relPath,
        msTitle,
        msStatus,
      );
      const archivePath = path.resolve(this.archiveDir, name, `${milestoneId}.md`);
      this.assertWithinDocsRoot(archivePath);
      await fs.mkdir(path.dirname(archivePath), { recursive: true });
      await atomicWrite(archivePath, serializeArchiveImpl(milestone));
      await this.writeLedgerFile(ledger);
    }
    // Phase 3 — detach the milestone-item from the milestones ledger,
    // write its single-item archive, write the milestones ledger.
    const relPath = `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`;
    const { item, pointer } = applyDetachMilestoneItem(
      milestonesLedger,
      milestoneId,
      summary,
      relPath,
      msTitle,
      msStatus,
    );
    const archivePath = path.resolve(this.archiveDir, MILESTONES_LEDGER, `${milestoneId}.md`);
    this.assertWithinDocsRoot(archivePath);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await atomicWrite(archivePath, serializeMilestoneItemArchive(item));
    await this.writeLedgerFile(milestonesLedger);
    return { ...pointer };
  }

  private async withLock<T>(ledgerId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.ledgers.has(ledgerId)) {
      throw new LedgerNotFoundError(ledgerId);
    }
    const mutex = this.mutexFor(ledgerId);
    return mutex.run(async () => {
      const release = await this.lockfile.acquire(this.locksDir, ledgerId);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private async withMilestonesLock<T>(fn: () => Promise<T>): Promise<T> {
    const mutex = this.mutexFor(MILESTONES_LOCK_KEY);
    return mutex.run(async () => {
      const release = await this.lockfile.acquire(this.locksDir, MILESTONES_LOCK_KEY);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private async withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
    const mutex = this.mutexFor(REGISTRY_LOCK_KEY);
    return mutex.run(async () => {
      const release = await this.lockfile.acquire(this.locksDir, REGISTRY_LOCK_KEY);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private async withLocksInOrder<T>(
    ledgerIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    if (ledgerIds.length === 0) return fn();
    const [head, ...tail] = ledgerIds;
    if (head === undefined) return fn();
    return this.withLock(head, () => this.withLocksInOrder(tail, fn));
  }

  private mutexFor(key: string): AsyncMutex {
    let m = this.mutexes.get(key);
    if (m === undefined) {
      m = new AsyncMutex();
      this.mutexes.set(key, m);
    }
    return m;
  }

  private getLedger(ledgerId: string): Ledger {
    this.assertInit();
    const l = this.ledgers.get(ledgerId);
    if (l === undefined) throw new LedgerNotFoundError(ledgerId);
    return l;
  }

  /**
   * Bounded, root-confined read of a log file under `<root>/docs/logs/`
   * (T147 / Q87). This is the FS-store's `read_log` capability: the
   * confinement root is the EXPLICIT FS-store root (`this.logsDir`), NOT the
   * generic `LedgerStore` interface — the in-memory store has no filesystem and
   * supplies no such capability.
   *
   * Security/bounds:
   *  - `relPath` MUST be repo-relative; an absolute path is rejected.
   *  - The path is resolved against `<root>/docs/logs` and REJECTED if it
   *    escapes that directory (e.g. `..` traversal).
   *  - The returned content is capped at {@link MAX_READ_LOG_BYTES}; an
   *    oversized file is truncated and flagged `truncated: true`.
   */
  async readLog(relPath: string): Promise<ReadLogResult> {
    if (path.isAbsolute(relPath)) {
      throw new LedgerError(`read_log: absolute paths are not allowed: ${relPath}`);
    }
    // sessionLogs stores REPO-relative paths ("docs/logs/<file>"), but this
    // method resolves against logsDir (= <root>/docs/logs). Strip a leading
    // docs/logs/ so a repo-relative path is not doubled into
    // <root>/docs/logs/docs/logs/<file>. A path already relative to docs/logs
    // ("<file>") is unaffected. Containment is still enforced below.
    const rel = relPath.replace(/^docs[/\\]logs[/\\]/, "");
    // Normalise the requested relative path, then resolve under logsDir and
    // verify containment (defence-in-depth against `..` traversal).
    const resolved = path.resolve(this.logsDir, rel);
    if (
      resolved !== this.logsDir &&
      !resolved.startsWith(this.logsDir + path.sep)
    ) {
      throw new LedgerError(
        `read_log: path escapes docs/logs root: ${relPath}`,
      );
    }

    // Re-assert containment after symlink resolution (D26): a symlink whose
    // lexical path is inside logsDir may point outside the confinement root.
    // We resolve BOTH sides so a symlinked parent component of the store root
    // (e.g. macOS /var -> /private/var) does not cause false escape rejections
    // for legitimate in-root paths (D26 round-1 fix).
    // We catch ENOENT on the target so a genuinely missing file surfaces as-is,
    // not as a false escape error. The logsDir realpath is computed each time
    // (the root must exist when a read is attempted; if it can ENOENT, let the
    // subsequent readFile surface the right error).
    //
    // D28: hoist `real` outside the try block so the subsequent readFile uses
    // the validated canonical path instead of the raw `resolved` path.  This
    // closes the check-then-use TOCTOU: if a symlink is swapped between the
    // realpath check and the readFile, reading `real` (canonical, symlink-free)
    // ensures no new symlink is followed at read time.
    let real: string | undefined;
    try {
      real = await fs.realpath(resolved);
      let realLogsDir: string;
      try {
        realLogsDir = await fs.realpath(this.logsDir);
      } catch {
        // logsDir doesn't exist yet — a missing file read will ENOENT below.
        realLogsDir = this.logsDir;
      }
      if (real !== realLogsDir && !real.startsWith(realLogsDir + path.sep)) {
        throw new LedgerError(
          `read_log: path escapes docs/logs root: ${relPath}`,
        );
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      // ENOENT: file doesn't exist — fall through so readFile surfaces it.
      // `real` stays undefined; `real ?? resolved` below reads `resolved` so
      // the normal not-found error still surfaces (not masked).
    }

    // Use the validated canonical path when available (D28: close TOCTOU).
    // When realpath threw ENOENT, `real` is undefined and we fall back to
    // `resolved` so the readFile surfaces the expected not-found error.
    const buf = await fs.readFile(real ?? resolved);
    if (buf.byteLength > MAX_READ_LOG_BYTES) {
      const content = buf.subarray(0, MAX_READ_LOG_BYTES).toString("utf8");
      return { path: relPath, content, truncated: true };
    }
    return { path: relPath, content: buf.toString("utf8") };
  }

  private ledgerPath(name: string): string {
    return path.join(this.docsDir, `${name}.md`);
  }

  private async writeLedgerFile(ledger: Ledger): Promise<void> {
    await atomicWrite(this.ledgerPath(ledger.id), serializeLedger(ledger));
  }

  private async writeRegistry(): Promise<void> {
    await atomicWrite(this.registryPath, serializeRegistry(this.registry));
  }

  private assertInit(): void {
    if (!this.initialised) throw new LedgerError("FsLedgerStore not initialised");
  }

  /**
   * Defense-in-depth (D-LED-01): after resolving a filesystem path that
   * incorporates caller-supplied data (a milestone id, an archive-pointer
   * path), refuse to read or write if the result is not inside `docsDir`.
   * Catches future regressions even if id validation slips.
   */
  private assertWithinDocsRoot(resolvedAbsPath: string): void {
    if (
      resolvedAbsPath !== this.docsDir &&
      !resolvedAbsPath.startsWith(this.docsDir + path.sep)
    ) {
      throw new LedgerError(
        `archive path escapes docs root: ${resolvedAbsPath}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function atomicWrite(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}

function freshLedger(name: string, schema: LedgerSchema): Ledger {
  return {
    id: name,
    schema,
    counters: { milestone: 0, item: 0 },
    milestones: [],
    archivePointers: [],
  };
}

/** Every active item across a ledger's milestone-groups (FTS active docs). */
function activeItemsOf(ledger: Ledger): Item[] {
  const out: Item[] = [];
  for (const m of ledger.milestones) for (const it of m.items) out.push(it);
  return out;
}

function seedBootstrapGroup(ledger: Ledger): void {
  ledger.milestones.push({
    id: MILESTONES_ACTIVE_GROUP_ID,
    title: MILESTONES_ACTIVE_GROUP_TITLE,
    description: "",
    items: [],
  });
}

function cloneItem(i: Item): Item {
  const out: Item = {
    id: i.id,
    milestoneId: i.milestoneId,
    status: i.status,
    fields: cloneFields(i.fields),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
  if (i.author !== undefined) out.author = i.author;
  if (i.session !== undefined) out.session = i.session;
  return out;
}

function cloneFields(
  f: Record<string, import("../types.js").FieldValue>,
): Record<string, import("../types.js").FieldValue> {
  const out: Record<string, import("../types.js").FieldValue> = {};
  for (const [k, v] of Object.entries(f)) {
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

function schemasEqual(a: LedgerSchema, b: LedgerSchema): boolean {
  // Cheap structural equality. Ordering of statusValues matters since
  // it affects display, but for schema-divergence-detection we treat
  // order-significant equality as the contract.
  if ((a.idPrefix ?? undefined) !== (b.idPrefix ?? undefined)) return false;
  if (a.statusValues.length !== b.statusValues.length) return false;
  for (let i = 0; i < a.statusValues.length; i++) {
    if (a.statusValues[i] !== b.statusValues[i]) return false;
  }
  if (a.terminalStatuses.length !== b.terminalStatuses.length) return false;
  for (let i = 0; i < a.terminalStatuses.length; i++) {
    if (a.terminalStatuses[i] !== b.terminalStatuses[i]) return false;
  }
  const aFieldNames = Object.keys(a.fields).sort();
  const bFieldNames = Object.keys(b.fields).sort();
  if (aFieldNames.length !== bFieldNames.length) return false;
  for (let i = 0; i < aFieldNames.length; i++) {
    if (aFieldNames[i] !== bFieldNames[i]) return false;
  }
  for (const name of aFieldNames) {
    const af = a.fields[name];
    const bf = b.fields[name];
    if (af === undefined || bf === undefined) return false;
    if (af.type !== bf.type || af.required !== bf.required) return false;
  }
  if (!transitionsEqual(a.transitions, b.transitions)) return false;
  return true;
}

/**
 * Structural equality for the optional `transitions` map (F1). Both absent
 * is equal; one absent is unequal. Order of the to-status arrays is
 * significant (matches the order-significant contract used for statusValues).
 */
function transitionsEqual(
  a: Record<string, string[]> | undefined,
  b: Record<string, string[]> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  for (const k of aKeys) {
    const av = a[k];
    const bv = b[k];
    if (av === undefined || bv === undefined) return false;
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return false;
    }
  }
  return true;
}

// Suppress unused-import diagnostic: `Milestone` is referenced via the
// `ArchiveContent` discriminated union and indirectly via parser types.
type _MilestoneAlias = Milestone;
void (null as _MilestoneAlias | null);
