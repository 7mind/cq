import { describe } from "bun:test";

import { createInMemoryWorkCohortStore } from "../src/workCohortStore.js";
import { workCohortStoreContract } from "./workCohortStoreContract.js";
import { workCohortAuthorityContract } from "./workCohortAuthorityContract.js";

describe("work cohort strict store contract", () => {
  const fixture = async () => ({
    store: createInMemoryWorkCohortStore(),
    close: async () => undefined,
  });
  workCohortStoreContract("manual in-memory dummy", fixture);
  workCohortAuthorityContract("memory [Behavioral-Active Blackbox-Atomic]", fixture);
});
