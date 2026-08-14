/** T1982: required empty-root parity and both generic-mutation/set orderings. */

import { createInMemoryWorksetManagementLedger } from "../src/index.js";
import { runWorksetGenericMutationContract } from "./worksetGenericMutationContract.js";

runWorksetGenericMutationContract({
  name: "T1982 in-memory adapter boundary",
  classification: "Behavioral-Active Blackbox-Atomic",
  build: (options) => createInMemoryWorksetManagementLedger(options),
});
