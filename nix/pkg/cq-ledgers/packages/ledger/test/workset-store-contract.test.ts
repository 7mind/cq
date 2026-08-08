/**
 * T1954 — shared WorksetStore Blackbox contract, always against the dummy.
 *
 * Future backend legs (fs/git/sqlite/postgres) add their factory in a sibling
 * test file and call {@link runWorksetStoreContract} unchanged.
 */

import { createInMemoryWorksetStore } from "../src/index.js";
import {
  runWorksetStoreContract,
  type WorksetStoreContractFactory,
} from "./worksetStoreContract.js";

const inMemoryWorksetStoreFactory: WorksetStoreContractFactory = {
  name: "strict hand-written in-memory dummy",
  classification: "Behavioral-Active Blackbox-Atomic",
  build(options) {
    return createInMemoryWorksetStore(options);
  },
};

runWorksetStoreContract(inMemoryWorksetStoreFactory);
