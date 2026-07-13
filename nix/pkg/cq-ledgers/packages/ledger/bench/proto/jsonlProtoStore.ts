/**
 * JsonlProtoStore — candidate C1/C2 (JSONL canonical + derived index)
 * milestone-A prototype (T492).
 *
 * THROWAWAY. The canonical, human-readable source of truth is an append-only
 * JSONL log at `<root>/.cq/tasks.jsonl`: one JSON record per line, LAST record
 * per `id` wins (log-structured). A single-item mutation is a bounded APPEND of
 * one line — O(1), not the O(n) whole-file rewrite the fs/git backends pay
 * (T490 §4). Cold `init()` streams the JSONL once and folds it into an
 * in-memory `Map<id, ProtoItem>` derived index (rebuildable, never
 * authoritative) — an O(records) parse, not the whole-ledger markdown reparse.
 *
 * Multi-process (Q246): appends are serialized with the repo's advisory
 * `Lockfile` (the same one FsLedgerStore uses). O_APPEND gives per-write
 * atomicity, but a full JSON line can exceed PIPE_BUF, so the lock guarantees
 * no interleaved/torn lines across processes. This is exactly the locking
 * signal the T497 contract needs: the canonical log needs a per-store write
 * lock; the derived index is per-process and needs none.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Lockfile } from "../../src/store/lockfile.js";
import type { ProtoItem, ProtoStore } from "./protoStore.js";

const TASKS_JSONL = "tasks.jsonl";
const LOCKS_DIR = ".locks";
const LOCK_ID = "tasks";

export interface JsonlProtoStoreOpts {
  root: string;
}

function jsonlPath(root: string): string {
  return path.join(root, ".cq", TASKS_JSONL);
}

/**
 * Fold an append-only JSONL log into the last-writer-wins item map. Tolerates a
 * torn final line (a crash mid-append) by discarding an unparseable last
 * record — the append-only recovery step the survey (§4.3) calls for.
 */
export function foldJsonl(text: string): Map<string, ProtoItem> {
  const items = new Map<string, ProtoItem>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    try {
      const rec = JSON.parse(line) as ProtoItem;
      items.set(rec.id, rec);
    } catch (err) {
      // Only the LAST line may be legitimately torn (interrupted append);
      // an unparseable interior line is real corruption — fail fast.
      if (i === lines.length - 1) continue;
      throw new Error(`JsonlProtoStore: corrupt JSONL at line ${i + 1}: ${String(err)}`);
    }
  }
  return items;
}

export class JsonlProtoStore implements ProtoStore {
  private readonly root: string;
  private readonly lock = new Lockfile();
  /** Derived, rebuildable index — never the source of truth. */
  private index = new Map<string, ProtoItem>();
  private milestoneCounter = 0;
  private ready = false;

  constructor(opts: JsonlProtoStoreOpts) {
    this.root = opts.root;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.root, ".cq"), { recursive: true });
    // Cold-init cost under measurement: stream the canonical JSONL once and
    // rebuild the derived index (O(records), not a whole-ledger markdown parse).
    let text = "";
    try {
      text = await fs.readFile(jsonlPath(this.root), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.index = foldJsonl(text);
    this.ready = true;
  }

  private locksDir(): string {
    return path.join(this.root, ".cq", LOCKS_DIR);
  }

  async createMilestone(title: string): Promise<{ id: string }> {
    if (!this.ready) throw new Error("JsonlProtoStore: init() not called");
    // Registry insert kept O(1); milestones live in the index namespace only
    // for the bench (the workload seeds items under this id).
    const id = `M${++this.milestoneCounter}`;
    void title;
    return { id };
  }

  async updateItem(itemId: string, status: string): Promise<void> {
    if (!this.ready) throw new Error("JsonlProtoStore: init() not called");
    const current = this.index.get(itemId);
    if (current === undefined) throw new Error(`JsonlProtoStore: item ${itemId} not found`);
    const next: ProtoItem = { ...current, status, updatedAt: new Date().toISOString() };
    // The single-item mutation under measurement: append ONE record line under
    // the per-store write lock (multi-process safe), then update the derived
    // index. Bounded append, not a whole-file rewrite.
    const release = await this.lock.acquire(this.locksDir(), LOCK_ID);
    try {
      await fs.appendFile(jsonlPath(this.root), JSON.stringify(next) + "\n", "utf8");
    } finally {
      await release();
    }
    this.index.set(itemId, next);
  }

  async dispose(): Promise<void> {
    this.index.clear();
    this.ready = false;
  }
}

/**
 * Read back every item's status as an `id -> status` map (verification helper
 * for the two-writer smoke; re-folds the canonical JSONL from disk).
 */
export async function readJsonlStatuses(root: string): Promise<Map<string, string>> {
  const text = await fs.readFile(jsonlPath(root), "utf8");
  const items = foldJsonl(text);
  return new Map([...items].map(([id, it]) => [id, it.status]));
}

/**
 * Direct-seed the canonical JSONL with the synthetic population by writing the
 * whole file ONCE (bulk load), bypassing the per-mutation append funnel — the
 * hybrid equivalent of the fs driver writing tasks.md once (bench module doc).
 * Returns the seeded item ids.
 */
export async function seedJsonlItems(
  root: string,
  milestoneId: string,
  size: number,
): Promise<string[]> {
  await fs.mkdir(path.join(root, ".cq"), { recursive: true });
  const now = new Date().toISOString();
  const ids: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i < size; i++) {
    const item: ProtoItem = {
      id: `T${i + 1}`,
      milestoneId,
      status: "planned",
      fields: {
        headline: `synthetic task ${i}`,
        description: `Q248 bench workload item ${i} of ${size}.`,
      },
      createdAt: now,
      updatedAt: now,
    };
    lines.push(JSON.stringify(item));
    ids.push(item.id);
  }
  await fs.writeFile(jsonlPath(root), lines.join("\n") + "\n", "utf8");
  return ids;
}
