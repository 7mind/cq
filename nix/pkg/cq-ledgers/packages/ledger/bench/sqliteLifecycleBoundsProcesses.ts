import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { coherenceVersion } from "../src/store/sqlite/connection.js";
import type { SqliteCoherenceChange } from "../src/store/sqlite/coherenceVector.js";
import { LifecycleBoundsMeasurement, type LifecycleProjectionEffect } from "../test/lifecycleBoundsMeasurement.js";
import { seedUnrelatedOwnedRows } from "../test/ownedLifecycleSqliteFixtures.js";
import { LIFECYCLE_CLAIM_INPUT, sqlitePlanLifecycleFixture } from "../test/sqlitePlanLifecycleFixture.js";

const PEER_DEADLINE_MS = 45_000;

interface PeerResult {
  readonly elapsedMs: number;
  readonly hits: readonly { readonly ledgerId: string; readonly id: string; readonly status: string }[];
  readonly coherence: readonly SqliteCoherenceChange[];
  readonly projectionEffects: readonly LifecycleProjectionEffect[];
}

export async function twoProcessSearchBounds(unrelatedRows: number) {
  const fixture = await sqlitePlanLifecycleFixture();
  seedUnrelatedOwnedRows(fixture.db, unrelatedRows);
  const peer = spawn(process.execPath, [fileURLToPath(new URL("./sqliteLifecycleBoundsPeer.ts", import.meta.url)), fixture.db.filename],
    { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: peer.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = "";
  peer.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => { peer.once("error", reject); peer.once("close", resolve); });
  const deadline = setTimeout(() => peer.kill("SIGKILL"), PEER_DEADLINE_MS);
  try {
    assert.equal((await iterator.next()).value, "ready");
    const before = coherenceVersion(fixture.db);
    const measurement = new LifecycleBoundsMeasurement(fixture);
    measurement.start();
    const claimed = await fixture.store.claimPlan(LIFECYCLE_CLAIM_INPUT);
    assert(claimed.ok);
    measurement.finish(claimed);
    peer.stdin.end(JSON.stringify({ afterVersion: before }));
    const value = (await iterator.next()).value;
    assert(typeof value === "string", "peer omitted its convergence report");
    const result = JSON.parse(value) as PeerResult;
    assert.equal(await exited, 0, stderr);
    const report = measurement.report();
    assert.deepEqual(result.hits, [{ ledgerId: "goals", id: "G1", status: "planning" }]);
    assert.deepEqual(result.coherence, report.observations[0]!.coherence);
    assert(result.projectionEffects.every(({ kind }) => kind === "document"), "peer rebuilt unrelated search data");
    assert.deepEqual(result.projectionEffects.flatMap(({ keys }) => keys), ["goals:G1"]);
    const { elapsedMs, ...observation } = result;
    return { report, peerObservation: observation, peerSearchMs: elapsedMs };
  } finally {
    clearTimeout(deadline);
    lines.close();
    if (peer.exitCode === null) peer.kill("SIGKILL");
    await exited;
    await fixture.dispose();
  }
}
