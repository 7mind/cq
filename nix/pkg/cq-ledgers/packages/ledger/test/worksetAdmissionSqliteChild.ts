/**
 * Child helper for workset-effect-admission-sqlite cross-process test.
 *
 * Usage: bun worksetAdmissionSqliteChild.ts <dbPath>
 * Protocol: prints ADMITTED\\n after holding an external-effect admission,
 * then waits for RELEASE\\n on stdin, settles, releases, exits 0.
 */

import { SqliteLedgerStore } from "../src/index.js";

const dbPath = process.argv[2];
if (dbPath === undefined || dbPath.length === 0) {
  process.stderr.write("usage: worksetAdmissionSqliteChild.ts <dbPath>\n");
  process.exit(2);
}

const store = new SqliteLedgerStore({ dbPath });
await store.init();
const admission = await store.worksetStore().admitExternalEffect({
  kind: "merge",
  targetRef: "tasks:T-child",
});
admission.registerProcessGroup({ pgid: process.pid, leaderPid: process.pid });
process.stdout.write("ADMITTED\n");

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  if (buf.includes("RELEASE")) break;
}

admission.markSettled();
await admission.releaseAfterSettlement();
await store.dispose();
process.exit(0);
