/**
 * Packaging smoke test for the `@cq/ledger/finalize` subpath: T614 added
 * this file to prove the subpath resolves DIST-INDEPENDENTLY from a
 * consuming package (like the D106 coverage guard in
 * `tsconfigPathsCoverage.test.ts`, but exercised via a real import rather
 * than the static tsconfig/exports scan). The full Q288/Q289/R722/Q290
 * predicate matrix plus the T615 executor are unit-tested directly against
 * `@cq/ledger`'s own source in `packages/ledger/test/finalize.test.ts`
 * (T618) — kept here to a minimal proof-of-resolution so the two files
 * don't assert the same behavior twice.
 */

import { describe, it, expect } from "bun:test";
import { buildFinalizeSnapshot, computeApplyDonePlan } from "@cq/ledger/finalize";
import { MILESTONES_LEDGER, MILESTONES_SCHEMA } from "@cq/ledger/constants";
import type { FetchedLedger } from "@cq/ledger";

describe("@cq/ledger/finalize resolves dist-independently from ledger-web", () => {
  it("imports and runs against a trivial empty snapshot", () => {
    const milestones: FetchedLedger = {
      id: MILESTONES_LEDGER,
      schema: MILESTONES_SCHEMA,
      counters: { milestone: 0, item: 0 },
      milestones: [],
      archivePointers: [],
    };
    const snapshot = buildFinalizeSnapshot([milestones]);
    expect(computeApplyDonePlan(snapshot)).toEqual({ affected: [], skipped: [] });
  });
});
