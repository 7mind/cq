/**
 * protoStore — the narrow store surface the T490 bench workload exercises.
 *
 * THROWAWAY research artifact (G67-A / T492). Both milestone-A prototypes
 * (`SqliteProtoStore`, `JsonlProtoStore`) implement ONLY this surface — enough
 * to run the identical benchmark workload the fs/git-object drivers do
 * (registry + one `tasks` ledger + single-item mutations + cold load). This is
 * deliberately NOT the full `LedgerStore` interface: prototypes exist to
 * measure the two Q248 numbers (p95 single-item mutation, cold `init()`), not
 * to ship. No production wiring; nothing under src/ imports this.
 */

/** Minimal item shape the prototypes persist (a subset of the real `Item`). */
export interface ProtoItem {
  id: string;
  milestoneId: string;
  status: string;
  /** Free-form fields serialized as one JSON blob (headline/description/…). */
  fields: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/**
 * The four operations the T490 bench calls on a store instance:
 *  - `init()`            — cold load of already-persisted state (measured);
 *  - `createMilestone()` — cheap O(1) registry insert (returns its id);
 *  - `updateItem()`      — the single-item mutation under measurement;
 *  - `dispose()`         — release in-process resources (db handle / buffers).
 *
 * Structurally a subset of `LedgerStore`, so the real fs/git-object stores
 * satisfy it too (used by the bench's `BenchStore` alias).
 */
export interface ProtoStore {
  init(): Promise<void>;
  createMilestone(title: string): Promise<{ id: string }>;
  updateItem(itemId: string, status: string): Promise<void>;
  dispose(): Promise<void>;
}
