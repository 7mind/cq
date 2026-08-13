import { registerWorksetPlanLifecycleContract } from "./worksetPlanLifecycleContract.js";
import { gitPlanLifecycleFactory } from "./worksetPlanLifecycleDurableFactories.js";

registerWorksetPlanLifecycleContract(gitPlanLifecycleFactory);
