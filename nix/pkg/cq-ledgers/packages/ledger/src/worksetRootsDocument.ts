import { WorksetAdmissionError, type WorksetRootsEpoch } from "./worksetEffectAdmission.js";

const WORKSET_ROOTS_SCHEMA_VERSION = 1 as const;

export interface WorksetRootsDocument {
  readonly version: typeof WORKSET_ROOTS_SCHEMA_VERSION;
  readonly roots: readonly string[];
  readonly epoch: number;
}

/**
 * Parse a complete roots/epoch document. Rejects torn or partial payloads so a
 * visible blob always denotes one complete batch.
 */
export function parseWorksetRootsDocument(text: string): WorksetRootsEpoch {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      "workset-roots.json is not valid JSON",
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      "workset-roots.json must be a JSON object",
    );
  }
  const doc = raw as Record<string, unknown>;
  if (doc["version"] !== WORKSET_ROOTS_SCHEMA_VERSION) {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      `unsupported workset-roots.json version: ${String(doc["version"])}`,
    );
  }
  if (!Number.isInteger(doc["epoch"]) || (doc["epoch"] as number) < 0) {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      `workset-roots.json epoch must be a non-negative integer, got ${String(doc["epoch"])}`,
    );
  }
  if (!Array.isArray(doc["roots"])) {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      "workset-roots.json roots must be an array",
    );
  }
  const roots: string[] = [];
  for (const member of doc["roots"] as unknown[]) {
    if (typeof member !== "string" || member.length === 0) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "workset-roots.json roots members must be non-empty strings",
      );
    }
    roots.push(member);
  }
  return { roots, epoch: doc["epoch"] as number };
}

export function serializeWorksetRootsDocument(snap: WorksetRootsEpoch): string {
  const doc: WorksetRootsDocument = {
    version: WORKSET_ROOTS_SCHEMA_VERSION,
    roots: snap.roots.slice(),
    epoch: snap.epoch,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
