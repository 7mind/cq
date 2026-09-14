import { materializeOperatorAction, SqliteLedgerStore } from "../src/index.js";
import type { MaterializeOperatorActionInput } from "../src/operatorActions.js";

const [dbPath, encodedInput, now] = process.argv.slice(2);
if (dbPath === undefined || encodedInput === undefined || now === undefined) throw new Error("missing direct lifecycle peer arguments");
const input = JSON.parse(encodedInput) as MaterializeOperatorActionInput;
const store = new SqliteLedgerStore({ dbPath, now: () => now });
await store.init();
try {
  console.log("ready");
  if (await Bun.stdin.text() !== "start\n") throw new Error("unexpected direct lifecycle peer command");
  try {
    await materializeOperatorAction(store, input);
    console.log(JSON.stringify({ state: "materialized" }));
  } catch (error) {
    console.log(JSON.stringify({ state: "rejected", message: error instanceof Error ? error.message : String(error) }));
  }
} finally { await store.dispose(); }
