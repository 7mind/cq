import { recordProtectedImplementationAdoption } from "../src/index.js";
import { publishAdoptionTask } from "./implementationAdoptionTestSupport.js";
import { postgresLifecycleBoundsFixture } from "./postgresLifecycleBoundsMeasurement.js";

export async function postgresAdoptionBounds(size: number) {
  const fixture = await postgresLifecycleBoundsFixture(size);
  try {
    const { authority, record } = await publishAdoptionTask(fixture.store);
    await fixture.warm();
    await fixture.capture("adoption-stale-task-refusal", () => recordProtectedImplementationAdoption(
      fixture.store, authority, { ...record, expectedTaskUpdatedAt: "2000-01-01T00:00:00.000Z" },
    ), /task revision changed/);
    const recordAndRead = async () => {
      await recordProtectedImplementationAdoption(fixture.store, authority, record);
      return fixture.store.fetchItem("tasks", "T1");
    };
    await fixture.capture("adoption-record", recordAndRead, null);
    await fixture.capture("adoption-replay", recordAndRead, null);
    await fixture.restart();
    await fixture.capture("adoption-restart-replay", recordAndRead, null);
    return { observations: fixture.observations, diagnostics: fixture.diagnostics };
  } finally { await fixture.dispose(); }
}
