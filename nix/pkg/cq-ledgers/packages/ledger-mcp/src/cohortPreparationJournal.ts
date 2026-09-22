import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { assertCohortEffectEnvelopeV1, cohortValueDigestV1 as digest,
  type CohortEffectEnvelopeV1, type ManagedCohortWorktreeAuthority, type WorkCohortStore } from "@cq/ledger";

const leaseSchema = z.object({ holderId: z.string().min(1), semanticSubject: z.string().min(1),
  executionEpoch: z.string().min(1), capability: z.string().min(1) }).strict();
const journalSchema = z.object({ version: z.literal(1), envelope: z.unknown(), lease: leaseSchema }).strict();

export function publishPrivateCohortJournalV1(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${randomUUID()}.pending`;
  const descriptor = openSync(staged, "wx", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(staged, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Private preparation lease publication precedes the primary transaction commit. */
export async function resolvePreparationAuthority(input: {
  readonly store: WorkCohortStore;
  readonly envelope: CohortEffectEnvelopeV1;
  readonly holderId: string;
  readonly registryRoot: string;
}): Promise<ManagedCohortWorktreeAuthority> {
  assertCohortEffectEnvelopeV1(input.envelope);
  const path = join(input.registryRoot, "cohort-preparations", `${input.envelope.intent.intentDigest}.json`);
  const state = await input.store.snapshot();
  if (state.runtime.lease !== null) {
    const journal = journalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const envelope = journal.envelope as CohortEffectEnvelopeV1;
    assertCohortEffectEnvelopeV1(envelope);
    if (digest(envelope) !== digest(input.envelope) || journal.lease.holderId !== input.holderId) {
      throw new Error("cohort preparation journal differs from the requested authority; explicit resume is required");
    }
    await input.store.assertLiveCohortAuthority(journal.lease, input.envelope);
    return { store: input.store, envelope: input.envelope, lease: journal.lease };
  }
  const lease = await input.store.acquireLeaseAndPublish({ holderId: input.holderId, semanticSubject: input.envelope.semanticSubject }, (fresh) => {
    publishPrivateCohortJournalV1(path, { version: 1, envelope: input.envelope, lease: fresh });
  });
  return { store: input.store, envelope: input.envelope, lease };
}
