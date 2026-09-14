import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { directCompletionRecord } from "../test/directOwnedLifecycleContract.js";
import type { LifecycleBoundsReport } from "../test/lifecycleBoundsMeasurement.js";
import { admittedOwnedScalingFixture, directOwnedScalingFixture, guardedScalingFixture, lifecycleScalingFixture, operatorScalingFixture } from "../test/sqliteLifecycleBoundsScenarios.js";
import { releaseAndRefusalBounds, unmaterializedAndUnownedCompletionBounds } from "../test/sqliteLifecycleBoundsControls.js";
import { twoProcessSearchBounds } from "./sqliteLifecycleBoundsProcesses.js";

const LARGE_UNRELATED_ROWS = 20_000;
const LARGE_PRIVATE_RECORDS = 2_000;

interface BoundsScenario {
  readonly name: string;
  run(unrelatedRows: number): Promise<LifecycleBoundsReport>;
}

const completion = await directCompletionRecord();
const scenarios: readonly BoundsScenario[] = [
  { name: "plan", run: (size) => lifecycleScalingFixture(size, size === 0 ? 0 : LARGE_PRIVATE_RECORDS) },
  { name: "operator-action", run: operatorScalingFixture },
  { name: "admitted-owned", run: admittedOwnedScalingFixture },
  { name: "direct-owned", run: (size) => directOwnedScalingFixture(size, completion) },
  { name: "guarded-plan", run: guardedScalingFixture },
  { name: "release-and-refusal", run: releaseAndRefusalBounds },
  { name: "unmaterialized-and-no-defect-completion", run: (size) => unmaterializedAndUnownedCompletionBounds(size, completion) },
];

let operations = 0;
for (const scenario of scenarios) {
  const small = await scenario.run(0);
  const large = await scenario.run(LARGE_UNRELATED_ROWS);
  assert(small.observations.length > 0, `${scenario.name} ran no measured operations`);
  assert.deepEqual(large.observations, small.observations, `${scenario.name} work depends on unrelated fixture size`);
  assert.equal(small.diagnostics.length, small.observations.length);
  assert.equal(large.diagnostics.length, large.observations.length);
  operations += small.observations.length;
  for (const [index, observation] of small.observations.entries()) {
    console.log(JSON.stringify({ scenario: scenario.name, operation: index, committed: observation.committed, resultHash: observation.resultHash,
      accessKeysHash: createHash("sha256").update(JSON.stringify(observation.accesses)).digest("hex"),
      coherence: observation.coherence, projectedDocuments: observation.projectedDocuments, versionIncrement: observation.versionIncrement,
      small: small.diagnostics[index], large: large.diagnostics[index] }));
  }
}
const smallPeer = await twoProcessSearchBounds(0);
const largePeer = await twoProcessSearchBounds(LARGE_UNRELATED_ROWS);
assert.deepEqual(largePeer.report.observations, smallPeer.report.observations);
assert.deepEqual(largePeer.peerObservation, smallPeer.peerObservation);
console.log(JSON.stringify({ scenario: "two-process-search", observation: smallPeer.peerObservation,
  small: { writer: smallPeer.report.diagnostics, peerSearchMs: smallPeer.peerSearchMs },
  large: { writer: largePeer.report.diagnostics, peerSearchMs: largePeer.peerSearchMs } }));
console.log(JSON.stringify({ status: "pass", classification: "Performance-Effectual Blackbox-GoodCommunication",
  scenarios: scenarios.length + 1, operations: operations + smallPeer.report.observations.length, activeUnrelated: LARGE_UNRELATED_ROWS, archivedUnrelated: LARGE_UNRELATED_ROWS,
  unrelatedClaims: LARGE_PRIVATE_RECORDS, unrelatedOperations: LARGE_PRIVATE_RECORDS }));
