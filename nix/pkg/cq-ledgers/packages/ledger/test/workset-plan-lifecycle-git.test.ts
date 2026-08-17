import { setDefaultTimeout } from "bun:test";
import { GIT_OBJECT_CONTRACT_TIMEOUT_MS } from "./durableContractTimeouts.js";
import { registerWorksetPlanLifecycleContract } from "./worksetPlanLifecycleContract.js";
import { gitPlanLifecycleFactory } from "./worksetPlanLifecycleDurableFactories.js";

setDefaultTimeout(GIT_OBJECT_CONTRACT_TIMEOUT_MS);
registerWorksetPlanLifecycleContract(gitPlanLifecycleFactory);
