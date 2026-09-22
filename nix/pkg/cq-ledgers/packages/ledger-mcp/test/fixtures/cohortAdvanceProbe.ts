import { readCohortAdvanceStatusV1 } from "@cq/ledger";
import { completionRuntimeFixture } from "../workCohortCompletionRuntimeFixture.js";

const adapter = process.argv[2];
if (adapter !== "memory" && adapter !== "sqlite") throw new Error("cohort probe requires memory or sqlite");
const fixture = await completionRuntimeFixture(adapter, false);
try {
  const completed = await fixture.complete();
  const replay = await fixture.complete();
  const state = await readCohortAdvanceStatusV1(fixture.cohorts);
  console.log(JSON.stringify({
    state: completed.state,
    identicalReplay: JSON.stringify(completed) === JSON.stringify(replay),
    members: state.definitions[0]?.memberRefs,
    commands: fixture.commands,
    counters: state.counters,
    handoff: completed.state === "complete" ? {
      phase: completed.handoff.phase,
      archivedRefs: completed.handoff.ledgerResult?.archivedRefs,
    } : null,
    goalStatus: fixture.ledger.fetchItem("goals", "G1").status,
    unrelatedTaskStatus: fixture.ledger.fetchItem("tasks", "T900").status,
  }));
} finally { await fixture.close(); }
