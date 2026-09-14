import { directCompletionRecord } from "../test/directOwnedLifecycleContract.js";
import { postgresAdoptionBounds } from "../test/postgresAdoptionBounds.js";
import { postgresPlanBounds, postgresOperatorBounds, postgresOwnedBounds, postgresDirectBounds, postgresGenericBounds } from "../test/postgresLifecycleBoundsScenarios.js";
import { postgresIndependentProgressBounds, postgresReleaseBounds } from "../test/postgresLifecycleBoundsControls.js";
import { strict as assert } from "node:assert";
import { assertPostgresLifecycleBounds, type PostgresLifecycleBoundsReport } from "../test/postgresLifecycleBoundsAssertions.js";
import type { PostgresCaseEvidence } from "./postgresRequiredEvidence.js";

const SMALL_UNRELATED_ROWS = 2_000;
const LARGE_UNRELATED_ROWS = 20_000;

export async function runPostgresLifecycleBoundsGate(emit: (record: unknown) => void): Promise<PostgresCaseEvidence> {
  const completion = await directCompletionRecord();
  const scenarios: readonly { name: string; run(size: number): Promise<PostgresLifecycleBoundsReport> }[] = [
    { name: "native-plan", run: (size) => postgresPlanBounds(size, false) },
    { name: "guarded-plan", run: (size) => postgresPlanBounds(size, true) },
    { name: "operator-actions", run: postgresOperatorBounds },
    { name: "owned-intake", run: postgresOwnedBounds },
    { name: "direct-owned", run: (size) => postgresDirectBounds(size, completion) },
    { name: "operator-adoption", run: postgresAdoptionBounds },
    { name: "generic-and-archive", run: postgresGenericBounds },
    { name: "release-rollback-refusal", run: postgresReleaseBounds },
  ];
  let operations = 0;
  for (const scenario of scenarios) {
    const small = await scenario.run(SMALL_UNRELATED_ROWS);
    const large = await scenario.run(LARGE_UNRELATED_ROWS);
    assertPostgresLifecycleBounds(small, large);
    for (const [index, observation] of small.observations.entries()) emit({ scenario: scenario.name, observation,
      small: small.diagnostics[index], large: large.diagnostics[index] });
    operations += small.observations.length;
  }
  const smallProgress = await postgresIndependentProgressBounds(SMALL_UNRELATED_ROWS);
  const largeProgress = await postgresIndependentProgressBounds(LARGE_UNRELATED_ROWS);
  assert.deepEqual(largeProgress, smallProgress);
  emit({ scenario: "independent-progress", result: smallProgress });
  operations += 2;
  const evidence = { cases: operations, postgresCases: operations, postgresSkipped: 0 };
  emit({ status: "pass", classification: "Performance-Effectual Blackbox-GoodCommunication", scenarios: scenarios.length + 1,
    smallUnrelated: SMALL_UNRELATED_ROWS, activeUnrelated: LARGE_UNRELATED_ROWS, archivedUnrelated: LARGE_UNRELATED_ROWS,
    unrelatedClaims: 2_000, unrelatedOperations: 2_000, ...evidence });
  return evidence;
}
