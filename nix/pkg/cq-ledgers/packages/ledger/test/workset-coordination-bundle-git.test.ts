import { setDefaultTimeout } from "bun:test";
import { GIT_OBJECT_CONTRACT_TIMEOUT_MS } from "./durableContractTimeouts.js";
import { runWorksetCoordinationBundleContract } from "./worksetCoordinationBundleContract.js";
import { gitOwnedWriteFactory } from "./worksetOwnedWriteDurableFactories.js";

setDefaultTimeout(GIT_OBJECT_CONTRACT_TIMEOUT_MS);
runWorksetCoordinationBundleContract(gitOwnedWriteFactory);
