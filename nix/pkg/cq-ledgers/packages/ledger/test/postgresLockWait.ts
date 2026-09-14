import type { SQL } from "bun";

export async function waitForPostgresLock(pool: SQL, applicationName: string, timeoutMs: number): Promise<void> {
  const pollIntervalMs = 5;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const rows = await pool`SELECT pid FROM pg_stat_activity WHERE application_name = ${applicationName} AND wait_event_type = 'Lock'`;
    if (rows.length > 0) return;
    if (performance.now() >= deadline) throw new Error("contender did not reach the PostgreSQL lock wait");
    await Bun.sleep(pollIntervalMs);
  }
}
