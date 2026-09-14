import { runPostgresLifecycleBoundsGate } from "./postgresLifecycleBoundsGate.js";

const reportPath = process.env.CQ_TEST_PG_REPORT_JSON;
if (process.env.CQ_TEST_REQUIRE_PG !== "1" || !process.env.CQ_TEST_PG_URL || !reportPath) {
  throw new Error("run check:postgres-lifecycle-bounds through check:postgres-required with one live DSN");
}
const report = await runPostgresLifecycleBoundsGate((record) => console.log(JSON.stringify(record)));
await Bun.write(reportPath, JSON.stringify(report));
