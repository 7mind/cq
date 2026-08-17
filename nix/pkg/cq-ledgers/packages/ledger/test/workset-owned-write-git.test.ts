import { setDefaultTimeout } from "bun:test";
import { GIT_OBJECT_CONTRACT_TIMEOUT_MS } from "./durableContractTimeouts.js";
import { runWorksetOwnedWriteContract } from "./worksetOwnedWriteContract.js";
import { gitOwnedWriteFactory } from "./worksetOwnedWriteDurableFactories.js";

setDefaultTimeout(GIT_OBJECT_CONTRACT_TIMEOUT_MS);
runWorksetOwnedWriteContract(gitOwnedWriteFactory);
